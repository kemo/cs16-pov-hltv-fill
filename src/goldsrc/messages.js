// Decodes every server message of a GoldSrc demo block (net protocols 45 to 48).
// A message with an unknown layout stops the block with a DemoDesync, never with a guess.

import { Reader } from './bits.js';
import { DeltaTables, readDelta } from './delta.js';

export const SVC = {
  BAD: 0, NOP: 1, DISCONNECT: 2, EVENT: 3, VERSION: 4, SETVIEW: 5, SOUND: 6, TIME: 7, PRINT: 8,
  STUFFTEXT: 9, SETANGLE: 10, SERVERINFO: 11, LIGHTSTYLE: 12, UPDATEUSERINFO: 13, DELTADESCRIPTION: 14,
  CLIENTDATA: 15, STOPSOUND: 16, PINGS: 17, PARTICLE: 18, DAMAGE: 19, SPAWNSTATIC: 20, EVENT_RELIABLE: 21,
  SPAWNBASELINE: 22, TEMP_ENTITY: 23, SETPAUSE: 24, SIGNONNUM: 25, CENTERPRINT: 26, KILLEDMONSTER: 27,
  FOUNDSECRET: 28, SPAWNSTATICSOUND: 29, INTERMISSION: 30, FINALE: 31, CDTRACK: 32, RESTORE: 33,
  CUTSCENE: 34, WEAPONANIM: 35, DECALNAME: 36, ROOMTYPE: 37, ADDANGLE: 38, NEWUSERMSG: 39,
  PACKETENTITIES: 40, DELTAPACKETENTITIES: 41, CHOKE: 42, RESOURCELIST: 43, NEWMOVEVARS: 44,
  RESOURCEREQUEST: 45, CUSTOMIZATION: 46, CROSSHAIRANGLE: 47, SOUNDFADE: 48, FILETXFERFAILED: 49,
  HLTV: 50, DIRECTOR: 51, VOICEINIT: 52, VOICEDATA: 53, SENDEXTRAINFO: 54, TIMESCALE: 55,
  RESOURCELOCATION: 56, SENDCVARVALUE: 57, SENDCVARVALUE2: 58,
};

const SVC_NAMES = Object.fromEntries(Object.entries(SVC).map(([k, v]) => [v, k]));

/** A message that does not decode. `hltv` tells whether the demo had shown itself as an HLTV demo by then. */
export class DemoDesync extends Error {}

/**
 * The result of `run(weaponBits)`: a POV demo of an older engine build writes a weapon's index in svc_clientdata in
 * 5 bits, not 6. A misread width can break the decode at any later message, so any desync of a POV demo runs
 * again with 5; when that fails too, the first error stands.
 */
export function withWeaponBits(run) {
  try {
    return run(6);
  } catch (e) {
    if (!(e instanceof DemoDesync) || e.hltv) throw e;
    try {
      return run(5);
    } catch {
      throw e;
    }
  }
}

// Bytes after the type byte of each fixed-size temp entity (TE_*).
const TEMP_ENTITY_BYTES = {
  0: 24, 1: 20, 2: 6, 3: 11, 4: 6, 5: 10, 6: 12, 7: 17, 8: 16, 9: 6, 10: 6, 11: 6, 12: 8, 14: 9,
  15: 19, 17: 10, 18: 16, 19: 24, 20: 24, 21: 24, 22: 10, 23: 11, 24: 16, 25: 19, 27: 12, 28: 16,
  30: 17, 31: 17, 99: 2, 100: 10, 101: 14, 102: 12, 103: 14, 104: 9, 105: 5, 106: 17, 107: 13,
  108: 24, 109: 9, 110: 17, 111: 7, 112: 10, 113: 19, 114: 19, 115: 12, 116: 7, 117: 7, 118: 9,
  119: 16, 120: 18, 121: 5, 122: 10, 123: 9, 124: 7, 125: 1, 126: 18, 127: 15,
};

const ENTITY_END = 0x7ff;

/**
 * The state that one block needs from the blocks before it: the delta tables, the user message
 * numbers, the baselines and the entity frames that a delta packet starts from.
 */
