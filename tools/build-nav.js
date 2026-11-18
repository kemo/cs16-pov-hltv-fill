// The navigation graph of each level for the bots (spec 11, section 7): assets/levels/<map>.nav.bin
// (src/shared/game/nav.js). A floor every 32 units in the hull of a standing player, with the solid brush entities
// of the game; its walks to the floors around it (a step of 18 up, 20 down), the drops off a ledge (down to 250, one
// way), the jumps up onto one (to 54 with the legs up, one way) and the ladders (foot to top, both ways). 1.6 levels as
// tools/build-hulls.js writes them.
// Usage: node tools/build-nav.js [map...]

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readBsp } from './lib/bsp.js';
import { floors, hullOf, steps } from './lib/walk.js';
import { DROP, JUMP, LADDER, WALK, writeNav } from '../src/shared/game/nav.js';
import { playData } from './build-hulls.js';

// The game's solid brush entities (tools/build-hulls.js), without the doors: a bot walks up to a door and it opens.
const SOLID = /^(func_wall|func_wall_toggle|func_breakable|func_button|func_rot_button|func_pushable|func_rotating|func_train|func_tracktrain|func_plat|func_plat_rot|momentary_rot_button|func_vehicle|func_pendulum|func_conveyor)$/;
const CELL = 32;
const STEP = 18;
const FALL = 250;
const JUMP_UP = 54;
const AROUND = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Where a fall from (x, y, z) first stops, as the floor node of that column; -1 where none. */
function landing(free, x, y, z, limit) {
  let at = z;
  while (at > z - limit && free([x, y, at - 4])) at -= 4;
  if (at <= z - limit) return -1;
  const column = landing.byCell?.get(`${x},${y}`) ?? [];
  return column.find((k) => Math.abs(landing.nodes[k][2] - at) < 6) ?? -1;
}

/** The graph of one BSP and its ladders (build-hulls.js play data): {nodes: [[x, y, z]], edges: [[[to, kind]]]}. */
export function navOf(bsp, ladders = []) {
  const hull = hullOf(bsp, { solidEntities: SOLID });
  const grid = floors(hull);
  const walks = steps(hull, grid);
  const { nodes, byCell } = grid;
  landing.byCell = byCell;
  landing.nodes = nodes;
  const edges = nodes.map((a, i) => {
    const out = walks[i].map((to) => [to, WALK]);
    const has = new Set(walks[i]);
    for (const [ox, oy] of AROUND) {
      const bx = a[0] + ox * CELL;
      const by = a[1] + oy * CELL;
      for (const k of byCell.get(`${bx},${by}`) ?? []) {
        if (has.has(k)) continue;
        const b = nodes[k];
        const down = a[2] - b[2];
        // Off the ledge: the space beside it at its height is open, and a fall there lands on b.
        // A scan down in steps, not a search: a column can hold two floors, and the fall stops at the first.
        if (down > STEP && down <= FALL && hull.free([bx, by, a[2]]) && landing(hull.free, bx, by, a[2], down + 8) === k) out.push([k, DROP]);
        // Up onto it: room over a at b's height, and over the edge between them.
        const up = -down;
        if (up > STEP && up <= JUMP_UP && hull.free([a[0], a[1], b[2] + 2]) && hull.free([(a[0] + bx) / 2, (a[1] + by) / 2, b[2] + 2])) out.push([k, JUMP]);
      }
    }
    return out;
  });
  // A ladder joins the floor at its foot and the floor at its top, both ways.
  for (const m of ladders) {
    // The floors in front of its open face, where a climber stands.
    const mid = [(m.mins[0] + m.maxs[0]) / 2 + m.normal[0] * 24, (m.mins[1] + m.maxs[1]) / 2 + m.normal[1] * 24];
    const near = (z, reach, rise) => {
      let best = -1;
      let bestD = Infinity;
      nodes.forEach((n, k) => {
        const d = Math.hypot(n[0] - mid[0], n[1] - mid[1]);
        if (d > reach || Math.abs(n[2] - z) > rise) return;
        if (d + Math.abs(n[2] - z) < bestD) {
          bestD = d + Math.abs(n[2] - z);
          best = k;
        }
      });
      return best;
    };
    const foot = near(m.mins[2] + 36, 64, 40);
    const top = near(m.maxs[2] + 36, 96, 60);
    if (foot < 0 || top < 0 || foot === top) continue;
    edges[foot].push([top, LADDER]);
    edges[top].push([foot, LADDER]);
  }
  return { nodes, edges };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const SETS = [['assets/maps', 'assets/levels', null], ['assets/maps16', 'assets/levels16', 'assets/maps']];
  const selected = process.argv.slice(2);
  for (const [maps, out, same] of SETS) {
    if (!existsSync(maps)) continue;
    for (const file of readdirSync(maps).filter((f) => f.endsWith('.bsp')).sort()) {
      const map = file.slice(0, -4);
      if (selected.length && !selected.includes(map)) continue;
      const bytes = readFileSync(`${maps}/${file}`);
      if (same && existsSync(`${same}/${file}`) && bytes.equals(readFileSync(`${same}/${file}`))) {
        rmSync(`${out}/${map}.nav.bin`, { force: true });
        continue;
      }
      const started = Date.now();
      const bsp = readBsp(bytes);
      const nav = navOf(bsp, playData(bsp).play.ladders);
      const buffer = writeNav(nav);
      writeFileSync(`${out}/${map}.nav.bin`, Buffer.from(buffer));
      const count = (kind) => nav.edges.reduce((n, list) => n + list.filter((e) => e[1] === kind).length, 0);
      console.log(`${out}/${map}: ${nav.nodes.length} floors, ${count(WALK)} walks, ${count(DROP)} drops, ${count(JUMP)} jumps, ${count(LADDER)} ladder ways, ${buffer.byteLength} bytes, ${Date.now() - started} ms`);
    }
  }
}
