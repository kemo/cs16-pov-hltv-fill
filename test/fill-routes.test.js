import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TICK, guidesFor, lookAt, packRoutes, placeOf, pointsNear, readRoutes, routesOf } from '../src/fill/routes.js';

/** An HLTV timeline of one round of 20 s: player 1 (T) runs along x from 0, player 2 (CT) along y from 1000. */
function hltv() {
  const samples = [];
  for (let k = 0; k <= 200; k++) {
    const t = k / 10;
    const run = Math.max(0, t - 2) * 100;
    samples.push([t, 1, run, 0, 0, 450, 0, 2, 1000, run, 0, 0, 4]);
  }
  return {
    version: 8, source: { kind: 'hltv' }, duration: 20, samples, sides: [[0, 1, 'T'], [0, 2, 'CT']],
    rounds: [{ t: 0, kind: 'start', seconds: 2 }, { t: 2, kind: 'start', seconds: 120 }],
  };
}
const routes = () => readRoutes(packRoutes(['a', 'b'], [routesOf(hltv()), routesOf(hltv())]));

test('a timeline gives one route for each life, on the clock of its round', () => {
  const list = routesOf(hltv());
  assert.equal(list.length, 2);
  const t = list.find((r) => r.side === 0);
  // The round goes live at 2 s: the first point, 0.5 s after the restart, is 1.5 s before that.
  assert.equal(t.k0, -3);
  assert.deepEqual(t.points[0], [0, 0, 0, 450]);
  assert.deepEqual(t.points[3 + 4], [200, 0, 0, 450], '2 s after the round went live');
});

test('the routes come back from their bytes, and a source can stay out', () => {
  const all = routes();
  assert.equal(all.n, 4);
  assert.deepEqual(all.sources, ['a', 'b']);
  assert.deepEqual([...placeOf(all, 0, 7)], [200, 0, 0]);
  assert.deepEqual([...placeOf(all, 0, 7.5)], [225, 0, 0]);
  const near = [];
  pointsNear(all, 0, [200, 0, 0], 30, (r, i, d) => near.push([r, i, d]));
  assert.deepEqual(near, [[0, 7, 0], [2, 7, 0]]);
  const without = readRoutes(packRoutes(['a', 'b'], [routesOf(hltv()), routesOf(hltv())]), (id) => id === 'a');
  const left = [];
  pointsNear(without, 0, [200, 0, 0], 30, (r) => left.push(r));
  assert.deepEqual(left, [2]);
});

test('a player first known at a place follows a real player that came there from its spawn', () => {
  const [guide] = guidesFor(routes(), { side: 0, a: null, b: { x: 510, y: 10, z: 0, at: 6 }, until: 6 });
  // The real player was at 500 after 5 s: the hidden one is a second later, so it waited a second longer.
  assert.deepEqual([...guide.at(0, [0, 0, 0])], [0, 0, 0]);
  assert.deepEqual([...guide.at(3, [0, 0, 0])], [200, 0, 0]);
  assert.deepEqual([...guide.at(6, [0, 0, 0])], [500, 0, 0]);
  assert.equal(guide.yawAt(3), 450, 'the yaw of the real player');
  assert.equal(guidesFor(routes(), { side: 1, a: null, b: { x: 510, y: 10, z: 0, at: 6 }, until: 6 }).length, 0, 'no CT was there');
});

test('a player between two known places follows a real player that went the same way in the same time', () => {
  const guides = guidesFor(routes(), { side: 0, a: { x: 300, y: 0, z: 0, at: 30 }, b: { x: 700, y: 0, z: 0, at: 34 }, until: 34, limit: 1 });
  assert.equal(guides.length, 1);
  assert.deepEqual([...guides[0].at(32, [0, 0, 0])], [500, 0, 0]);
  // Twice the time for the same way: no real player went so slowly.
  assert.equal(guidesFor(routes(), { side: 0, a: { x: 300, y: 0, z: 0, at: 30 }, b: { x: 700, y: 0, z: 0, at: 38 }, until: 38 }).length, 0);
});

test('a player with nothing known gets each whole round of a real player once, however many it asks for', () => {
  // Three real T players start their rounds; a hidden one asks for 40 guides.
  const whole = (y) => ({ side: 0, round: 1, k0: 0, points: Array.from({ length: 60 }, (_, k) => [k * 100, y, 0, 0]) });
  const three = readRoutes(packRoutes(['a'], [[whole(0), whole(500), whole(1000)]]));
  const guides = guidesFor(three, { side: 0, a: null, b: null, until: 20, limit: 40, seed: 7 });
  assert.deepEqual(guides.map((g) => g.route).sort(), [0, 1, 2]);
});

