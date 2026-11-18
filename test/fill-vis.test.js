import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fatPvs, holds, leafAt, pasOf, playerSeen, pvsOf, readVis } from '../src/fill/vis.js';
import { twoRoomBsp } from './fill-world.js';

test('a point has the leaf of its side of the plane', () => {
  const vis = readVis(twoRoomBsp(0, false));
  assert.equal(leafAt(vis, [100, 0, 0]), 1);
  assert.equal(leafAt(vis, [-100, 0, 0]), 2);
});

test('a room that sees only itself hides a player in the other room', () => {
  const vis = readVis(twoRoomBsp(0, false));
  const set = fatPvs(vis, [100, 0, 0]);
  assert.equal(holds(set, 1), true);
  assert.equal(holds(set, 2), false);
  assert.equal(playerSeen(vis, set, [200, 0, 0]), true);
  assert.equal(playerSeen(vis, set, [-200, 0, 0]), false);
});

test('a player whose box reaches into a seen room is seen', () => {
  const vis = readVis(twoRoomBsp(0, false));
  const set = fatPvs(vis, [100, 0, 0]);
  // The box is 16 wide, and the server grows it by one unit.
  assert.equal(playerSeen(vis, set, [-16, 0, 0]), true);
  assert.equal(playerSeen(vis, set, [-18, 0, 0]), false);
});

test('an eye within 8 units of a plane takes the sets of both sides', () => {
  const vis = readVis(twoRoomBsp(0, false));
  assert.equal(holds(fatPvs(vis, [7, 0, 0]), 2), true);
  assert.equal(holds(fatPvs(vis, [9, 0, 0]), 2), false);
});

test('rooms that see each other hear each other', () => {
  const open = readVis(twoRoomBsp(0, true));
  assert.deepEqual([...pvsOf(open, 1)], [3]);
  assert.deepEqual([...pasOf(open, 2)], [3]);
  const shut = readVis(twoRoomBsp(0, false));
  assert.deepEqual([...pasOf(shut, 2)], [2]);
});
