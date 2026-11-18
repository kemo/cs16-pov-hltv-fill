import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BitReader, Reader } from '../src/goldsrc/bits.js';
import { DT, readDelta } from '../src/goldsrc/delta.js';
import { directoryOf, frames, readHeader } from '../src/goldsrc/frames.js';
import { DemoState, SVC, readBlock } from '../src/goldsrc/messages.js';
import { buildTimeline } from '../src/timeline.js';
import { ESTIMATE } from '../src/shared/estimates.js';
import { BitWriter } from '../src/dem/bits.js';
import { writeDelta } from '../src/dem/delta.js';
import { writePacketEntities } from '../src/dem/entities.js';
import { NOTICE, placeAt, writeFilledDemo } from '../src/dem/write.js';
import { Bits, TABLES, clientData, demo, loading, marker, netFrame, povDemo, svcTime, teamInfo } from './goldsrc-fixture.js';

/** A state without its zero fields: the client starts each new entity from zeros, so a zero that a delta leaves out is the same. */
const plain = (e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== 0));

/** The entity sets of each playback frame, and the messages that the callbacks of `on` collect. */
function decode(buf, on = {}) {
  const header = readHeader(buf);
  const state = new DemoState(header.netProtocol);
  const sets = [];
  for (const frame of frames(buf, header)) {
    if (!frame.view) continue;
    state.sequence = frame.sequence;
    readBlock(frame.data, state, on);
    if (frame.type === 1) sets.push(new Map([...state.entities].map(([k, e]) => [k, plain(e)])));
  }
  return sets;
}

const origin = (e) => [e['origin[0]'] ?? 0, e['origin[1]'] ?? 0, e['origin[2]'] ?? 0];
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

test('a delta that the writer writes reads back as the same values', () => {
  const table = [
    { name: 'a', type: DT.FLOAT | DT.SIGNED, bits: 18, divisor: 32, post: 1 },
    { name: 'b', type: DT.ANGLE, bits: 16, divisor: 1, post: 1 },
    { name: 'c', type: DT.TIMEWINDOW_8, bits: 8, divisor: 1, post: 1 },
    { name: 'd', type: DT.STRING, bits: 1, divisor: 1, post: 1 },
    { name: 'e', type: DT.INTEGER, bits: 10, divisor: 1, post: 1 },
    { name: 'f', type: DT.FLOAT, bits: 16, divisor: 256, post: 1 },
  ];
  const from = { a: 1, b: 90, e: 5 };
  const to = { a: -1234.5, b: 270.0054931640625, c: -0.05, d: Buffer.from('x'), e: 5, f: 1.5 };
  const bw = new BitWriter();
  writeDelta(bw, table, from, to);
  const back = readDelta(new BitReader(new Reader(Buffer.from(bw.bytes()))), table, from);
  assert.deepEqual({ ...back, d: back.d.toString() }, { ...to, d: 'x' });
});

test('the copy of a demo with no estimate decodes to the same entities, and the original stays as it was', () => {
  const buf = povDemo({ count: 6 });
  const before = sha(buf);
  const { demo: copy } = writeFilledDemo(buf, null);
  assert.equal(sha(buf), before);
  assert.deepEqual(decode(copy), decode(buf));
  // The directory moves with the frames and still spans them.
  const at = directoryOf(readHeader(copy), copy);
  assert.equal(copy.readUInt32LE(at + 4 + 84), 544);
  assert.equal(copy.readUInt32LE(at + 4 + 88), at - 544);
});

test('an estimated player is in the copy where the fill put it, and only where the demo does not hold it', () => {
  const buf = povDemo({ count: 10 });
  const frameTimes = [];
  const tl = buildTimeline(buf, { frameTimes });
  // Player 3 is hidden: estimated from 1.2 s to 1.5 s; at 1.6 s an estimate of player 2 is ignored, as the demo holds it.
  const est = (t, entity, x) => [t, entity, x, 100, 0, 900, ESTIMATE | (900 << 4)];
  const samples = tl.samples.map((row) => {
    const t = row[0];
    const extra = t >= 1.2 && t <= 1.5 ? est(t, 3, (t - 1.2) * 1000).slice(1) : [];
    return [...row, ...extra];
  });
  samples[6].push(...est(1.6, 2, 0).slice(1));
  const filled = { ...tl, samples };
  const prints = [];
  const { demo: copy, added } = writeFilledDemo(buf, filled, { frameTimes });
  const sets = decode(copy, { print: (text) => prints.push(text.toString('latin1')) });
  assert.equal(added, 4);
  for (const [i, set] of sets.entries()) {
    const t = 1 + i * 0.1;
    if (t > 1.15 && t < 1.55) {
      const x = Math.round((t - 1.2) * 1000);
      assert.deepEqual(origin(set.get(3)).map(Math.round), [x, 100, 0]);
      assert.equal(Math.round(set.get(3)['angles[1]']), 90);
    } else {
      assert.equal(set.has(3), false, `no player 3 at ${t}`);
    }
    assert.deepEqual(origin(set.get(2)), [500, 500, 0]);
  }
  assert.deepEqual(prints, [NOTICE]);
});

