import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESTIMATE, FILL_VERSION, fillTimeline, handsOf, pace, posesOf } from '../src/fill/fill.js';
import { readVis } from '../src/fill/vis.js';
import { gridNav, twoRoomBsp } from './fill-world.js';

// Two rooms side by side, ten cells by three: x up to 128 is the left room, from 160 on the right one. Neither
// sees the other.
const { nav } = gridNav(['..........', '..........', '..........']);
const level = (extra = {}) => ({ nav, hull: null, vis: readVis(twoRoomBsp(144, false)), spawns: [], ...extra });
const CT = 4;
const PITCH = 900 << 4;
const sample = (entity, x, y, flags = 0) => [entity, x, y, 0, 0, flags | PITCH];
const rowOf = (row, entity) => {
  for (let i = 1; i + 5 < row.length; i += 6) if (row[i] === entity) return row.slice(i, i + 6);
  return null;
};

/** A POV timeline of 6 s, ten rows a second: the recorder (1, CT) stands in the left room. */
function timeline(others, extra = {}) {
  const samples = [];
  for (let k = 0; k <= 60; k++) {
    const t = k / 10;
    samples.push([t, ...sample(1, 0, 32, CT), ...others(t).flat()]);
  }
  return {
    version: 8, source: { kind: 'pov' }, map: 'test', duration: 6, recorder: 1, samples,
    sides: [[0, 1, 'CT'], [0, 2, 'T'], [0, 3, 'T']], rounds: [], kills: [], attribs: [], sounds: [], soundNames: [], corpses: [],
    eyes: [[0, 0, 32, 17]], radar: [], fires: [], ...extra,
  };
}

// Player 2 walks out of the left room after 1 s and is back at 5 s.
const walker = (t) => (t <= 1 ? [sample(2, 96 + t * 32, 32)] : t >= 5 ? [sample(2, 128 - (t - 5) * 32, 32)] : []);

test('a hidden player gets an estimated sample in every row of its span', () => {
  const tl = timeline(walker);
  const out = fillTimeline(tl, level());
  assert.equal(out.fill.version, FILL_VERSION);
  assert.deepEqual(out.estimates, [{ entity: 2, t0: 1, t1: 5, kind: 'between' }]);
  for (const row of out.samples) {
    const p = rowOf(row, 2);
    assert.ok(p, `a row at ${row[0]}`);
    assert.equal((p[5] & ESTIMATE) !== 0, row[0] > 1 && row[0] < 5, `the flag at ${row[0]}`);
  }
  assert.equal(tl.samples[20].length, 7, 'the input keeps its rows');
});

test('an estimate never leaps and stays out of the recorder sight', () => {
  const out = fillTimeline(timeline(walker), level());
  let last = null;
  for (const row of out.samples) {
    const p = rowOf(row, 2);
    if (last) assert.ok(Math.hypot(p[1] - last[1], p[2] - last[2]) <= 26, `a step of ${Math.hypot(p[1] - last[1], p[2] - last[2])} at ${row[0]}`);
    last = p;
    // A second from the ends of the span (the grace and one step), the box is clear of the left room: it is 16
    // wide and the server grows it by one unit.
    if (row[0] > 2 && row[0] < 4) assert.ok(p[1] >= 144 + 17, `x ${p[1]} at ${row[0]}`);
  }
});

test('a hint puts the hidden player at its place at its time', () => {
  const out = fillTimeline(timeline(walker, { radar: [[3, 2, 288, 64, 0]] }), level());
  assert.deepEqual(out.estimates.map((s) => [s.entity, s.t0, s.t1, s.kind]), [[2, 1, 3, 'hint'], [2, 3, 5, 'hint']]);
  const p = rowOf(out.samples[30], 2);
  assert.deepEqual(p.slice(1, 3), [288, 64]);
});

