// Small GoldSrc demos for the tests: a bit writer, delta descriptions and the frames around them.

import { DT } from '../src/goldsrc/delta.js';
import { SVC } from '../src/goldsrc/messages.js';

/** Bits least significant first, as the engine writes them. */
export class Bits {
  constructor() {
    this.bits = [];
  }

  write(value, n) {
    for (let i = 0; i < n; i++) this.bits.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }

  signed(value, n) {
    return this.write(value < 0 ? 1 : 0, 1).write(Math.abs(value), n - 1);
  }

  string(text) {
    for (const c of Buffer.from(`${text}\0`, 'latin1')) this.write(c, 8);
    return this;
  }

  bytes() {
    const out = Buffer.alloc(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { out[i >> 3] |= b << (i & 7); });
    return out;
  }
}

/** One delta of `table` ({name, type, bits, divisor}) with the raw `values` by field name. */
export function writeDelta(bits, table, values = {}) {
  const set = table.map((f) => f.name in values);
  const last = set.lastIndexOf(true);
  const maskBytes = last < 0 ? 0 : (last >> 3) + 1;
  bits.write(maskBytes, 3);
  for (let m = 0; m < maskBytes; m++) {
    let mask = 0;
    for (let i = 0; i < 8; i++) if (set[m * 8 + i]) mask |= 1 << i;
    bits.write(mask, 8);
  }
  table.forEach((f, i) => {
    if (!set[i]) return;
    const raw = Math.round(values[f.name] * (f.divisor ?? 1));
    if (f.type & DT.SIGNED) bits.signed(raw, f.bits);
    else bits.write(raw, f.bits);
  });
  return bits;
}

/** svc_deltadescription of a table: each field as a delta of the fixed meta description. */
export function deltaDescription(name, table) {
  const bits = new Bits();
  for (const f of table) {
    bits.write(1, 3).write(0x7f, 8);
    bits.write(f.type >>> 0, 32).string(f.name).write(0, 16).write(4, 8).write(f.bits, 8)
      .write((f.divisor ?? 1) * 4000, 32).write(4000, 32);
  }
  const head = Buffer.concat([Buffer.from([SVC.DELTADESCRIPTION]), Buffer.from(`${name}\0`, 'latin1'), Buffer.alloc(2)]);
  head.writeUInt16LE(table.length, head.length - 2);
  return Buffer.concat([head, bits.bytes()]);
}

const coord = (name) => ({ name, type: DT.FLOAT | DT.SIGNED, bits: 24, divisor: 8 });

/** The tables of the tests: a player's origin and yaw, the client's origin and observer mode. */
export const TABLES = {
  clientdata_t: [coord('origin[0]'), coord('origin[1]'), coord('origin[2]'), { name: 'iuser1', type: DT.INTEGER, bits: 3 }],
  weapon_data_t: [{ name: 'm_iId', type: DT.INTEGER, bits: 5 }],
  entity_state_player_t: [coord('origin[0]'), coord('origin[1]'), coord('origin[2]'), { name: 'angles[1]', type: DT.ANGLE, bits: 16 }],
  entity_state_t: [coord('origin[0]')],
  custom_entity_state_t: [coord('origin[0]')],
};

const TEAMINFO = 100;
const string = (text) => Buffer.from(`${text}\0`, 'latin1');

/** svc_serverinfo of net protocol 46 with the recorder in `slot`. */
export function serverInfo({ slot = 0, maxClients = 4, map = 'de_dust2' } = {}) {
  const head = Buffer.alloc(1 + 4 + 8 + 16 + 3);
  head[0] = SVC.SERVERINFO;
  head.writeInt32LE(46, 1);
  head[29] = maxClients;
  head[30] = slot;
  return Buffer.concat([head, string('cstrike'), string('test server'), string(`maps/${map}.bsp`), string(''), Buffer.from([0])]);
}

export function userInfo(slot, name) {
  return Buffer.concat([Buffer.from([SVC.UPDATEUSERINFO, slot, 1, 0, 0, 0]), string(`\\name\\${name}\\model\\leet`), Buffer.alloc(16)]);
}

export function teamInfo(entity, team) {
  const data = Buffer.concat([Buffer.from([entity]), string(team)]);
  return Buffer.concat([Buffer.from([TEAMINFO, data.length]), data]);
}

export function svcTime(t) {
  const b = Buffer.alloc(5);
  b[0] = SVC.TIME;
  b.writeFloatLE(t, 1);
  return b;
}

/** svc_clientdata: a delta of clientdata_t (from zeros, or from the set of sequence `from`), then the weapons. */
export function clientData(values, { weapons = [], weaponBits = 6, from = null } = {}) {
  const bits = from === null ? new Bits().write(0, 1) : new Bits().write(1, 1).write(from, 8);
  writeDelta(bits, TABLES.clientdata_t, values);
  for (const id of weapons) {
    bits.write(1, 1).write(id, weaponBits);
    writeDelta(bits, TABLES.weapon_data_t, { m_iId: id });
  }
  bits.write(0, 1);
  return Buffer.concat([Buffer.from([SVC.CLIENTDATA]), bits.bytes()]);
}

