// The level that src/fill needs for a timeline: the walk graph, the clip hulls, the spawns and the visibility data.
// CS 1.6 demos take the 1.6 build of a map where it differs (assets/levels16, assets/maps16).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readHulls } from '../../src/shared/game/hull.js';
import { readNav } from '../../src/shared/game/nav.js';
import { fatPvs, leafAt, playerSeen, readVis } from '../../src/fill/vis.js';
import { ESTIMATE } from '../../src/shared/estimates.js';
import { playData } from '../build-hulls.js';
import { navOf } from '../build-nav.js';
import { readBsp } from './bsp.js';
import { writeNav } from '../../src/shared/game/nav.js';
import { isCs16 } from '../../src/shared/cs16.js';

const levels = new Map();

/** {nav, hull, vis, spawns} of one build of a map ('' the CS 1.5 files, '16' the CS 1.6 ones); null when a file is missing. */
function levelOfSet(map, set, assets) {
  const key = `${assets}/${set}/${map}`;
  if (levels.has(key)) return levels.get(key);
  const root = `${assets}/levels${set}/${map}`;
  const bsp = `${assets}/maps${set}/${map}.bsp`;
  let level = null;
  if (existsSync(`${root}.hull.bin`) && existsSync(`${root}.nav.bin`) && existsSync(bsp)) {
    const bin = (file) => {
      const b = readFileSync(file);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    };
    level = {
      map,
      key: `${map}${set}`,
      nav: readNav(bin(`${root}.nav.bin`)),
      hull: readHulls(bin(`${root}.hull.bin`)),
      vis: readVis(readFileSync(bsp)),
      spawns: JSON.parse(readFileSync(`${root}.play.json`, 'utf8')).spawns,
    };
  }
  levels.set(key, level);
  return level;
}

// The share of the seen players that must lie in the computed set of the recorder: under it the level is another
// build than the one of the match, and the fill would walk through its walls.
const FITS = 0.95;

/**
 * The share of the players that a POV timeline holds that lie in the set of the recorder's eye on this level
 * (about 0.98 on the right build of a map); 1 for a timeline with no eye.
 */
export function levelFit(timeline, level) {
  const eyes = timeline.eyes ?? [];
  if (!eyes.length) return 1;
  const set = new Uint8Array(level.vis.rowBytes);
  const step = Math.max(1, Math.floor(timeline.samples.length / 1500));
  let at = -1;
  let seen = 0;
  let inSet = 0;
  for (let r = 0; r < timeline.samples.length; r += step) {
    const row = timeline.samples[r];
    while (at + 1 < eyes.length && eyes[at + 1][0] <= row[0]) at++;
    if (at < 0) continue;
    const eye = eyes[at].slice(1, 4);
    if (leafAt(level.vis, eye) === 0) continue;
    fatPvs(level.vis, eye, set);
    for (let i = 1; i < row.length; i += 6) {
      if (row[i] === timeline.recorder || (row[i + 5] & 1) || (row[i + 5] & ESTIMATE)) continue;
      seen++;
      if (playerSeen(level.vis, set, [row[i + 1], row[i + 2], row[i + 3]], (row[i + 5] & 8) !== 0)) inSet++;
    }
  }
  return seen ? inSet / seen : 1;
}

// A map that the player holds only under another name, with the same walls.
const SAME_WALLS = { de_clan1_mill: 'de_cpl_mill' };

/** The map whose level serves a timeline: its own, else for a POV demo the map of the same walls (levelFit judges it). */
export function levelMapOf(timeline, assets = 'assets') {
  const other = SAME_WALLS[timeline.map];
  if (!other || timeline.source?.kind !== 'pov' || existsSync(`${assets}/levels/${timeline.map}.hull.bin`)) return timeline.map;
  return other;
}

/**
 * {nav, hull, vis, spawns} of a timeline's map; null when a file of the level is missing. A map with two builds
 * (CS 1.5 and CS 1.6) gives the one that fits a POV timeline better; null when neither fits it (FITS).
 */
export function fillLevelOf(timeline, assets = 'assets') {
  const map = levelMapOf(timeline, assets);
  const v16 = isCs16(timeline);
  const both = existsSync(`${assets}/levels16/${map}.hull.bin`);
  const first = levelOfSet(map, v16 && both ? '16' : '', assets);
  if (timeline.source?.kind !== 'pov' || !first) return first;
  const fit = levelFit(timeline, first);
  if (fit >= FITS) return first;
  const other = both ? levelOfSet(map, v16 ? '' : '16', assets) : null;
  return other && levelFit(timeline, other) >= FITS ? other : null;
}

/**
 * The level of the fill from the bytes of a BSP alone: the hulls, the walk graph, the spawns and the visibility
 * data are computed here, as tools/build-hulls.js and tools/build-nav.js write them for the player.
 */
export function fillLevelFromBsp(bytes, map = 'level') {
  const bsp = readBsp(bytes);
  const { hulls, play } = playData(bsp);
  return { map, key: map, id: levelIdOf(bytes), nav: readNav(writeNav(navOf(bsp, play.ladders))), hull: readHulls(hulls), vis: readVis(bytes), spawns: play.spawns };
}

// The lumps of a BSP that say where a player can be: planes, nodes, clip nodes, leaves and models.
const SHAPE_LUMPS = [1, 5, 9, 10, 14];

/**
 * The id of a level: 16 hex digits of a hash of the lumps that hold its shape. Two files of one map with other
 * textures or entities have one id; another build of the map (other walls) has another. A routes file names the
 * id of its level: routes of one build are no use on another.
 */
export function levelIdOf(bytes) {
  const hash = createHash('sha256');
  for (const n of SHAPE_LUMPS) hash.update(bytes.subarray(bytes.readInt32LE(4 + n * 8), bytes.readInt32LE(4 + n * 8) + bytes.readInt32LE(8 + n * 8)));
  return hash.digest('hex').slice(0, 16);
}
