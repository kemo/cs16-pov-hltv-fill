// Turns a GoldSrc demo into a timeline: player tracks, game events and the camera cues that the demo carries.

import { createHash } from 'node:crypto';
import { FrameType, directoryOf, frames, readHeader } from './goldsrc/frames.js';
import { DemoState, readBlock, withWeaponBits } from './goldsrc/messages.js';
import { WorldTracker } from './world.js';
import { smoothSpikes } from './track.js';
import { SnapshotClock } from './snapshot-clock.js';
import { CHAT_TITLES } from './shared/chat.js';

export const TIMELINE_VERSION = 8;
// One ping per player at most this often.
const PING_SECONDS = 5;
// A step of the frame clock past this is a damaged time unless the next playback frame confirms it. The 11 local
// demos and the 559 built timelines step at most 33 s.
const MAX_STEP = 300;
// Seconds between the end of a playback segment and the start of the next one.
const SEGMENT_GAP = 1;
// Seconds that a timeline runs on after its last row (MARGIN of src/dead-air.js).
const DATA_MARGIN = 1;
// DRC_CMD_EVENT of the HLTV director: primary entity, secondary entity, flags (priority in the low 4 bits).
const DRC_CMD_EVENT = 2;
// A sample's flag for the ducking hull (usehull 1), under the eleven bits of the pitch.
const DUCKING = 1 << 3;
const PITCH_SHIFT = 4;
// A punch angle past this (hundredths of a degree) is no angle: the FAMAS and the Galil write a sentinel in
// iparam1 and the Glock's burst writes junk, while the engine's own kick is clamped inside a few degrees.
const PUNCH_LIMIT = 2000;
// A weapon event carries the punch angle only where this many of its shots write one; the others (the AWP, the
// shotguns) pass zeros, and a weapon that fires too slowly for the punch to live until the next shot (the
// pistols) says nothing either way. Below this share the shots keep no punch and the page kicks the view itself.
const PUNCH_SHARE = 0.2;
// Seconds from a kill in which the server sends the body of the victim.
const CORPSE_SECONDS = 10;
const ROUND_ENDS = {
  '#Terrorists_Win': 'T', '#CTs_Win': 'CT', '#Target_Bombed': 'T', '#Bomb_Defused': 'CT',
  '#Target_Saved': 'CT', '#Hostages_Not_Rescued': 'T', '#All_Hostages_Rescued': 'CT',
  '#VIP_Escaped': 'CT', '#VIP_Assassinated': 'T', '#Round_Draw': null, '#Game_Commencing': null,
};
// The announcer's call at a round end. CS 1.3 prints the team's name ("NiP Wins!"), not a #Round_End text,
// so the call alone marks the end there.
const ROUND_END_CALLS = { '%!MRAD_terwin': 'T', '%!MRAD_ctwin': 'CT', '%!MRAD_rounddraw': null };

/** The timeline of a demo, with the weapon index width that decodes (`withWeaponBits()`). */
export function buildTimeline(buf, options = {}) {
  return withWeaponBits((weaponBits) => buildOnce(buf, { ...options, weaponBits }));
}