test('a spray logo of a hidden player puts the player on the floor nearest to the logo', () => {
  // Player 2 is hidden from 1 s to 5 s and sprays on the wall of the right room at 3 s, 40 units over the floor.
  const out = fillTimeline(timeline(walker, { sprays: [[3, 2, 300, 70, 40]] }), level());
  assert.deepEqual(out.estimates.map((s) => [s.entity, s.t0, s.t1, s.kind]), [[2, 1, 3, 'hint'], [2, 3, 5, 'hint']]);
  assert.deepEqual(rowOf(out.samples[30], 2).slice(1, 4), [288, 64, 0]);
});

test('a player that the demo never shows comes from a spawn of its side to its first hint', () => {
  const extra = { rounds: [{ t: 0, kind: 'start', seconds: 100 }], fires: [[4, 3, 160, 0, 0, 900, 0]] };
  const out = fillTimeline(timeline(walker, extra), level({ spawns: [{ side: 'CT', origin: [0, 0, 0] }, { side: 'T', origin: [288, 64, 0] }] }));
  assert.deepEqual(rowOf(out.samples[0], 3).slice(1, 3), [288, 64]);
  assert.deepEqual(rowOf(out.samples[40], 3).slice(1, 3), [160, 0]);
  assert.equal(rowOf(out.samples[40], 3)[4], 900, 'the yaw of the shot');
});

test('a logo sprayed in the freeze is no place of a way: its player stands on its spawn point then', () => {
  const extra = { rounds: [{ t: 0, kind: 'start', seconds: 100 }], fires: [[4, 3, 160, 0, 0, 900, 0]], sprays: [[0.2, 3, 250, 90, 30]] };
  const out = fillTimeline(timeline(walker, extra), level({ spawns: [{ side: 'CT', origin: [0, 0, 0] }, { side: 'T', origin: [288, 64, 0] }] }));
  // One way from the spawn to the first hint, with no stop at the floor under the logo.
  assert.deepEqual(out.estimates.filter((e) => e.entity === 3).map((e) => [e.t0, e.t1, e.kind]), [[0, 4, 'start'], [4, 6, 'end']]);
  assert.deepEqual(rowOf(out.samples[0], 3).slice(1, 3), [288, 64]);
});

test('with no sure spawn point, a logo sprayed in the freeze says near which spawn its player stands', () => {
  // Nobody of the T side stands on a point, so the order gives none. Player 3 sprays beside one of three points.
  const spawns = [{ side: 'CT', origin: [0, 0, 0] }, { side: 'T', origin: [288, 0, 0] }, { side: 'T', origin: [96, 64, 0] }, { side: 'T', origin: [192, 64, 0] }];
  const startOf = (logo) => {
    const extra = { rounds: [{ t: 0, kind: 'start', seconds: 100 }], fires: [[4, 3, 160, 0, 0, 900, 0]], sprays: [[0.2, 3, ...logo]] };
    return rowOf(fillTimeline(timeline(walker, extra), level({ spawns })).samples[0], 3).slice(1, 3);
  };
  assert.deepEqual(startOf([420, -20, 10]), [288, 0]);
  assert.deepEqual(startOf([-40, 80, 10]), [96, 64]);
});

test('a hidden player starts on the spawn point that the order of the game gives it', () => {
  const extra = { rounds: [{ t: 0, kind: 'start', seconds: 100 }], fires: [[4, 3, 160, 0, 0, 900, 0]] };
  // Player 2 stands on the first T point at the restart, so player 3, the next entity of the side, has the
  // second one. The third point is nearer to the first hint of player 3: without the order, its way starts there.
  const spawns = [{ side: 'CT', origin: [0, 32, 0] }, { side: 'T', origin: [96, 32, 0] }, { side: 'T', origin: [288, 64, 0] }, { side: 'T', origin: [288, 0, 0] }];
  const out = fillTimeline(timeline(walker, extra), level({ spawns }));
  assert.deepEqual(rowOf(out.samples[0], 3).slice(1, 3), [288, 64]);
  assert.equal(out.fill.spawns, 1);
  // No T player stands on a point: nothing says which of three points player 3 has.
  const other = fillTimeline(timeline(walker, extra), level({ spawns: [spawns[0], spawns[2], spawns[3], { side: 'T', origin: [288, 32, 0] }] }));
  assert.equal(other.fill.spawns, 0);
});

