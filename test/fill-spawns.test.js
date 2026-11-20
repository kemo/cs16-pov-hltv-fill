import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packRoutes, readRoutes } from '../src/fill/routes.js';
import { spawnPlan } from '../src/fill/spawns.js';

// Six spawn points of each side in a row, 100 units apart: the T side at y 0, the CT side at y 2000.
const spawns = [
  ...[0, 1, 2, 3, 4, 5].map((k) => ({ side: 'T', origin: [k * 100, 0, 0], yaw: 90 })),
  ...[0, 1, 2, 3, 4, 5].map((k) => ({ side: 'CT', origin: [k * 100, 2000, 0], yaw: 270 })),
];
const level = (extra = {}) => ({ spawns, routes: null, ...extra });
const player = (entity, side, seen = null, first = null) => ({ entity, side, seen, first });
const win = (t0) => ({ t0, round: true });

test('the players that the demo shows on their spawn points give the point of the hidden one', () => {
  const w = win(0);
  // Players 2 and 5 stand on the second and the third point: player 7 is the next in the order of the entities.
  const plan = spawnPlan(level(), [{ win: w, players: [player(2, 'T', [100, 0]), player(5, 'T', [200, 0]), player(7, 'T')] }]);
  const spot = plan.get(w).get(7);
  assert.deepEqual([spot.x, spot.y, spot.yaw], [300, 0, 90]);
  assert.ok(spot.sure > 0.9);
  assert.equal(spot.shown, true);
  // A player of a lower entity has the point before them.
  const before = spawnPlan(level(), [{ win: w, players: [player(1, 'T'), player(2, 'T', [100, 0]), player(5, 'T', [200, 0])] }]);
  assert.equal(before.get(w).get(1).x, 0);
});

test('a restart goes on after the last point of the restart before, around the end of the list', () => {
  const [a, b] = [win(0), win(100)];
  const plan = spawnPlan(level(), [
    { win: a, players: [player(2, 'T', [100, 0]), player(5, 'T', [200, 0]), player(7, 'T', [300, 0])] },
    { win: b, players: [player(2, 'T'), player(5, 'T'), player(7, 'T')] },
  ]);
  assert.deepEqual([2, 5, 7].map((e) => plan.get(b).get(e).x), [400, 500, 0]);
  assert.equal(plan.get(b).get(2).shown, false);
});

test('a restart that the demo does not show moves both sides: the shown side counts it for the hidden side', () => {
  const [a, b] = [win(0), win(100)];
  // The CT players stand on points 0 and 1, then on 4 and 5: one restart between gave them 2 and 3.
  const plan = spawnPlan(level(), [
    { win: a, players: [player(1, 'CT', [0, 2000]), player(3, 'CT', [100, 2000]), player(2, 'T', [100, 0]), player(5, 'T', [200, 0]), player(7, 'T', [300, 0])] },
    { win: b, players: [player(1, 'CT', [400, 2000]), player(3, 'CT', [500, 2000]), player(2, 'T'), player(5, 'T'), player(7, 'T')] },
  ]);
  // The T players took 4, 5, 0 at the hidden restart and 1, 2, 3 at this one.
  assert.deepEqual([2, 5, 7].map((e) => plan.get(b).get(e).x), [100, 200, 300]);
});

test('one restart that the demo holds as two round windows moves no point', () => {
  const [a, b, c] = [win(0), win(0.4), win(100)];
  const ct = (x) => [{ ...player(1, 'CT', [x, 2000]), own: true }, player(3, 'CT', [x + 100, 2000])];
  const plan = spawnPlan(level(), [
    { win: a, players: [...ct(0), player(2, 'T', [100, 0]), player(5, 'T', [200, 0]), player(7, 'T', [300, 0])] },
    { win: b, players: [...ct(0), player(2, 'T'), player(5, 'T'), player(7, 'T')] },
    { win: c, players: [...ct(200), player(2, 'T'), player(5, 'T'), player(7, 'T')] },
  ]);
  // The recorder's side has the same points in the second window: the hidden side has too. Then one restart.
  assert.deepEqual([2, 5, 7].map((e) => plan.get(b).get(e).x), [100, 200, 300]);
  assert.deepEqual([2, 5, 7].map((e) => plan.get(c).get(e).x), [400, 500, 0]);
});

test('the first known place of a hidden player picks the point that real players come from to it at that time', () => {
  // Real players from point 0 run up along x 0, from point 3 along x 300: 250 units a second, a point each 0.5 s.
  const run = (x) => Array.from({ length: 12 }, (_, k) => [x, k * 125, 0, 900]);
  const list = [0, 1, 2, 3, 4].flatMap((round) => [{ side: 0, round, k0: 0, points: run(0) }, { side: 0, round, k0: 0, points: run(300) }]);
  const routes = readRoutes(packRoutes(['a'], [list]));
  const w = win(0);
  const at = (x, seconds) => spawnPlan(level({ routes }), [{ win: w, players: [player(4, 'T', null, { x, y: 500, z: 0, at: seconds })] }]).get(w).get(4);
  // 500 units up after 2 s, on the way of the players from point 3.
  assert.equal(at(300, 2).x, 300);
  assert.equal(at(0, 2).x, 0);
  assert.ok(at(300, 2).sure > 0.4);
  // The same place 4 s later: no real player from a point is there then, so the place says nothing.
  assert.ok(at(300, 6).sure < 0.3);
});

test('a level with no spawn points gives no plan', () => {
  assert.equal(spawnPlan({ spawns: [] }, [{ win: win(0), players: [player(2, 'T')] }]).size, 0);
});
