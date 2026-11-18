// Writes a copy of a POV demo with the players of the fill in its packet entities, so the game draws them. The
// original buffer never changes. Every other frame and message of the demo stays as it was.

import { FrameType, directoryOf, frames, readHeader } from '../goldsrc/frames.js';
import { BitReader, Reader } from '../goldsrc/bits.js';
import { readDelta } from '../goldsrc/delta.js';
import { DemoState, SVC, readBlock, withWeaponBits } from '../goldsrc/messages.js';
import { ESTIMATE } from '../shared/estimates.js';
import { weaponKey } from '../shared/weapons.js';
import { setBits } from './bits.js';
import { writePacketEntities } from './entities.js';

const HEADER_BYTES = 544;
// Frame head (9) and demo info with the sequence numbers (464) before the length of a network block.
const NETWORK_HEAD = 9 + 464;
const DIRECTORY_ENTRY = 92;
// The client keeps this many entities of one frame (MAX_PACKET_ENTITIES): a frame that would hold more gets no
// estimated player.
const MAX_PACKET_ENTITIES = 256;
// Seconds between two estimated samples of a player across which a frame between them takes the line.
const MAX_SPAN = 0.3;
// Seconds from an estimated sample in which a frame with no sample on its other side still takes it.
const NEAR = 0.02;
// MOVETYPE_WALK and SOLID_SLIDEBOX of a living player.
const MOVETYPE_WALK = 3;
const SOLID_SLIDEBOX = 3;
// The fields of a player's entity that an estimated player keeps from the last state that the demo held of it.
const KEPT = ['modelindex', 'colormap', 'skin', 'framerate', 'friction', 'gravity', 'frame', 'animtime', 'scale',
  'rendermode', 'renderamt', 'renderfx', 'rendercolor.r', 'rendercolor.g', 'rendercolor.b',
  'controller[0]', 'controller[1]', 'controller[2]', 'controller[3]', 'blending[0]', 'blending[1]'];
// The fields that an estimated player sends in each frame.
const ANIMATED = ['animtime'];
// The text that a filled demo prints in the console at the start of its playback.
export const NOTICE = 'This demo holds estimated players (cs16-pov-hltv-fill): a player that the recorder could not see is a guess, not a record.\n';

/** The estimated places of each player of a filled timeline: Map of entity to [[t, x, y, z, yaw, flags]] by time. */
export function estimatedTracks(filled) {
  const tracks = new Map();
  for (const row of filled.samples) {
    for (let i = 1; i < row.length; i += 6) {
      if (!(row[i + 5] & ESTIMATE)) continue;
      const entity = row[i];
      if (!tracks.has(entity)) tracks.set(entity, []);
      tracks.get(entity).push([row[0], row[i + 1], row[i + 2], row[i + 3], row[i + 4], row[i + 5]]);
    }
  }
  return tracks;
}

function byEntity(rows) {
  const out = new Map();
  for (const row of rows ?? []) {
    if (!out.has(row[1])) out.set(row[1], []);
    out.get(row[1]).push(row);
  }
  return out;
}

/** The last row of a list sorted by time whose time is not after `t`. */
function lastAt(rows, t) {
  if (!rows?.length || rows[0][0] > t) return null;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return rows[lo];
}

/** The place of an estimated track at a time: the line between its samples around `t`, or null. */
export function placeAt(track, t) {
  let lo = 0;
  let hi = track.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  const b = track[lo];
  const a = track[lo - 1];
  if (!(a && b && b[0] - a[0] <= MAX_SPAN)) {
    if (b && b[0] - t <= NEAR) return b;
    return a && t - a[0] <= NEAR ? a : null;
  }
  const f = (t - a[0]) / (b[0] - a[0]);
  const turn = ((((b[4] - a[4]) % 3600) + 5400) % 3600) - 1800;
  return [t, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f, a[4] + turn * f, a[5]];
}

/**
 * The entity states of the estimated players at each time of a part: a function (time, the entities of the frame,
 * the decoder's state, the last states that the demo held of each player) -> Map of entity to state.
 */