test('an event that names its entity by its place in the packet names the same entity in the copy', () => {
  // The packet holds players 1 and 3: the event names player 3 by place 1. The copy adds player 2 before it.
  const packet = () => {
    const bits = new Bits();
    bits.write(1, 1).write(0, 1).write(0, 1);
    bits.write(0, 3);
    bits.write(0, 1).write(0, 1).write(2, 6).write(0, 1).write(0, 1);
    bits.write(1, 3).write(1, 8).signed(300 * 8, 24);
    bits.write(0, 16);
    return Buffer.concat([Buffer.from([SVC.PACKETENTITIES, 2, 0]), bits.bytes()]);
  };
  const event = Buffer.concat([Buffer.from([SVC.EVENT]), new Bits().write(1, 5).write(0, 10).write(1, 1).write(1, 11).write(0, 1).write(0, 1).bytes()]);
  const body = [loading({ players: ['alpha', 'bravo', 'charlie'] }), marker(5), marker(2)];
  for (let i = 0; i < 4; i++) {
    body.push(netFrame(1, 1 + i * 0.1, [svcTime(99 + i * 0.1), ...(i === 0 ? [teamInfo(1, 'TERRORIST'), teamInfo(2, 'CT'), teamInfo(3, 'CT')] : []),
      clientData({ 'origin[0]': 0 }), packet(), event], { sequence: i }));
  }
  const buf = demo(body);
  const frameTimes = [];
  const tl = buildTimeline(buf, { frameTimes });
  const filled = { ...tl, samples: tl.samples.map((row) => [...row, 2, 50, 50, 0, 0, ESTIMATE]) };
  const { demo: copy } = writeFilledDemo(buf, filled, { frameTimes });
  const named = [];
  const sets = decode(copy, { event: (ev) => named.push(ev.entity) });
  assert.ok(sets.every((set) => set.has(2) && set.has(3)));
  assert.deepEqual(named, [3, 3, 3, 3]);
});

test('a delta packet of the copy starts from the copy\'s own frame', () => {
  // Frame 0 is a full packet of player 1; frames 1 to 3 are deltas from the frame before that move it.
  const delta = (from, x) => {
    const bits = new Bits();
    bits.write(0, 1).write(0, 1).write(1, 6).write(0, 1);
    bits.write(1, 3).write(1, 8).signed(x * 8, 24);
    bits.write(0, 16);
    return Buffer.concat([Buffer.from([SVC.DELTAPACKETENTITIES, 1, 0, from]), bits.bytes()]);
  };
  const full = () => {
    const bits = new Bits().write(1, 1).write(0, 1).write(0, 1).write(0, 3).write(0, 16);
    return Buffer.concat([Buffer.from([SVC.PACKETENTITIES, 1, 0]), bits.bytes()]);
  };
  const body = [loading(), marker(5), marker(2)];
  for (let i = 0; i < 4; i++) {
    body.push(netFrame(1, 1 + i * 0.1, [svcTime(99 + i * 0.1), ...(i === 0 ? [teamInfo(1, 'TERRORIST'), teamInfo(2, 'CT')] : []),
      clientData({ 'origin[0]': 0 }), i === 0 ? full() : delta(i - 1, i * 10)], { sequence: i }));
  }
  const buf = demo(body);
  const frameTimes = [];
  const tl = buildTimeline(buf, { frameTimes });
  // Player 2 is estimated in frames 1 and 2 only: the copy adds it, then removes it.
  const filled = { ...tl, samples: tl.samples.map((row, i) => (i === 1 || i === 2 ? [...row, 2, 70 * i, 0, 0, 0, ESTIMATE] : row)) };
  const { demo: copy } = writeFilledDemo(buf, filled, { frameTimes });
  const sets = decode(copy);
  assert.deepEqual(sets.map((set) => set.get(1)['origin[0]'] ?? 0), [0, 10, 20, 30]);
  assert.deepEqual(sets.map((set) => set.get(2)?.['origin[0]'] ?? null), [null, 70, 140, null]);
  assert.equal(TABLES.entity_state_player_t.length, 4);
});

test('the place of an estimated track takes the line between its samples, and nothing across a gap', () => {
  const track = [[1, 0, 0, 0, 3590, 0], [1.1, 10, 0, 0, 10, 0], [2, 100, 0, 0, 0, 0]];
  assert.deepEqual(placeAt(track, 1.05).slice(1, 5), [5, 0, 0, 3600]);
  assert.equal(placeAt(track, 1.5), null);
  assert.equal(placeAt(track, 2.01)[1], 100);
  assert.equal(placeAt(track, 0.5), null);
});

test('a field that the demo sent goes again in the copy, even when its value did not change', () => {
  // A time window is new on each send: the client sets it from the time of the packet.
  const state = new DemoState(47);
  state.maxClients = 4;
  state.deltas.tables.set('entity_state_player_t', [
    { name: 'animtime', type: DT.TIMEWINDOW_8, bits: 8, divisor: 1, post: 1 },
    { name: 'origin[0]', type: DT.FLOAT | DT.SIGNED, bits: 18, divisor: 32, post: 1 },
  ]);
  const from = new Map([[1, { animtime: 0, 'origin[0]': 5 }]]);
  const sentOf = (sent) => {
    const to = new Map([[1, { animtime: 0, 'origin[0]': 5 }]]);
    if (sent) to.sent = new Map([[1, sent]]);
    const back = new DemoState(47);
    back.maxClients = 4;
    back.deltas = state.deltas;
    back.history.set(0, from);
    back.sequence = 1;
    let got = null;
    readBlock(writePacketEntities(state, to, { from, fromSequence: 0 }), back, { entities: (next) => { got = next; } });
    return got.sent.get(1) ?? null;
  };
  assert.deepEqual(sentOf(['animtime']), ['animtime']);
  // A field that nobody sent and that did not change stays out, and so does the entity.
  assert.equal(sentOf(null), null);
});