test('a slot that does not play takes no spawn point: the next player has the point after the last one that plays', () => {
  // Slot 3 has the T side and never plays (a referee); player 4 fires a shot, so it plays.
  const extra = { rounds: [{ t: 0, kind: 'start', seconds: 100 }], sides: [[0, 1, 'CT'], [0, 2, 'T'], [0, 3, 'T'], [0, 4, 'T']], fires: [[4, 4, 160, 0, 0, 900, 0]] };
  const spawns = [{ side: 'CT', origin: [0, 32, 0] }, { side: 'T', origin: [96, 32, 0] }, { side: 'T', origin: [288, 64, 0] }, { side: 'T', origin: [288, 0, 0] }];
  const out = fillTimeline(timeline(walker, extra), level({ spawns }));
  assert.deepEqual(rowOf(out.samples[0], 4).slice(1, 3), [288, 64]);
  assert.equal(rowOf(out.samples[0], 3), null);
});

test('a slot with a side that never plays gets no estimate: a referee, a spectator on a side', () => {
  // Player 3 has a side and nothing else. One radar row and a sound are no proof of play.
  const extra = { rounds: [{ t: 0, kind: 'start', seconds: 100 }], radar: [[2, 3, 160, 0, 0]], sounds: [[3, 0, 3, 160, 0, 0]], soundNames: ['player/pl_step1.wav'] };
  const out = fillTimeline(timeline(walker, extra), level({ spawns: [{ side: 'CT', origin: [0, 0, 0] }, { side: 'T', origin: [288, 64, 0] }] }));
  assert.ok(out.samples.every((row) => rowOf(row, 3) === null));
  assert.ok(out.estimates.every((e) => e.entity !== 3));
  // Player 2 plays: the demo shows it.
  assert.ok(out.estimates.some((e) => e.entity === 2));
});

test('a slot plays in each part of a joined match on its own proof', () => {
  // Two parts of 3 s. Player 3 shoots only in the second: it has no estimate in the first.
  const extra = {
    recorders: [[0, 1], [3, 1]], fires: [[5, 3, 160, 0, 0, 900, 0]],
    rounds: [{ t: 0, kind: 'start', seconds: 100 }, { t: 2.9, kind: 'end', winner: 'CT' }, { t: 3, kind: 'start', seconds: 100 }],
  };
  const out = fillTimeline(timeline(walker, extra), level({ spawns: [{ side: 'CT', origin: [0, 0, 0] }, { side: 'T', origin: [288, 64, 0] }] }));
  assert.equal(rowOf(out.samples[15], 3), null);
  assert.ok(rowOf(out.samples[55], 3));
});

test('a dead player gets no estimate after its kill', () => {
  const kills = [{ t: 3, killer: 1, victim: 2 }];
  const out = fillTimeline(timeline((t) => (t <= 1 ? [sample(2, 96 + t * 32, 32)] : []), { kills }), level());
  assert.ok(rowOf(out.samples[25], 2));
  assert.equal(rowOf(out.samples[35], 2), null);
});

test('an HLTV timeline and a filled timeline come back as they are', () => {
  const hltv = { ...timeline(walker), source: { kind: 'hltv' } };
  assert.equal(fillTimeline(hltv, level()), hltv);
  const once = fillTimeline(timeline(walker), level());
  assert.equal(fillTimeline(once, level()), once);
});

test('a hidden player changes its weapon inside its hidden time, not when the demo shows it again', () => {
  const estimates = [{ entity: 2, t0: 10, t1: 20, kind: 'start' }, { entity: 2, t0: 30, t1: 40, kind: 'between' },
    { entity: 3, t0: 30, t1: 34, kind: 'hint' }, { entity: 3, t0: 34, t1: 40, kind: 'hint' }];
  const loadouts = [[5, 2, 'knife'], [20, 2, 'ak47'], [25, 2, 'knife'], [40, 2, 'deagle'], [40, 3, 'awp']];
  const shots = [[36, 3, 'awp', 0], [50, 2, 'deagle', 0]];
  assert.deepEqual(handsOf({ loadouts, shots }, estimates), [
    [5, 2, 'knife'],
    // From the spawn of its round the player holds the weapon it is first seen with.
    [10.1, 2, 'ak47'],
    [25, 2, 'knife'],
    // In the middle of the hidden time; before the first hidden shot with the weapon.
    [35, 2, 'deagle'],
    [35, 3, 'awp'],
  ]);
});

