import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearOf, nodeAt, secondsFrom } from '../src/fill/graph.js';
import { findWay } from '../src/fill/way.js';
import { gridNav } from './fill-world.js';

// A wall with one door at the top: the way from the left to the right goes round it.
const WORLD = [
  '.........',
  '....#....',
  '....#....',
  '....#....',
  '....#....',
];

test('the seconds to a floor follow the way round a wall', () => {
  const { nav, at } = gridNav(WORLD);
  const seconds = secondsFrom(nav, at(0, 4));
  assert.ok(Math.abs(seconds[at(3, 4)] - 96 / 250) < 1e-6);
  // Up to the door, through it and down again: longer than the straight 256 units.
  assert.ok(seconds[at(8, 4)] > 1.5);
  assert.equal(secondsFrom(nav, at(8, 4), { back: true })[at(0, 4)], seconds[at(8, 4)]);
});

test('the floors near a floor come with their seconds, and a point has its floor', () => {
  const { nav, at } = gridNav(WORLD);
  const near = nearOf(nav, at(0, 0), 0.2);
  assert.equal(near.nodes[0], at(0, 0));
  assert.deepEqual([...near.nodes].sort(), [at(0, 0), at(1, 0), at(0, 1), at(1, 1)].sort());
  assert.equal(nodeAt(nav, [70, 30, 0]), at(2, 1));
});

test('a way fits its time: it starts and ends at the known floors and never passes the wall', () => {
  const { nav, at } = gridNav(WORLD);
  const way = findWay(nav, { starts: [{ node: at(0, 4), cost: 0 }], end: at(8, 4), t0: 10, t1: 14 });
  assert.equal(way.steps[0].node, at(0, 4));
  assert.equal(way.steps.at(-1).node, at(8, 4));
  assert.equal(way.steps[0].t, 10);
  assert.ok(Math.abs(way.steps.at(-1).t - 14) < 1e-9);
  for (let i = 1; i < way.steps.length; i++) {
    const [p, q] = [way.steps[i - 1].node, way.steps[i].node];
    const d = Math.hypot(nav.xyz[p * 3] - nav.xyz[q * 3], nav.xyz[p * 3 + 1] - nav.xyz[q * 3 + 1]);
    assert.ok(d < 46, 'each step is one cell');
    assert.ok(way.steps[i].t >= way.steps[i - 1].t);
  }
});

test('no way when the time is too short, and a faster player gets one', () => {
  const { nav, at } = gridNav(WORLD);
  const ends = { starts: [{ node: at(0, 4), cost: 0 }], end: at(8, 4), t0: 0, t1: 1 };
  assert.equal(findWay(nav, ends), null);
  assert.ok(findWay(nav, { ...ends, speed: 2 }));
});

test('a way stays out of the places that the recorder sees', () => {
  const { nav, at } = gridNav(['.....', '.....', '.....']);
  // The middle row is in sight: the way from the left to the right takes another row.
  const seenAt = (node) => nav.xyz[node * 3 + 1] === 32 && nav.xyz[node * 3] > 0 && nav.xyz[node * 3] < 128;
  const way = findWay(nav, { starts: [{ node: at(0, 1), cost: 0 }], end: at(4, 1), t0: 0, t1: 2, seenAt });
  assert.equal(way.seen, 0);
  assert.ok(way.steps.slice(1, -1).every((s) => !seenAt(s.node)));
});

test('a way follows the cost of the places, and nobody moves in the freeze', () => {
  const { nav, at } = gridNav(['.....', '.....', '.....']);
  const costOf = (node) => (nav.xyz[node * 3 + 1] === 64 ? 0 : 5);
  const way = findWay(nav, { starts: [{ node: at(0, 0), cost: 0 }], end: at(4, 0), t0: 0, t1: 6, costOf, goAt: 2 });
  assert.ok(way.steps.some((s) => nav.xyz[s.node * 3 + 1] === 64), 'the cheap row is on the way');
  assert.ok(way.steps.filter((s) => s.t <= 2).every((s) => s.node === at(0, 0)));
});

test('nobody moves in a stretch with no play: the way goes before it and after it', () => {
  const { nav, at } = gridNav(WORLD);
  // 20 s from the left to the right, with no play from second 4 to second 16.
  const way = findWay(nav, { starts: [{ node: at(0, 4), cost: 0 }], end: at(8, 4), t0: 0, t1: 20, still: [[4, 16]] });
  assert.ok(way);
  const inside = way.steps.filter((s) => s.t >= 3.6 && s.t <= 16.4);
  assert.ok(inside.length > 20);
  assert.ok(inside.every((s) => s.node === inside[0].node), 'one floor through the whole stretch');
  assert.equal(way.steps.at(-1).node, at(8, 4));
  // The whole time is such a stretch: no way to another floor.
  assert.equal(findWay(nav, { starts: [{ node: at(0, 4), cost: 0 }], end: at(8, 4), t0: 0, t1: 20, still: [[0, 20]] }), null);
});