export class DemoState {
  constructor(netProtocol, { weaponBits = 6 } = {}) {
    this.netProtocol = netProtocol;
    // The width of a weapon's index in svc_clientdata: 6 bits, 5 on some older engine builds.
    this.weaponBits = weaponBits;
    this.hltv = false;
    this.deltas = new DeltaTables();
    this.userMessages = new Map();
    this.maxClients = 32;
    this.baselines = new Map();
    this.instancedBaselines = [];
    // Entity sets by (incoming sequence & 0xff); a delta packet names the set it starts from.
    this.history = new Map();
    this.entities = new Map();
    // The client's own state (svc_clientdata) and its sets by sequence, as for the entities.
    this.clientdata = {};
    this.clientHistory = new Map();
    // Delta messages whose source set was not stored: they decode against the current set.
    this.deltaMisses = 0;
    this.sequence = 0;
    this.time = 0;
    this.lastMessages = [];
    // Precache tables from svc_resourcelist: index -> file name.
    this.models = new Map();
    this.sounds = new Map();
    this.eventScripts = new Map();
  }
}

/**
 * Reads one block and calls `on[name](payload, state)` for the messages that a caller wants.
 * Every message is read, so the next one starts at the right byte. `on.message(id, start, end, state)` gets the
 * bytes of each message after it is read (src/dem rewrites a block from them).
 */
export function readBlock(block, state, on = {}) {
  const r = new Reader(block);
  state.lastMessages = [];

  while (!r.done) {
    const start = r.at;
    const id = r.u8();
    state.lastMessages.push(`${SVC_NAMES[id] ?? id}@${start}`);

    try {
      if (id >= 64) userMessage(r, id, state, on);
      else readMessage(r, id, state, on);
    } catch (e) {
      const desync = e instanceof DemoDesync ? e : new DemoDesync(`${e.message} (message ${SVC_NAMES[id] ?? id} at ${start}; ${state.lastMessages.slice(-6).join(' ')})`);
      desync.hltv = state.hltv;
      throw desync;
    }
    on.message?.(id, start, r.at, state);
  }
}

function userMessage(r, id, state, on) {
  const msg = state.userMessages.get(id);
  if (!msg) throw new DemoDesync(`Unknown message ${id} at ${r.at - 1}; ${state.lastMessages.slice(-6).join(' ')}`);
  const size = msg.size === -1 ? r.u8() : msg.size;
  const data = r.bytes(size);
  on.user?.(msg.name, data, state);
}