test('a shot of a hidden player puts its weapon into its hand', () => {
  const estimates = [{ entity: 2, t0: 10, t1: 20, kind: 'between' }];
  const out = handsOf({ loadouts: [[5, 2, 'knife'], [30, 2, 'usp']], shots: [[15, 2, 'mp5n', 0], [16, 2, 'mp5n', 0], [40, 2, 'usp', 0]] }, estimates);
  assert.deepEqual(out, [[5, 2, 'knife'], [14.7, 2, 'mp5'], [30, 2, 'usp']]);
});

test('the legs of an estimated player run, walk and stand as its way goes, in the pose of its real rows', () => {
  const point = (t, x) => ({ t, x, y: 0, z: 0 });
  // 250 units a second for a second, then 60, then it stands.
  const way = [point(10, 0), point(11, 250), point(12, 310), point(14, 310)];
  const anims = [[2, 7, 34, 4], [20, 7, 36, 1]];
  assert.deepEqual(posesOf({ anims }, new Map([[7, [way]]])), [
    [2, 7, 34, 4], [10, 7, 34, 4], [11, 7, 34, 3], [12, 7, 34, 1],
    // The demo shows the player again at 14 with no new row: the pose it had is back.
    [14, 7, 34, 4],
    [20, 7, 36, 1],
  ]);
});

test('a player that comes from a spawn takes the pose that the demo first shows, never its death', () => {
  const way = [{ t: 30, x: 0, y: 0, z: 0 }, { t: 34, x: 1000, y: 0, z: 0 }];
  // 104 is a death (the last ten sequences of the model, the top here is 110).
  const anims = [[2, 7, 34, 4], [25, 7, 104, 1], [34, 7, 13, 4], [50, 9, 110, 1]];
  assert.deepEqual(posesOf({ anims }, new Map([[7, [way]]])).filter((row) => row[0] === 30), [[30, 7, 13, 4]]);
});

test('a way takes the time of a fast part out of the wait beside it', () => {
  const point = (t, x) => ({ t, x, y: 0, z: 0 });
  // 400 units in the first second, then a wait of three seconds.
  const way = [point(0, 0), point(1, 400), point(4, 400)];
  pace(way, 250);
  assert.deepEqual(way.map((p) => p.t), [0, 1.6, 4]);
  // The wait comes first: the fast part starts earlier.
  const late = [point(0, 0), point(3, 0), point(4, 400)];
  pace(late, 250);
  assert.deepEqual(late.map((p) => p.t), [0, 2.4, 4]);
});

test('a way with too little time for a run goes at one speed', () => {
  const point = (t, x) => ({ t, x, y: 0, z: 0 });
  const way = [point(0, 0), point(0.1, 300), point(2, 600)];
  pace(way, 250);
  assert.deepEqual(way.map((p) => p.t), [0, 1, 2]);
});

test('a player that the game moved (a respawn) gets no way into the leap, and its hints before it stay', () => {
  // Player 2 is hidden from 1 s, a radar row shows it at 3 s, and at 5 s it stands 2000 units away.
  const leaper = (t) => (t <= 1 ? [sample(2, 96 + t * 32, 32)] : t >= 5 ? [sample(2, 96, 2000)] : []);
  const out = fillTimeline(timeline(leaper, { radar: [[3, 2, 288, 64, 0]] }), level());
  assert.deepEqual(out.estimates.map((s) => [s.t0, s.t1]), [[1, 3]]);
  assert.equal(rowOf(out.samples[40], 2), null);
});

