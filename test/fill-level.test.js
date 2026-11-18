import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVis } from '../src/fill/vis.js';
import { levelFit } from '../tools/lib/fill-level.js';
import { twoRoomBsp } from './fill-world.js';

// The recorder (1) stands at x 0. The demo holds player 2 at x 100 in every row.
const timeline = () => ({
  recorder: 1,
  eyes: [[0, 0, 0, 17]],
  samples: Array.from({ length: 40 }, (_, k) => [k / 10, 1, 0, 0, 0, 0, 4, 2, 100, 0, 0, 0, 0]),
});

test('a level fits a POV demo when the players that the demo holds lie in the set of its recorder', () => {
  // The wall at x 144: both stand in one room.
  assert.equal(levelFit(timeline(), { vis: readVis(twoRoomBsp(144, false)) }), 1);
  // Another build of the map, with a wall at x 50 between them: the server of that build would not have sent
  // player 2.
  assert.equal(levelFit(timeline(), { vis: readVis(twoRoomBsp(50, false)) }), 0);
});

test('a dead player and an estimate do not count for the fit, and a timeline with no eye fits', () => {
  const tl = timeline();
  for (const row of tl.samples) row[12] = 1;
  assert.equal(levelFit(tl, { vis: readVis(twoRoomBsp(50, false)) }), 1);
  assert.equal(levelFit({ ...timeline(), eyes: [] }, { vis: readVis(twoRoomBsp(50, false)) }), 1);
});