function estimatedPlayers(filled) {
  const tracks = estimatedTracks(filled);
  const anims = byEntity(filled.anims);
  const loadouts = byEntity(filled.loadouts);
  const kits = byEntity(filled.kits);
  const pModels = new WeakMap();
  const weaponModel = (state, key) => {
    let models = pModels.get(state.models);
    if (!models) {
      models = new Map();
      for (const [index, name] of state.models) if (/^models\/p_/.test(name) && weaponKey(name)) models.set(weaponKey(name), index);
      pModels.set(state.models, models);
    }
    return models.get(key) ?? 0;
  };
  return (t, entities, state, lastSeen) => {
    const out = new Map();
    for (const [entity, track] of tracks) {
      if (entities.has(entity) || entity > state.maxClients) continue;
      const place = placeAt(track, t);
      if (!place) continue;
      const base = state.baselines.get(entity) ?? {};
      const seen = lastSeen.get(entity) ?? {};
      const e = { ...base };
      for (const key of KEPT) if (seen[key] !== undefined) e[key] = seen[key];
      const [, x, y, z, yaw, flags] = place;
      const anim = lastAt(anims.get(entity), t);
      const hand = lastAt(loadouts.get(entity), t);
      const ct = (flags & 4) !== 0;
      Object.assign(e, {
        'origin[0]': x, 'origin[1]': y, 'origin[2]': z,
        'angles[0]': 0, 'angles[1]': ((yaw / 10) % 360 + 360) % 360, 'angles[2]': 0,
        movetype: MOVETYPE_WALK, solid: SOLID_SLIDEBOX, usehull: 0, effects: 0, spectator: 0, owner: 0, aiment: 0,
        sequence: anim?.[2] ?? seen.sequence ?? 0, gaitsequence: anim?.[3] ?? seen.gaitsequence ?? 0,
        weaponmodel: hand?.[2] ? weaponModel(state, hand[2]) : (seen.weaponmodel ?? 0),
        // Body 1: a CT's defuse kit, a T's bomb on the back.
        body: ct ? (lastAt(kits.get(entity), t)?.[2] ?? 0) : (flags & 2 ? 1 : 0),
      });
      out.set(entity, e);
    }
    return out;
  };
}

/** The bit places of the packet indexes of a svc_event message whose body starts at byte `at`. */
function eventIndexes(block, at, state) {
  const br = new BitReader(new Reader(block, at));
  const count = br.read(5);
  const out = [];
  for (let i = 0; i < count; i++) {
    br.read(10);
    if (br.bit()) {
      out.push({ pos: br.pos, index: br.read(11) });
      if (br.bit()) readDelta(br, state.deltas.get('event_t'));
    }
    if (br.bit()) br.read(16);
  }
  return out;
}

const sorted = (map) => [...map.keys()].sort((a, b) => a - b);

/**
 * A copy of the demo `buf` with the estimated players of `filled` (the filled timeline of this demo, or of the match
 * that it is part `part` of) in its packet entities. `frameTimes` is the [frame offset, time] list that
 * buildTimeline() gave for this demo; `offset` is the start of this part on the clock of `filled`.
 * Returns {demo, frames, added}: the new bytes, the network frames that got a player, and the player states added.
 */
export function writeFilledDemo(buf, filled, { frameTimes, offset = 0 } = {}) {
  return withWeaponBits((weaponBits) => writeOnce(buf, filled, { frameTimes, offset, weaponBits }));
}