function readMessage(r, id, state, on) {
  switch (id) {
    case SVC.NOP:
    case SVC.KILLEDMONSTER:
    case SVC.FOUNDSECRET:
    case SVC.INTERMISSION:
    case SVC.CHOKE:
      return;
    case SVC.DISCONNECT:
    case SVC.CENTERPRINT:
    case SVC.FINALE:
    case SVC.CUTSCENE:
    case SVC.FILETXFERFAILED:
    case SVC.RESOURCELOCATION:
    case SVC.SENDCVARVALUE:
      r.string();
      return;
    case SVC.PRINT: {
      const text = r.string();
      on.print?.(text, state);
      return;
    }
    case SVC.STUFFTEXT: {
      const text = r.string();
      on.stufftext?.(text, state);
      return;
    }
    case SVC.EVENT:
      return events(r, state, on);
    case SVC.VERSION:
      r.skip(4);
      return;
    case SVC.SETVIEW: {
      const entity = r.i16();
      on.setview?.(entity, state);
      return;
    }
    case SVC.SOUND:
      return sound(r, state, on);
    case SVC.TIME:
      state.time = r.f32();
      on.time?.(state.time, state);
      return;
    case SVC.SETANGLE:
      r.skip(6);
      return;
    case SVC.SERVERINFO:
      return serverInfo(r, state, on);
    case SVC.LIGHTSTYLE:
      r.skip(1);
      r.string();
      return;
    case SVC.UPDATEUSERINFO: {
      const slot = r.u8();
      const uid = r.u32();
      const info = r.string();
      r.skip(16);
      on.userinfo?.({ slot, uid, info: info.toString('latin1') }, state);
      return;
    }
    case SVC.DELTADESCRIPTION: {
      const name = r.string().toString('latin1');
      const count = r.u16();
      const br = r.bits();
      const fields = [];
      const meta = state.deltas.get('delta_description_t');
      for (let i = 0; i < count; i++) fields.push(readDelta(br, meta));
      br.end();
      state.deltas.define(name, fields);
      return;
    }
    case SVC.CLIENTDATA:
      return clientData(r, state, on);
    case SVC.STOPSOUND:
    case SVC.ROOMTYPE:
    case SVC.ADDANGLE:
      r.skip(2);
      return;
    case SVC.PINGS: {
      const br = r.bits();
      const pings = [];
      while (br.bit()) pings.push({ slot: br.read(5), ping: br.read(12), loss: br.read(7) });
      br.end();
      on.pings?.(pings, state);
      return;
    }
    case SVC.PARTICLE:
      r.skip(11);
      return;
    case SVC.SPAWNSTATIC: {
      r.skip(2 + 1 + 1 + 2 + 1 + 9);
      if (r.u8() !== 0) r.skip(5);
      return;
    }
    case SVC.EVENT_RELIABLE: {
      const br = r.bits();
      const index = br.read(10);
      const args = readDelta(br, state.deltas.get('event_t'));
      if (br.bit()) br.read(16);
      br.end();
      on.event?.({ index, entity: args.entindex || null, args }, state);
      return;
    }
    case SVC.SPAWNBASELINE:
      return spawnBaseline(r, state);
    case SVC.TEMP_ENTITY:
      return tempEntity(r, state, on);
    case SVC.SETPAUSE:
    case SVC.SIGNONNUM:
      r.skip(1);
      return;
    case SVC.SPAWNSTATICSOUND:
      r.skip(14);
      return;
    case SVC.CDTRACK:
    case SVC.WEAPONANIM:
    case SVC.CROSSHAIRANGLE:
      r.skip(2);
      return;
    case SVC.RESTORE: {
      r.string();
      const n = r.u8();
      for (let i = 0; i < n; i++) r.string();
      return;
    }
    case SVC.DECALNAME:
      r.skip(1);
      r.string();
      return;
    case SVC.NEWUSERMSG: {
      const index = r.u8();
      const size = r.i8();
      const name = r.bytes(16);
      const end = name.indexOf(0);
      state.userMessages.set(index, { name: name.toString('latin1', 0, end < 0 ? 16 : end), size });
      return;
    }
    case SVC.PACKETENTITIES:
      return packetEntities(r, state, on, false);
    case SVC.DELTAPACKETENTITIES:
      return packetEntities(r, state, on, true);
    case SVC.RESOURCELIST:
      return resourceList(r, state, on);
    case SVC.NEWMOVEVARS:
      r.skip(4 * 16 + 1 + 4 * 8);
      r.string();
      return;
    case SVC.RESOURCEREQUEST:
      r.skip(8);
      return;
    case SVC.CUSTOMIZATION: {
      r.skip(2);
      r.string();
      r.skip(2 + 4);
      if (r.u8() & 4) r.skip(16);
      return;
    }
    case SVC.SOUNDFADE:
      r.skip(4);
      return;
    case SVC.HLTV: {
      const mode = r.u8();
      state.hltv = true;
      // Mode 1 carries 8 bytes; in protocol 45 (CS 1.3) mode 2 does too.
      if (mode === 1 || (mode === 2 && state.netProtocol <= 45)) r.skip(8);
      return;
    }
    case SVC.DIRECTOR: {
      const length = r.u8();
      const data = r.bytes(length);
      on.director?.(data, state);
      return;
    }
    case SVC.VOICEINIT:
      r.string();
      // Some net 46 builds send the quality too: there it is the last byte of the block, too short for a message.
      if (state.netProtocol >= 47 || r.at === r.buf.length - 1) r.skip(1);
      return;
    case SVC.VOICEDATA: {
      r.skip(1);
      r.skip(r.u16());
      return;
    }
    case SVC.SENDEXTRAINFO:
      r.string();
      r.skip(1);
      return;
    case SVC.TIMESCALE:
      r.skip(4);
      return;
    case SVC.SENDCVARVALUE2:
      r.skip(4);
      r.string();
      return;
    default:
      throw new DemoDesync(`Unknown message ${id} at ${r.at - 1}; ${state.lastMessages.slice(-6).join(' ')}`);
  }
}

