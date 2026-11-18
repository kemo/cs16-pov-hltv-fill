// The routes files of the fill on disk: one file for each build of a map, named by the map and the id of its
// level (levelIdOf()), in the small form of src/fill/routes.js.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The name of the routes file of a level: "de_dust2.0123456789abcdef.routes". */
export const routesName = (map, id) => `${map.toLowerCase()}.${id}.routes`;

/** The routes file of a level in the first of `dirs` that has it; null when none has. */
export function findRoutes(dirs, map, id) {
  for (const dir of dirs) {
    const file = join(dir, routesName(map, id));
    if (existsSync(file)) return file;
  }
  return null;
}

/** What `dirs` hold: [{map, id, file}], for a message that names the maps with routes. */
export function listRoutes(dirs) {
  const out = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const m = /^(.+)\.([0-9a-f]{16})\.routes$/.exec(name);
      if (m) out.push({ map: m[1], id: m[2], file: join(dir, name) });
    }
  }
  return out;
}