function writeOnce(buf, filled, { frameTimes, offset, weaponBits }) {
  const header = readHeader(buf);
  const state = new DemoState(header.netProtocol, { weaponBits });
  const timeOf = new Map(frameTimes ?? []);
  const playersAt = filled ? estimatedPlayers(filled) : () => new Map();
  const lastSeen = new Map();
  // The client's entities in the copy: by sequence, as the decoder keeps the original ones.
  let history = new Map();
  let current = new Map();
  current.customs = new Set();
  const chunks = [buf.subarray(0, HEADER_BYTES)];
  let size = HEADER_BYTES;
  const moved = new Map();
  const put = (bytes) => {
    chunks.push(bytes);
    size += bytes.length;
  };
  let noticed = !filled;
  let changedFrames = 0;
  let added = 0;
  const end = {};

  for (const frame of frames(buf, header, end)) {
    moved.set(frame.offset, size);
    if (!frame.view) {
      put(buf.subarray(frame.offset, frame.next));
      continue;
    }
    const block = frame.data;
    const edits = [];
    const t = (timeOf.get(frame.offset) ?? frame.time) + offset;
    let gotPlayers = false;
    state.sequence = frame.sequence;
    readBlock(block, state, {
      message(id, start, stop, st) {
        if (id === SVC.SERVERINFO) {
          history = new Map();
          current = new Map();
          current.customs = new Set();
        } else if (id === SVC.PACKETENTITIES || id === SVC.DELTAPACKETENTITIES) {
          const delta = id === SVC.DELTAPACKETENTITIES;
          const fromSequence = delta ? block[start + 3] : 0;
          const original = st.entities;
          for (const [number, e] of original) if (number >= 1 && number <= st.maxClients) lastSeen.set(number, e);
          const to = new Map(original);
          to.customs = new Set(original.customs);
          const sent = new Map(original.sent);
          if (frame.type === FrameType.NETWORK) {
            const extra = playersAt(t, original, st, lastSeen);
            if (original.size + extra.size <= MAX_PACKET_ENTITIES) {
              for (const [number, e] of extra) {
                to.set(number, e);
                // The server sends a living player's time window in each frame: its animation runs from now.
                sent.set(number, ANIMATED);
              }
              added += extra.size;
              if (extra.size) gotPlayers = true;
            }
          }
          const sortedTo = new Map([...to].sort((a, b) => a[0] - b[0]));
          sortedTo.customs = to.customs;
          sortedTo.sent = sent;
          const from = delta ? (history.get(fromSequence) ?? current) : null;
          edits.push({ start, stop, bytes: writePacketEntities(st, sortedTo, { from, fromSequence }) });
          history.set(st.sequence & 0xff, sortedTo);
          current = sortedTo;
        } else if (id === SVC.EVENT) {
          // An event names its entity by its place in the frame's packet: the copy's packet holds more entities.
          const before = sorted(st.entities);
          const after = sorted(current);
          let bytes = null;
          for (const { pos, index } of eventIndexes(block, start + 1, st)) {
            const number = before[index];
            const next = number === undefined ? -1 : after.indexOf(number);
            if (next < 0 || next === index) continue;
            bytes ??= Buffer.from(block.subarray(start, stop));
            setBits(bytes, pos - (start * 8), 11, next);
          }
          if (bytes) edits.push({ start, stop, bytes });
        }
      },
    });
    if (gotPlayers) changedFrames++;
    // The console says once, at the start of the playback, that the demo holds estimates.
    if (!noticed && frame.type === FrameType.NETWORK) {
      noticed = true;
      edits.push({ start: block.length, stop: block.length, bytes: Buffer.concat([Buffer.from([SVC.PRINT]), Buffer.from(NOTICE, 'latin1'), Buffer.from([0])]) });
    }
    if (!edits.length) {
      put(buf.subarray(frame.offset, frame.next));
      continue;
    }
    const parts = [];
    let at = 0;
    for (const edit of edits) {
      parts.push(block.subarray(at, edit.start), edit.bytes);
      at = edit.stop;
    }
    parts.push(block.subarray(at));
    const data = Buffer.concat(parts);
    const head = Buffer.from(buf.subarray(frame.offset, frame.offset + NETWORK_HEAD + 4));
    head.writeUInt32LE(data.length, NETWORK_HEAD);
    put(head);
    put(data);
  }

  // What lies after the last whole frame: the directory, or the cut end of an unfinished recording.
  const directory = directoryOf(header, buf);
  moved.set(end.at, size);
  if (directory === null) {
    put(buf.subarray(end.at));
    return { demo: finish(chunks, null), frames: changedFrames, added };
  }
  put(buf.subarray(end.at, directory));
  const newDirectory = size;
  const dir = Buffer.from(buf.subarray(directory));
  const count = dir.length >= 4 ? dir.readInt32LE(0) : 0;
  const shift = (old) => {
    if (moved.has(old)) return moved.get(old);
    // An offset inside a frame keeps its distance to the frame before it.
    let best = HEADER_BYTES;
    for (const key of moved.keys()) if (key <= old && key > best) best = key;
    return (moved.get(best) ?? best) + (old - best);
  };
  for (let i = 0; i < count && 4 + (i + 1) * DIRECTORY_ENTRY <= dir.length; i++) {
    const at = 4 + i * DIRECTORY_ENTRY;
    const start = dir.readInt32LE(at + 84);
    const length = dir.readInt32LE(at + 88);
    const from = shift(start);
    dir.writeInt32LE(from, at + 84);
    dir.writeInt32LE(shift(start + length) - from, at + 88);
  }
  put(dir);
  return { demo: finish(chunks, newDirectory), frames: changedFrames, added };
}

function finish(chunks, directory) {
  const out = Buffer.concat(chunks);
  // The header is the original's: only the place of the directory moves.
  if (directory !== null) out.writeUInt32LE(directory, 540);
  return out;
}