function serverInfo(r, state, on) {
  const protocol = r.i32();
  r.skip(4 + 4);
  r.skip(16);
  state.maxClients = r.u8();
  const playerNum = r.u8();
  r.skip(1);
  const gameDir = r.string().toString('latin1');
  const hostName = r.string();
  const mapName = r.string().toString('latin1');
  // Protocol 45 (CS 1.3) ends here; from 46 on a map cycle follows, then a flag: a non-zero flag carries 21
  // more bytes (a client dll hash on secure servers).
  if (state.netProtocol >= 46) {
    r.string();
    if (r.u8() > 0) r.skip(21);
  }
  state.history.clear();
  state.entities = new Map();
  state.clientHistory.clear();
  state.clientdata = {};
  on.serverinfo?.({ protocol, maxClients: state.maxClients, playerNum, gameDir, hostName, mapName }, state);
}

/**
 * svc_event: client-side effects such as weapon fire. Each names an event script by its precache index and,
 * when it carries no entindex, the entity by its place in the current packet.
 */
function events(r, state, on) {
  const br = r.bits();
  const count = br.read(5);
  const packet = [...state.entities.keys()].sort((a, b) => a - b);
  for (let i = 0; i < count; i++) {
    const index = br.read(10);
    let entity = null;
    let args = {};
    if (br.bit()) {
      entity = packet[br.read(11)] ?? null;
      if (br.bit()) args = readDelta(br, state.deltas.get('event_t'));
    }
    // The event's delay (fire_time) in hundredths of a second: when in the packet it really happened.
    const delay = br.bit() ? br.read(16) / 100 : 0;
    on.event?.({ index, entity: args.entindex || entity, args, delay }, state);
  }
  br.end();
}

// svc_sound flags.
const SND = { VOLUME: 1, ATTENUATION: 2, LARGE_INDEX: 4, PITCH: 8, SENTENCE: 16, STOP: 32 };

/** svc_sound: a sound of the server, by precache index (or sentence), at an entity and an origin. */
function sound(r, state, on) {
  const br = r.bits();
  const flags = br.read(9);
  const volume = flags & SND.VOLUME ? br.read(8) : 255;
  const attenuation = flags & SND.ATTENUATION ? br.read(8) / 64 : 1;
  const channel = br.read(3);
  const entity = br.read(11);
  const index = br.read(flags & SND.LARGE_INDEX ? 16 : 8);
  const origin = br.vec3Coord();
  const pitch = flags & SND.PITCH ? br.read(8) : 100;
  br.end();
  on.sound?.({ flags, volume, attenuation, channel, entity, index, origin, pitch, sentence: (flags & SND.SENTENCE) !== 0, stop: (flags & SND.STOP) !== 0 }, state);
}

function clientData(r, state, on) {
  // An HLTV proxy writes the message with no body: a spectator has no client state.
  if (state.hltv) return;
  const br = r.bits();
  // Without a source sequence the delta starts from zeros.
  let from = null;
  if (br.bit()) {
    const sequence = br.read(8);
    from = state.clientHistory.get(sequence);
    if (!from) {
      state.deltaMisses++;
      from = state.clientdata;
    }
  }
  const data = readDelta(br, state.deltas.get('clientdata_t'), from);
  while (br.bit()) {
    br.read(state.weaponBits);
    readDelta(br, state.deltas.get('weapon_data_t'));
  }
  br.end();
  state.clientdata = data;
  state.clientHistory.set(state.sequence & 0xff, data);
  on.clientdata?.(data, state);
}

function spawnBaseline(r, state) {
  const br = r.bits();
  for (;;) {
    const index = br.read(11);
    if (index === ENTITY_END) break;
    const type = br.read(2);
    const table = entityTable(state, index, (type & 1) === 0);
    state.baselines.set(index, readDelta(br, state.deltas.get(table)));
  }
  if (br.read(5) !== 0x1f) throw new DemoDesync('Baseline footer missing.');
  const extra = br.read(6);
  state.instancedBaselines = [];
  for (let i = 0; i < extra; i++) state.instancedBaselines.push(readDelta(br, state.deltas.get('entity_state_t')));
  br.end();
}