/** svc_packetentities (full) of player entities: [{number, origin, yaw}]. */
export function packetEntities(players) {
  const bits = new Bits();
  let number = 0;
  for (const p of players) {
    if (p.number === number + 1) bits.write(1, 1);
    else bits.write(0, 1).write(1, 1).write(p.number, 11);
    number = p.number;
    bits.write(0, 1).write(0, 1);
    const values = {};
    if (p.origin) [values['origin[0]'], values['origin[1]'], values['origin[2]']] = p.origin;
    if (p.yaw !== undefined) values['angles[1]'] = (p.yaw * 2 ** 16) / 360;
    writeDelta(bits, TABLES.entity_state_player_t, values);
  }
  bits.write(0, 16);
  const head = Buffer.alloc(3);
  head[0] = SVC.PACKETENTITIES;
  head.writeUInt16LE(players.length, 1);
  return Buffer.concat([head, bits.bytes()]);
}

/** A network frame of `type` (0 loading, 1 playback) at `time`, with the view's origin and the messages. */
export function netFrame(type, time, messages, { origin = [0, 0, 0], sequence = 0 } = {}) {
  const data = Buffer.concat(messages);
  const head = Buffer.alloc(9 + 464 + 4);
  head.writeUInt8(type, 0);
  head.writeFloatLE(time, 1);
  origin.forEach((v, i) => head.writeFloatLE(v, 9 + 4 + i * 4));
  head.writeInt32LE(sequence, 9 + 436);
  head.writeUInt32LE(data.length, 9 + 464);
  return Buffer.concat([head, data]);
}

export function marker(type) {
  const b = Buffer.alloc(9);
  b.writeUInt8(type, 0);
  return b;
}

/** The loading frame: the delta tables, TeamInfo, the server info and the players' user info. */
export function loading({ slot = 0, players = ['alpha', 'bravo'] } = {}) {
  const userMsg = Buffer.alloc(19);
  userMsg.set([SVC.NEWUSERMSG, TEAMINFO, 0xff]);
  userMsg.write('TeamInfo', 3, 'latin1');
  return netFrame(0, 0, [
    ...Object.entries(TABLES).map(([name, table]) => deltaDescription(name, table)),
    userMsg,
    serverInfo({ slot }),
    ...players.map((name, i) => userInfo(i, name)),
  ]);
}

/** A demo of the frames between a loading section and its end; with `directory`, a directory of one entry. */
export function demo(body, { directory = true } = {}) {
  const header = Buffer.alloc(544);
  header.write('HLDEMO', 0, 'latin1');
  header.writeUInt32LE(5, 8);
  header.writeUInt32LE(46, 12);
  header.write('de_dust2', 16, 'latin1');
  header.write('cstrike', 276, 'latin1');
  const frames = Buffer.concat([header, ...body]);
  if (!directory) return frames;
  frames.writeUInt32LE(frames.length, 540);
  const dir = Buffer.alloc(4 + 92);
  dir.writeInt32LE(1, 0);
  dir.writeUInt32LE(544, 4 + 84);
  dir.writeUInt32LE(frames.length - 544, 4 + 88);
  return Buffer.concat([frames, dir]);
}

/** A POV match: playback frames each `step` s with the recorder (slot 0) and one enemy on their sides. */
export function povDemo({ count = 20, step = 0.1, timeAt = (i) => 1 + i * step, serverAt = (i, t) => 99 + t, recorderAt = (i) => [i * 10, 0, 0], iuser1 = () => 0, weapons = [], weaponBits = 6, extra = () => [] } = {}) {
  const body = [loading(), marker(5), marker(2)];
  for (let i = 0; i < count; i++) {
    const t = timeAt(i);
    const at = recorderAt(i);
    body.push(netFrame(1, t, [
      svcTime(serverAt(i, t)),
      ...(i === 0 ? [teamInfo(1, 'TERRORIST'), teamInfo(2, 'CT')] : []),
      clientData({ 'origin[0]': at[0], 'origin[1]': at[1], 'origin[2]': at[2], iuser1: iuser1(i) }, { weapons, weaponBits }),
      packetEntities([{ number: 1, yaw: 90 }, { number: 2, origin: [500, 500, 0], yaw: 180 }]),
      ...extra(i),
    ], { origin: at, sequence: i }));
  }
  body.push(marker(5));
  return demo(body);
}

/** svc_deltapacketentities from the set of sequence `from`, with no entity in it. */
export function emptyDeltaPacket(from) {
  return Buffer.from([41, 0, 0, from, 0, 0]);
}
