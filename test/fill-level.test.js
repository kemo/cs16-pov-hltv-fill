import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVis } from '../src/fill/vis.js';
import { levelFit, levelMapOf } from '../tools/lib/fill-level.js';
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

test('a POV demo of a map with no level of its own takes the level of the map with the same walls', () => {
  const assets = mkdtempSync(join(tmpdir(), 'assets-'));
  const pov = { map: 'de_clan1_mill', source: { kind: 'pov' } };
  assert.equal(levelMapOf(pov, assets), 'de_cpl_mill');
  // An HLTV demo has no eye to judge the fit: it keeps its own map.
  assert.equal(levelMapOf({ map: 'de_clan1_mill', source: { kind: 'hltv' } }, assets), 'de_clan1_mill');
  assert.equal(levelMapOf({ map: 'de_dust2', source: { kind: 'pov' } }, assets), 'de_dust2');
  // Its own level wins when the player has one.
  mkdirSync(join(assets, 'levels'));
  writeFileSync(join(assets, 'levels', 'de_clan1_mill.hull.bin'), '');
  assert.equal(levelMapOf(pov, assets), 'de_clan1_mill');
  rmSync(assets, { recursive: true });
});