function entityTable(state, index, custom) {
  if (custom) return 'custom_entity_state_t';
  return index > 0 && index <= state.maxClients ? 'entity_state_player_t' : 'entity_state_t';
}

function packetEntities(r, state, on, delta) {
  r.u16();
  let from = new Map();
  if (delta) {
    const sequence = r.u8();
    from = state.history.get(sequence);
    if (!from) {
      state.deltaMisses++;
      from = state.entities;
    }
  }
  const next = delta ? new Map(from) : new Map();
  // The numbers of the custom entities (beams): their state uses custom_entity_state_t.
  next.customs = new Set(delta ? from.customs : []);
  // The states of this packet in the order they came: the baseline offset of a full packet counts back in it.
  const order = [];
  const br = r.bits();
  let number = 0;

  for (;;) {
    const peek = br.pos;
    if (br.read(16) === 0) break;
    br.pos = peek;

    let remove = 0;
    if (delta) {
      remove = br.bit();
      number = br.bit() ? br.read(11) : number + br.read(6);
    } else if (br.bit()) {
      number += 1;
    } else {
      number = br.bit() ? br.read(11) : number + br.read(6);
    }

    if (remove) {
      next.delete(number);
      next.customs.delete(number);
      continue;
    }

    // After the number: custom, then an instanced baseline when the server has any, then in a full
    // packet a baseline offset: the state that many places back in this packet (ReHLDS SV_FindBestBaseline).
    const custom = br.bit();
    let base = delta ? from.get(number) : undefined;
    let instanced = false;
    if (state.instancedBaselines.length > 0 && br.bit()) {
      base = state.instancedBaselines[br.read(6)];
      instanced = true;
    }
    if (!delta && !instanced && br.bit()) {
      base = order[order.length - br.read(6)];
    }
    base ??= state.baselines.get(number);
    const entity = readDelta(br, state.deltas.get(entityTable(state, number, custom)), base ?? null);
    next.set(number, entity);
    if (custom) next.customs.add(number); else next.customs.delete(number);
    order.push(entity);
  }
  br.end();

  state.entities = next;
  state.history.set(state.sequence & 0xff, next);
  on.entities?.(next, state);
}

// Resource types of svc_resourcelist; a model's index is its modelindex in entity state.
const RESOURCE_TYPES = ['sound', 'skin', 'model', 'decal', 'generic', 'eventscript', 'world'];

function resourceList(r, state, on) {
  const br = r.bits();
  const count = br.read(12);
  const resources = [];
  for (let i = 0; i < count; i++) {
    const type = br.read(4);
    const name = br.string().toString('latin1');
    const index = br.read(12);
    br.read(24);
    resources.push({ type: RESOURCE_TYPES[type] ?? type, name, index });
    const flags = br.read(3);
    if (flags & 4) br.read(32), br.read(32), br.read(32), br.read(32);
    if (br.bit()) for (let j = 0; j < 8; j++) br.read(32);
  }
  if (br.bit()) {
    while (br.bit()) {
      if (br.bit()) br.read(5);
      else br.read(10);
    }
  }
  br.end();
  state.models = new Map(resources.filter((x) => x.type === 'model').map((x) => [x.index, x.name]));
  state.sounds = new Map(resources.filter((x) => x.type === 'sound').map((x) => [x.index, x.name]));
  state.eventScripts = new Map(resources.filter((x) => x.type === 'eventscript').map((x) => [x.index, x.name]));
  on.resources?.(resources, state);
}

function tempEntity(r, state, on) {
  const type = r.u8();
  if (type === 13) {
    r.skip(8);
    if (r.i16() !== 0) r.skip(2);
    return;
  }
  if (type === 29) {
    r.skip(5);
    const effect = r.u8();
    r.skip(8 + 6);
    if (effect === 2) r.skip(2);
    r.string();
    return;
  }
  const size = TEMP_ENTITY_BYTES[type];
  if (size === undefined) throw new DemoDesync(`Unknown temp entity ${type} at ${r.at - 1}.`);
  // Read first: `on.x?.(r.bytes())` reads nothing when nobody listens.
  const data = r.bytes(size);
  on.tempEntity?.(type, data, state);
}