test('where the demo holds no player at all, the recorder set hides nobody', () => {
  // The first three seconds have no packets: rows with a time only. A radar row puts player 2 in the recorder's
  // own room, and the way to it goes straight through that room.
  const tl = timeline((t) => (t >= 5 ? [sample(2, 128 - (t - 5) * 32, 32)] : []), { radar: [[0.5, 2, 32, 64, 0], [2.5, 2, 96, 64, 0]] });
  for (const row of tl.samples) if (row[0] < 3) row.length = 1;
  const out = fillTimeline(tl, level());
  for (const k of [8, 15, 22]) {
    const p = rowOf(out.samples[k], 2);
    assert.ok(p && p[1] >= 32 && p[1] <= 96 && p[2] === 64, `at ${k / 10} s the player is at ${p?.slice(1, 3)}: on the line of the two radar rows`);
  }
});

test('the rows of a short time between a hint and the next seen sample hold the player', () => {
  // Player 2 is hidden from 1 s. A radar row shows it at 4.8 s, and the demo shows it again at 5 s.
  const out = fillTimeline(timeline(walker, { radar: [[4.8, 2, 160, 32, 0]] }), level());
  assert.deepEqual(out.estimates.map((s) => [s.t0, s.t1]), [[1, 4.8], [4.8, 5]]);
  const p = rowOf(out.samples[49], 2);
  assert.ok(p && (p[5] & ESTIMATE), 'the row at 4.9 s');
  assert.ok(p[1] > 128 && p[1] < 160, `x ${p[1]} between the hint and the seen sample`);
});

test('a hint inside the recorder set opens the set for its spans: the way does not leave it and come back', () => {
  // The demo holds the recorder all the time and never player 2. Two radar rows put player 2 in the recorder's
  // own room, 3 s apart.
  const out = fillTimeline(timeline(() => [], { radar: [[1, 2, 32, 64, 0], [4, 2, 96, 64, 0]] }), level());
  for (const k of [15, 25, 35]) {
    const p = rowOf(out.samples[k], 2);
    assert.ok(p && p[1] >= 32 && p[1] <= 96, `at ${k / 10} s the player is at x ${p?.[1]}: between the two radar rows`);
  }
});

test('the most typical guide comes first: the one nearest to the others', async () => {
  const { typical } = await import('../src/fill/fill.js');
  // Three real players go along y = 0, 40 and 80; the best fit of the ends (first in the list) goes far round.
  const line = (y) => ({ at: (seconds, to) => Object.assign(to, [seconds * 100, y, 0]) });
  const round = { at: (seconds, to) => Object.assign(to, [seconds * 100, 2000, 0]) };
  const [a, b, c] = [line(0), line(40), line(80)];
  assert.deepEqual(typical([round, a, b, c], 0, 10), [b, a, c, round]);
  // Two guides have no middle: their order stays.
  assert.deepEqual(typical([round, a], 0, 10), [round, a]);
});

test('the guides that the demo contradicts go: one in the recorder set, one that runs where the recorder hears', async () => {
  const { leastFaults } = await import('../src/fill/fill.js');
  // Three real players for a span of 10 s: one stands at x 64, one at x 192, one runs along y 64.
  const stand = (x) => ({ at: (seconds, to) => Object.assign(to, [x, 32, 0]) });
  const run = { at: (seconds, to) => Object.assign(to, [Math.min(288, seconds * 200), 64, 0]) };
  const [left, right] = [stand(64), stand(192)];
  const span = { nav, clock: (t) => t, t0: 0, t1: 10 };
  // The recorder would have got a player in the left room from the server: the one that stands there goes.
  const seenAt = (node) => nav.xyz[node * 3] <= 128;
  assert.deepEqual(leastFaults([left, right], { ...span, seenAt, heardAt: null }), [right]);
  // The recorder hears the whole floor: the runner goes, the two that stand make no sound.
  assert.deepEqual(leastFaults([left, right, run], { ...span, seenAt: null, heardAt: () => true }), [left, right]);
  // Every guide has a fault: the ones with the fewest seconds of it stay.
  assert.equal(leastFaults([left, stand(96)], { ...span, seenAt, heardAt: null }).length, 2);
  // No clue at all: the guides stay as they are.
  assert.deepEqual(leastFaults([left, right], { ...span, seenAt: null, heardAt: null }), [left, right]);
});