test('a player with no later known place goes on as a real player did, for some seconds', () => {
  const used = new Set([0]);
  const [guide] = guidesFor(routes(), { side: 0, a: { x: 300, y: 0, z: 0, at: 3 }, b: null, until: 15, heading: [1, 0], used });
  assert.equal(guide.route, 2, 'the route that another player follows stays out');
  assert.deepEqual([...guide.at(5, [0, 0, 0])], [500, 0, 0]);
  assert.deepEqual([...guide.at(14, [0, 0, 0])], [800, 0, 0], 'it stops after 5 s');
  assert.equal(guidesFor(routes(), { side: 0, a: { x: 300, y: 0, z: 0, at: 3 }, b: null, until: 15, heading: [-1, 0] })[0].route, 0);
  assert.equal(TICK, 0.5);
});

test('the small form of a routes file gives the same routes on a grid of 4 units, and names no source', async () => {
  const { shrinkRoutes } = await import('../src/fill/routes.js');
  const raw = packRoutes(['match one', 'match two'], [routesOf(hltv()), routesOf(hltv())], { map: 'de_test', level: 'abc' });
  const small = shrinkRoutes(raw, { quality: 5 });
  assert.ok(small.length < raw.length / 4, `${small.length} of ${raw.length} bytes`);
  const [a, b] = [readRoutes(raw), readRoutes(small)];
  assert.deepEqual([b.map, b.level, b.n], ['de_test', 'abc', a.n]);
  assert.deepEqual(b.sources, ['0', '1']);
  assert.deepEqual([...b.k0], [...a.k0]);
  assert.deepEqual([...b.round], [...a.round]);
  for (let i = 0; i < a.points.length; i++) assert.ok(Math.abs(a.points[i] - b.points[i]) <= 2, `point ${i}: ${a.points[i]} and ${b.points[i]}`);
  for (let i = 0; i < a.yaws.length; i++) assert.ok(Math.abs(a.yaws[i] - b.yaws[i]) <= 40, `yaw ${i}`);
  assert.deepEqual([...b.count], [...a.count]);
  // With the names kept, the measure can still leave a match out.
  assert.deepEqual(readRoutes(shrinkRoutes(raw, { names: true, quality: 5 })).sources, ['match one', 'match two']);
});

/**
 * A POV timeline of one round of 20 s. The recorder 1 (T) runs along x. Its teammate 2 is on the radar once a
 * second, along y from 500. The enemy 3 (CT) is seen for 3 s only.
 */
function pov() {
  const samples = [];
  const radar = [];
  for (let k = 0; k <= 200; k++) {
    const t = k / 10;
    const run = Math.max(0, t - 2) * 100;
    const row = [t, 1, run, 0, 0, 450, 0];
    if (t >= 10 && t < 13) row.push(3, 3000, run, 0, 0, 4);
    samples.push(row);
    if (k % 10 === 0) radar.push([t, 2, 500, run, 0]);
  }
  return {
    version: 9, source: { kind: 'pov' }, recorder: 1, duration: 20, samples, radar, kills: [],
    sides: [[0, 1, 'T'], [0, 2, 'T'], [0, 3, 'CT']],
    rounds: [{ t: 0, kind: 'start', seconds: 2 }, { t: 2, kind: 'start', seconds: 120 }],
  };
}

test('a POV timeline gives the routes of its recorder and of the teammates on its radar, and none of an enemy', () => {
  const list = routesOf(pov());
  assert.equal(list.length, 2);
  assert.ok(list.every((r) => r.side === 0));
  const [own, mate] = list;
  assert.deepEqual(own.points[3 + 4], [200, 0, 0, 450], 'the recorder, 2 s after the round went live');
  // Between two radar rows the teammate goes the straight way, and it looks where it goes (along y: 90 degrees).
  const [x, y, , yaw] = mate.points[3 + 5];
  assert.deepEqual([x, yaw], [500, 900]);
  assert.ok(Math.abs(y - 250) <= 25, `2.5 s after the round went live, at ${y}`);
});

test('the route of a teammate ends when the recorder dies: the radar stops', () => {
  const tl = pov();
  tl.kills = [{ t: 12, killer: 3, victim: 1 }];
  tl.samples = tl.samples.map((row) => (row[0] >= 12 ? [row[0], 1, row[2], 0, 0, 450, 1, ...row.slice(7)] : row));
  const [own, mate] = routesOf(tl);
  // Twice a second from 0.5 s: the teammate to under 12 s, the recorder with its last living sample.
  assert.equal(mate.points.length, 23);
  assert.equal(own.points.length, 24);
});

test('a filled POV timeline gives no routes: an estimate is no real way', () => {
  assert.throws(() => routesOf({ ...pov(), fill: { version: 5 } }), /without the estimates/);
});

test('a place where real players stand has the yaw that they look along; a place they only pass has none', () => {
  // In the freeze of two rounds the T player stands at 0, 0 and looks along 45 degrees.
  const r = routes();
  assert.equal(lookAt(r, 0, 0, 0, 0), 450);
  assert.equal(lookAt(r, 0, 10, -20, 0), 450, 'the same cell');
  // It runs through 800, 0 and never stands there; the CT player never stands at 0, 0.
  assert.equal(lookAt(r, 0, 800, 0, 0), null);
  assert.equal(lookAt(r, 1, 0, 0, 0), null);
  assert.equal(lookAt(r, 1, 1000, 0, 0), 0);
});
