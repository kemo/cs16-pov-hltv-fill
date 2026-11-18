import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { levelIdOf } from '../tools/lib/fill-level.js';
import { findRoutes, listRoutes, routesName } from '../tools/lib/fill-routes.js';
import { twoRoomBsp } from './fill-world.js';

test('the id of a level names its shape: the same for the same walls, another for another build', () => {
  const id = levelIdOf(twoRoomBsp(144, false));
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(levelIdOf(twoRoomBsp(144, false)), id);
  // The visibility is no part of the shape: a file with other lighting or entities is the same level.
  assert.equal(levelIdOf(twoRoomBsp(144, true)), id);
  assert.notEqual(levelIdOf(twoRoomBsp(50, false)), id);
});

test('a routes file is found by its map and the id of its level, in the first folder that has it', () => {
  const [own, shipped] = [mkdtempSync(join(tmpdir(), 'routes-')), mkdtempSync(join(tmpdir(), 'routes-'))];
  try {
    assert.equal(routesName('De_Dust2', '0123456789abcdef'), 'de_dust2.0123456789abcdef.routes');
    writeFileSync(join(shipped, routesName('de_dust2', '0123456789abcdef')), '');
    writeFileSync(join(shipped, routesName('de_nuke', 'aaaaaaaaaaaaaaaa')), '');
    writeFileSync(join(own, routesName('de_nuke', 'aaaaaaaaaaaaaaaa')), '');
    assert.equal(findRoutes([own, shipped], 'de_dust2', '0123456789abcdef'), join(shipped, 'de_dust2.0123456789abcdef.routes'));
    assert.equal(findRoutes([own, shipped], 'de_nuke', 'aaaaaaaaaaaaaaaa'), join(own, 'de_nuke.aaaaaaaaaaaaaaaa.routes'));
    // Another build of the map has another id: its routes are not these.
    assert.equal(findRoutes([own, shipped], 'de_dust2', 'ffffffffffffffff'), null);
    assert.deepEqual(listRoutes([shipped, join(shipped, 'none')]).map((r) => [r.map, r.id]), [['de_dust2', '0123456789abcdef'], ['de_nuke', 'aaaaaaaaaaaaaaaa']]);
  } finally {
    rmSync(own, { recursive: true });
    rmSync(shipped, { recursive: true });
  }
});