// `frameTimes` (an array) gets [frame offset, time] for each network frame: the time of its snapshot on the clock of
// the samples, or the frame's own time where the snapshot has none (src/dem places the fill's samples by it).
function buildOnce(buf, { file = null, weaponBits = 6, builder = null, frameTimes = null } = {}) {
  if (frameTimes) frameTimes.length = 0;
  const header = readHeader(buf);
  const state = new DemoState(header.netProtocol, { weaponBits });
  const players = new Map();
  const teams = new Map();
  const attribs = new Map();
  const samples = [];
  const kills = [];
  const rounds = [];
  const bombs = [];
  const cues = [];
  const views = [];
  const scores = [];
  const chat = [];
  const board = [];
  const pings = [];
  const world = new WorldTracker();
  const skins = [];
  const soundNames = [];
  const soundIds = new Map();
  const sounds = [];
  const shots = [];
  const radio = [];
  const effects = [];
  const corpses = [];
  const sprays = [];
  const soundId = (name) => {
    if (!soundIds.has(name)) {
      soundIds.set(name, soundNames.length);
      soundNames.push(name);
    }
    return soundIds.get(name);
  };
  const anims = [];
  const lastAnim = new Map();
  const kits = [];
  const decals = [];
  const lastKit = new Map();
  const sides = [];
  const names = [];
  const attribRows = [];
  // What a POV demo holds of a player outside its packets (src/fill): the recorder's eye, the radar, the shots.
  const eyes = [];
  const radar = [];
  const fires = [];
  const setSide = (entity, side) => {
    if (teams.get(entity) === side && teams.has(entity)) return;
    teams.set(entity, side);
    sides.push([round2(time), entity, side]);
  };
  const lastPing = new Map();
  let server = null;
  // Lower case: the game's files are named so, and some servers wrote "dE_train" or "de_Cbble".
  let map = header.mapName.toLowerCase();
  let time = 0;
  let lastSample = -1;
  let clock = new SnapshotClock();
  let recorder = null;
  let ended = 0;
  // The server's own clock (svc_time) at the first and the last playback frame: it runs on over a restart of the
  // rounds, so the demos of one stay on a server follow each other on it (tools/suggest-joins.js).
  let playback = false;
  const serverClock = [null, null];

  const name = (entity) => players.get(entity)?.name ?? null;

  const on = {
    time(t) {
      if (!playback) return;
      serverClock[0] ??= round2(t);
      serverClock[1] = round2(t);
    },
    serverinfo(info) {
      server = maskText(latin(info.hostName));
      map = info.mapName.replace(/^maps\//, '').replace(/\.bsp$/, '').toLowerCase();
      recorder = info.playerNum + 1;
    },
    userinfo({ slot, info }) {
      const nick = info.match(/\\name\\([^\\]*)/)?.[1];
      const entity = slot + 1;
      if (nick === undefined) {
        // A userinfo without a name is a disconnect: the slot is empty until the next connect.
        const last = names.findLast((n) => n[1] === entity);
        if (last && last[2] !== null) names.push([round2(time), entity, null]);
        return;
      }
      const model = info.match(/\\model\\([a-z0-9_]+)/i)?.[1]?.toLowerCase();
      if (model && skins.findLast((m) => m[1] === entity)?.[2] !== model) skins.push([round2(time), entity, model]);
      if (!/\\\*hltv\\1/.test(info)) {
        const masked = maskText(latin(nick));
        const last = names.findLast((n) => n[1] === entity);
        if (!last || last[2] !== masked) names.push([round2(time), entity, masked]);
      }
      const hltv = /\\\*hltv\\1/.test(info);
      const known = players.get(entity);
      if (!known || known.name !== maskText(latin(nick))) {
        players.set(entity, { entity, name: maskText(latin(nick)), hltv, since: time });
      }
    },
    pings(list) {
      for (const { slot, ping } of list) {
        const entity = slot + 1;
        const last = lastPing.get(entity);
        if (last && time - last.t < PING_SECONDS) continue;
        lastPing.set(entity, { t: time, ping });
        pings.push([round2(time), entity, ping]);
      }
    },
    sound(snd, st) {
      if (snd.stop || snd.sentence) return;
      const name = st.sounds.get(snd.index);
      if (!name || name === 'common/null.wav') return;
      sounds.push([round2(time), soundId(name), snd.entity, Math.round(snd.origin[0]), Math.round(snd.origin[1]), Math.round(snd.origin[2]), snd.volume, Math.round(snd.attenuation * 100), snd.channel]);
    },
    tempEntity(type, d, st) {
      const coord = (at) => Math.round(d.readInt16LE(at) / 8);
      const sprite = (at) => (st.models.get(d.readUInt16LE(at)) ?? '').replace(/^sprites\//, '').replace(/\.spr$/, '');
      const at = () => [coord(0), coord(2), coord(4)];
      // TE_EXPLOSION: position, sprite, scale x10, frame rate, flags.
      if (type === 3) effects.push([round2(time), 'explosion', ...at(), sprite(6), d[8] / 10, d[9], d[10]]);
      // TE_SMOKE: position, sprite, scale x10, frame rate.
      else if (type === 5) effects.push([round2(time), 'smoke', ...at(), sprite(6), d[8] / 10, d[9]]);
      // TE_SPRITE: position, sprite, scale x10, brightness.
      else if (type === 17) effects.push([round2(time), 'sprite', ...at(), sprite(6), d[8] / 10, d[9]]);
      // TE_SPARKS: position. The server sends showers of them around a grenade's burst, not one per bullet:
      // on these demos 96 to 99% of them lie within 400 units and 2 s of one (a bullet's own spark is the
      // client's work, EV_HLDM_FireBullets, and no demo holds it).
      else if (type === 9) effects.push([round2(time), 'sparks', ...at(), '', 0, 0]);
      // TE_BLOODSPRITE: position, two sprites, colour, scale. One where a bullet hits a player.
      else if (type === 115) effects.push([round2(time), 'blood', ...at(), '', d[10], d[11]]);
      // TE_WORLDDECAL(HIGH) and TE_DECAL(HIGH): position and the decal's index (+256 for the high ones). The
      // server's own marks: blood where a hit bled on a wall or the floor (TraceBleed), the scorch of a blast.
      else if (type === 116 || type === 117) decals.push([round2(time), ...at(), d[6] + (type === 117 ? 256 : 0)]);
      else if (type === 104 || type === 118) decals.push([round2(time), ...at(), d[6] + (type === 118 ? 256 : 0)]);
      // TE_PLAYERDECAL: the player, position, entity, decal. A spray logo; its picture is not in a demo.
      else if (type === 112) sprays.push([round2(time), d[0], Math.round(d.readInt16LE(1) / 8), Math.round(d.readInt16LE(3) / 8), Math.round(d.readInt16LE(5) / 8)]);
    },
    event(ev, st) {
      const script = st.eventScripts.get(ev.index);
      if (script === 'events/createsmoke.sc') {
        const a = ev.args;
        // A smoke grenade's createsmoke event: origin, the drift (fparam1, fparam2), and 'first' where bparam2 is
        // set. Despite the name that is every event but the first: the first (bparam2 0) lays the grenade's 20
        // gas puffs, the others a black puff each (src/shared/smoke.js).
        effects.push([round2(time), 'puff', Math.round(a['origin[0]'] ?? 0), Math.round(a['origin[1]'] ?? 0), Math.round(a['origin[2]'] ?? 0), a.bparam2 ? 'first' : '', a.fparam1 ?? 0, a.fparam2 ?? 0]);
        return;
      }
      const weapon = script?.match(/events\/(\w+)\.sc$/)?.[1];
      if (!weapon || weapon === 'decal_reset' || !ev.entity) return;
      const a = ev.args;
      // bparam1 is the silencer of the M4A1; on the USP, the Deagle and the Glock the engine writes the
      // empty-clip flag in the same place (isolated single shots, never a run: measured on these demos).
      // iparam1 and iparam2 are the punch angle the shot was fired along (hundredths of a degree, x down,
      // y right), fparam1 and fparam2 its own spread along the right and the up of that aim (FireBullets3
      // returns them): kept in hundredths too, as the event's own float carries two decimals.
      const hundredths = (v) => Math.round(v ?? 0);
      if (!st.hltv && ev.entity <= st.maxClients && !st.entities.has(ev.entity) && a['origin[0]'] !== undefined) {
        fires.push([round2(time + (ev.delay ?? 0)), ev.entity, Math.round(a['origin[0]']), Math.round(a['origin[1]'] ?? 0), Math.round(a['origin[2]'] ?? 0),
          Math.round((a['angles[1]'] ?? 0) * 10), Math.round((a['angles[0]'] ?? 0) * 10)]);
      }
      const wild = Math.abs(hundredths(a.iparam1)) > PUNCH_LIMIT || Math.abs(hundredths(a.iparam2)) > PUNCH_LIMIT;
      shots.push([round2(time + (ev.delay ?? 0)), ev.entity, weapon, a.bparam1 ? 1 : 0,
        wild ? null : hundredths(a.iparam1), wild ? null : hundredths(a.iparam2),
        Math.round((a.fparam1 ?? 0) * 100), Math.round((a.fparam2 ?? 0) * 100)]);
    },
    director(data) {
      if (data[0] !== DRC_CMD_EVENT || data.length < 9) return;
      cues.push([round2(time), data.readUInt16LE(1), data.readUInt16LE(3), data.readUInt32LE(5)]);
    },
    user(msg, data) {
      switch (msg) {
        case 'TeamInfo': {
          const team = cstr(data, 1);
          setSide(data[0], team === 'TERRORIST' ? 'T' : team === 'CT' ? 'CT' : null);
          return;
        }
        case 'ScoreInfo':
          // Entity, frags, deaths, class, team (1 T, 2 CT): the side of a player whose TeamInfo came before the recording.
          if (data.length < 9) return;
          if (!teams.has(data[0])) {
            const team = data.readInt16LE(7);
            if (team === 1 || team === 2) setSide(data[0], team === 1 ? 'T' : 'CT');
          }
          board.push([round2(time), data[0], data.readInt16LE(1), data.readInt16LE(3)]);
          return;
        case 'ClCorpse': {
          // The body the client draws once a dead player's entity is gone: model, origin (x128), angles,
          // the animation's start (1/100 s, from now), sequence, body, team (1 T, 2 CT), player. CS 1.5 sends no
          // player: the body is the oldest open death of that side with that model.
          const end = data.indexOf(0);
          if (end < 0 || data.length < end + 26) return;
          const at = end + 1;
          const coord = (k) => Math.round(data.readInt32LE(at + k * 4) / 128);
          const model = data.toString('latin1', 0, end).toLowerCase();
          const side = data[at + 24] === 2 ? 'CT' : 'T';
          let player = data.length >= end + 27 ? data[at + 25] : 0;
          if (!player) {
            const open = kills.filter((k) => time - k.t < CORPSE_SECONDS && k.victimTeam === side && !corpses.some((c) => c[1] === k.victim && c[0] >= k.t));
            player = (open.find((k) => skins.findLast((m) => m[1] === k.victim)?.[2] === model) ?? open[0])?.victim ?? 0;
          }
          if (!player) return;
          corpses.push([round2(time), player, coord(0), coord(1), coord(2), Math.round(data.readInt16LE(at + 14) / 8), data[at + 22], model, side]);
          return;
        }
        case 'SayText': {
          const line = chatLine(data);
          if (line) chat.push({ t: round2(time), entity: data[0], team: teams.get(data[0]) ?? null, ...line, name: line.name || name(data[0]) || '?' });
          return;
        }
        case 'ScoreAttrib':
          if (attribs.get(data[0]) !== data[1]) attribRows.push([round2(time), data[0], data[1]]);
          attribs.set(data[0], data[1]);
          return;
        case 'DeathMsg': {
          const hasHeadshot = data.length >= 4 && (data[2] === 0 || data[2] === 1) && data[3] >= 0x20;
          const weapon = cstr(data, hasHeadshot ? 3 : 2);
          kills.push({
            t: round2(time), killer: data[0] || null, victim: data[1],
            headshot: hasHeadshot ? data[2] === 1 : false, weapon,
            killerTeam: teams.get(data[0]) ?? null, victimTeam: teams.get(data[1]) ?? null,
            // The name at the kill: a later player can take the slot.
            killerName: data[0] ? name(data[0]) : null, victimName: name(data[1]),
          });
          return;
        }
        case 'TextMsg': {
          const text = cstr(data, 1);
          if (text in ROUND_ENDS) rounds.push({ t: round2(time), kind: 'end', reason: text.slice(1), winner: ROUND_ENDS[text] });
          if (text === '#Bomb_Planted') bombs.push({ t: round2(time), kind: 'planted' });
          if (text === '#Bomb_Defused') bombs.push({ t: round2(time), kind: 'defused' });
          if (text === '#Target_Bombed') bombs.push({ t: round2(time), kind: 'exploded' });
          return;
        }
        case 'SendAudio': {
          const audio = cstr(data, 1);
          radio.push([round2(time), data[0], audio]);
          if (audio in ROUND_END_CALLS) {
            const winner = ROUND_END_CALLS[audio];
            const reason = winner === 'T' ? 'Terrorists_Win' : winner === 'CT' ? 'CTs_Win' : 'Round_Draw';
            rounds.push({ t: round2(time), kind: 'end', reason, winner, call: true });
          }
          if (audio === '%!MRAD_BOMBPL' && !bombs.some((b) => b.kind === 'planted' && time - b.t < 2)) {
            bombs.push({ t: round2(time), kind: 'planted' });
          }
          return;
        }
        case 'Radar':
          // A teammate's place, once a second while it moves (CBasePlayer::UpdateClientData): entity, x, y, z (x8).
          if (data.length >= 7) radar.push([round2(time), data[0], Math.round(data.readInt16LE(1) / 8), Math.round(data.readInt16LE(3) / 8), Math.round(data.readInt16LE(5) / 8)]);
          return;
        case 'RoundTime':
          rounds.push({ t: round2(time), kind: 'start', seconds: data.readInt16LE(0) });
          world.startRound(time);
          return;
        case 'TeamScore': {
          const team = cstr(data, 0);
          const at = data.indexOf(0) + 1;
          if (at + 2 <= data.length) scores.push({ t: round2(time), team: team === 'TERRORIST' ? 'T' : team, score: data.readInt16LE(at) });
          return;
        }
        default:
      }
    },
  };

  // The frame clock: a later playback segment starts it again at 0, so its frames get `offset`.
  let offset = 0;
  let sawPlayback = false;
  let newSegment = false;
  let pending = null;
  const walkEnd = {};
  for (const frame of frames(buf, header, walkEnd)) {
    if (frame.type === FrameType.SECTION_START && sawPlayback) newSegment = true;
    if (!frame.view) continue;
    // The loading section (type 0) runs on its own clock; only playback frames move the time.
    playback = frame.type === FrameType.NETWORK;
    if (playback) {
      if (newSegment) {
        offset = time + SEGMENT_GAP - frame.time;
        clock = new SnapshotClock();
        newSegment = false;
      }
      const t = frame.time + offset;
      if (sawPlayback && t - time > MAX_STEP && (pending === null || Math.abs(t - pending) > MAX_STEP)) {
        pending = t;
      } else {
        pending = null;
        if (t >= time) time = t;
      }
      sawPlayback = true;
    }
    ended = time;
    state.sequence = frame.sequence;
    readBlock(frame.data, state, on);

    // One row per playback frame: an HLTV demo sends 10 to 30 a second and every one of them is a position the
    // demo really holds, so nothing is thrown away. Two frames inside one hundredth of a second (a POV demo of
    // 100 frames a second) fall on one row, which is as fine as the clock gets. What the frame's state holds
    // (positions, animations, kits, the world) goes at its snapshot's time (src/snapshot-clock.js); its messages
    // stay at the frame's.
    if (!playback) {
      frameTimes?.push([frame.offset, time]);
      continue;
    }
    const at = clock.at(time, state.time);
    frameTimes?.push([frame.offset, at ?? time]);
    if (at === null || round2(at) <= lastSample) continue;
    lastSample = round2(at);
    const entities = withOwnOrigin(state, recorder);
    const row = [round2(at)];
    for (const [entity, e] of entities) {
      if (entity < 1 || entity > state.maxClients) continue;
      const team = teams.get(entity);
      if (!team || players.get(entity)?.hltv) continue;
      const flags = (attribs.get(entity) ?? 0) & 3;
      row.push(entity, Math.round(e['origin[0]'] ?? 0), Math.round(e['origin[1]'] ?? 0), Math.round(e['origin[2]'] ?? 0),
        Math.round((e['angles[1]'] ?? 0) * 10), (team === 'CT' ? 4 : 0) | flags | (viewPitch(e['angles[0]'] ?? 0) + 900) << PITCH_SHIFT | (e.usehull === 1 ? DUCKING : 0));
    }
    samples.push(row);
    for (const [entity, e] of entities) {
      if (entity < 1 || entity > state.maxClients) continue;
      const anim = `${e.sequence ?? 0},${e.gaitsequence ?? 0}`;
      if (lastAnim.get(entity) === anim) continue;
      lastAnim.set(entity, anim);
      anims.push([round2(at), entity, e.sequence ?? 0, e.gaitsequence ?? 0]);
    }
    // A CT's model with body 1 wears the defuse kit (CBasePlayer::GiveDefuser); a T's body 1 is the bomb's pack.
    for (const [entity, e] of entities) {
      if (entity < 1 || entity > state.maxClients || !teams.has(entity)) continue;
      const kit = teams.get(entity) === 'CT' && (e.body ?? 0) & 1 ? 1 : 0;
      if ((lastKit.get(entity) ?? 0) === kit) continue;
      lastKit.set(entity, kit);
      kits.push([round2(at), entity, kit]);
    }
    world.sample(at, entities, state.models, (entity) => {
      if (entity < 1 || entity > state.maxClients) return null;
      const team = teams.get(entity);
      if (!team || players.get(entity)?.hltv) return { team: null, dead: true };
      return { team, dead: ((attribs.get(entity) ?? 0) & 1) !== 0 };
    });
    if (!state.hltv) {
      views.push([round2(time), Math.round(frame.view.origin[0]), Math.round(frame.view.origin[1]), Math.round(frame.view.angles[1])]);
      const eye = serverEye(state.clientdata);
      const last = eyes.at(-1);
      if (eye && (!last || last[1] !== eye[0] || last[2] !== eye[1] || last[3] !== eye[2])) eyes.push([round2(at), ...eye]);
    }
  }

  // The frames after the last row hold no data (a hung server under a proxy that kept writing).
  const end = Math.min(ended, lastRowOf(samples, kills, rounds, bombs, scores, cues, views, chat, board, pings, sides, names,
    attribRows, decals, skins, anims, kits, sounds, shots, radio, effects, corpses, sprays, radar, fires) + DATA_MARGIN);
  world.finish(end);

  return {
    version: TIMELINE_VERSION,
    source: {
      file,
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
      netProtocol: header.netProtocol,
      kind: state.hltv ? 'hltv' : 'pov',
      clock: serverClock[0] === null ? null : serverClock,
      // Delta messages that decoded against the current set, as their source set was not stored.
      deltaMisses: state.deltaMisses,
      // The stamp of the builder's source (builderStamp() of tools/lib/demos.js), given by the tool.
      ...(builder ? { builder } : {}),
      // The byte where the frames stop short of a valid directory: a damaged frame length cut the match there.
      ...(directoryOf(header, buf) !== null && walkEnd.at < header.directoryOffset ? { cut: walkEnd.at } : {}),
    },
    map,
    server,
    duration: round2(end),
    recorder: state.hltv ? null : recorder,
    players: [...players.values()].filter((p) => !p.hltv).map(({ entity, name: n }) => ({ entity, name: n })),
    // Each sample: time, then six numbers per player: entity, x, y, z, yaw in tenths of a degree, flags
    // (1 dead, 2 bomb, 4 CT, 8 ducking, and from bit 4 eleven bits of the view pitch in tenths + 900, down
    // positive). Version 7 and before held the yaw in whole degrees and the pitch in bits 3 to 10 of the
    // flags, with ducking at bit 11; `stateAt()` of src/shared/director.js reads both.
    samples: smoothSpikes(samples),
    kills,
    rounds: withoutCallDuplicates(rounds),
    bombs,
    scores,
    cues,
    views,
    // Spray logos: [t, entity of the player, x, y, z]. Each player's last one stays.
    sprays,
    // The bodies of the dead, from when their entity goes: [t, entity, x, y, z, yaw, sequence, model, side].
    corpses,
    // Chat as the players saw it: {t, entity, team, name, text, dead, spectator, teamOnly}.
    chat,
    // Scoreboard changes: [t, entity, frags, deaths].
    board,
    // Pings: [t, entity, ms], at most one per player every few seconds.
    pings,
    // Side changes: [t, entity, 'T'|'CT'|null]; null is a spectator.
    sides,
    // Who sits in a slot: [t, entity, name], null after a disconnect.
    names,
    // ScoreAttrib changes: [t, entity, flags] (1 dead, 2 bomb).
    attribs: attribRows,
    // The weapon in hand: [t, entity, key] (keys of shared/weapons.js).
    loadouts: world.loadouts,
    // The defuse kit on a CT's model: [t, entity, 1|0].
    kits,
    // The server's decals: [t, x, y, z, index] (src/shared/blood.js tells the blood from them).
    decals,
    // A weapon that shows in a hand for the first time: {t, entity, item, kind: 'buy'|'pickup', price, x, y}.
    purchases: world.purchases,
    // Thrown grenades: {kind: 'he'|'flash'|'smoke', owner, t0, burst, t1, x, y, path: [[t, x, y, z]]}.
    grenades: world.grenades,
    // The bomb on the ground: {kind: 'planted'|'dropped', t0, t1, x, y}.
    bombSpots: world.bomb,
    // Weapons on the ground: {item, t0, t1, x, y}.
    ground: world.ground,
    // The player model of each slot: [t, entity, name] (gign, terror...).
    skins,
    // Animation changes: [t, entity, sequence, gaitsequence] (upper body, legs).
    anims,
    // Server sounds: [t, name index, entity, x, y, z, volume 0-255, attenuation x100, channel (CHAN_*)].
    soundNames,
    sounds,
    // Weapon fire from the events: [t, entity, weapon, bparam1 0|1 (the M4A1's silencer; the empty clip of a
    // pistol), punch x, punch y (hundredths of a degree, null where the event carries none), spread x, spread y
    // (hundredths, along the right and the up of the aim). A shot's delay can put it before the one of the
    // frame before.
    shots: withPunchKept(shots.sort((a, b) => a[0] - b[0])),
    // A POV demo only, for src/fill. eyes: [t, x, y, z], the point of the recorder's set (serverEye()), at each
    // change. radar: [t, entity, x, y, z] of a teammate. fires: [t, entity, x, y, z, yaw, pitch (tenths)] of a
    // shot by a player outside the packet.
    ...(state.hltv ? {} : { eyes, radar, fires: fires.sort((a, b) => a[0] - b[0]) }),
    // Radio and announcer messages: [t, sender, code such as "%!MRAD_BOMBPL"].
    radio,
    // Effects of the game: [t, kind, x, y, z, sprite, a, b]. explosion (a scale, b frame rate), smoke
    // (scale, frame rate), sprite (scale, brightness), sparks, and puff of a smoke grenade (a, b the drift).
    effects,
  };
}

/**
 * The entities with the POV recorder at the origin of its svc_clientdata. The game leaves the local player's origin
 * out of the packet entities (Player_Encode), so there it stays at its baseline. An observer's clientdata holds the
 * origin of the player it watches: then the entities stay as they are.
 */
export function withOwnOrigin(state, recorder) {
  const own = state.clientdata;
  const e = recorder === null || state.hltv ? undefined : state.entities.get(recorder);
  if (!e || (own.iuser1 ?? 0) !== 0 || !Object.keys(own).length) return state.entities;
  const entities = new Map(state.entities);
  entities.set(recorder, { ...e, 'origin[0]': own['origin[0]'] ?? 0, 'origin[1]': own['origin[1]'] ?? 0, 'origin[2]': own['origin[2]'] ?? 0 });
  return entities;
}

// FL_DUCKING of the entity flags.
const FL_DUCKING = 1 << 14;

/**
 * The point from which the server builds the set of a client (SetupVisibility of the game): the origin and the
 * view offset of its clientdata, 18 lower while it ducks. An observer has the origin of the player it watches.
 */
export function serverEye(own) {
  if (own['origin[0]'] === undefined) return null;
  const duck = ((own.flags ?? 0) & FL_DUCKING) !== 0 ? 18 : 0;
  return [Math.round(own['origin[0]']), Math.round(own['origin[1]'] ?? 0), Math.round((own['origin[2]'] ?? 0) + (own['view_ofs[2]'] ?? 0) - duck)];
}

/** The latest time of the lists of rows ([t, ...] or {t}). */
function lastRowOf(...lists) {
  let last = 0;
  for (const rows of lists) for (const row of rows) last = Math.max(last, Array.isArray(row) ? row[0] : row.t);
  return last;
}

/** Round ends from the announcer's call, kept only where no round-end text came within 2 s. */
export function withoutCallDuplicates(rounds) {
  const texts = rounds.filter((r) => r.kind === 'end' && !r.call);
  return rounds
    .filter((r) => !r.call || !texts.some((x) => Math.abs(x.t - r.t) < 2))
    .map(({ call, ...r }) => r);
}

/**
 * SayText: the sender's entity, then "<color>[prefix ]name :   text". Prefixes of CS 1.5: *DEAD*,
 * (Spectator), (Terrorist), (Counter-Terrorist); the last two mean team chat.
 */
export function chatLine(data) {
  // CS 1.6: a title of titles.txt, then the name (often empty) and the text as strings of their own.
  const strings = latin(data.subarray(1)).replace(/^[\x01-\x1f]+/, '').split('\0');
  if (strings[0].startsWith('#Cstrike_')) {
    const title = CHAT_TITLES[strings[0]];
    const text = (strings[2] ?? '').replace(/[\x00-\x1f]+/g, ' ').trim();
    if (!title || !text) return null;
    return { name: maskText(strings[1] ?? ''), text: maskSecrets(maskText(text)), dead: false, spectator: false, teamOnly: false, ...title };
  }
  const raw = latin(data.subarray(1)).replace(/[\x00-\x1f]+/g, ' ').trim();
  const split = raw.indexOf(' :');
  if (split < 0) return null;
  let who = raw.slice(0, split).trim();
  const text = raw.slice(split + 2).trim();
  if (!text) return null;
  const flags = { dead: false, spectator: false, teamOnly: false };
  for (;;) {
    const m = who.match(/^(\*DEAD\*|\(Spectator\)|\(Terrorist\)|\(Counter-Terrorist\))\s*/);
    if (!m) break;
    if (m[1] === '*DEAD*') flags.dead = true;
    else if (m[1] === '(Spectator)') flags.spectator = true;
    else flags.teamOnly = true;
    who = who.slice(m[0].length);
  }
  return { name: maskText(who), text: maskSecrets(maskText(text)), ...flags };
}

/** A server password typed into the chat stays out of the TV. */
export function maskSecrets(text) {
  return text.replace(/\b((?:rcon_password|sv_password|password)\s+)("[^"]*"|\S+)/gi, (all, key, value) => (value === '""' ? all : `${key}***`));
}

/**
 * A player entity keeps a third of the view pitch, negated (CS); the view pitch in tenths of a degree, down
 * positive. The entity's own angle comes in 16 bits of a turn (0.0055 degrees), so tenths lose nothing of it.
 */
export function viewPitch(angle) {
  const wrapped = ((angle + 180) % 360 + 360) % 360 - 180;
  return Math.max(-890, Math.min(890, Math.round(-wrapped * 30))) || 0;
}

/**
 * The shot rows with the punch angle kept only for the weapons whose events really carry one: a weapon that
 * writes a plausible punch on fewer than PUNCH_SHARE of its shots (the AWP and the shotguns pass zeros, a pistol
 * fires too slowly for its punch to live until the next shot) keeps none, and the page kicks the view itself.
 * Changes the rows in place and returns them.
 */
export function withPunchKept(shots) {
  const seen = new Map();
  for (const row of shots) {
    const s = seen.get(row[2]) ?? { n: 0, punch: 0 };
    s.n++;
    if (row[4] !== null && (row[4] || row[5])) s.punch++;
    seen.set(row[2], s);
  }
  for (const row of shots) {
    const s = seen.get(row[2]);
    if (s.punch < s.n * PUNCH_SHARE) {
      row[4] = null;
      row[5] = null;
    }
  }
  return shots;
}

/** An archived text never shows an e-mail address. */
export function maskText(text) {
  return text.replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, '[e-mail]');
}

function latin(buf) {
  return typeof buf === 'string' ? buf : buf.toString('latin1');
}

function cstr(buf, at) {
  const end = buf.indexOf(0, at);
  return buf.toString('latin1', at, end < 0 ? buf.length : end);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
