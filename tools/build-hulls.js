// The game data of each level for the play page (spec 11): assets/levels/<map>.hull.bin holds the hulls of a point,
// the standing and the ducked player (src/shared/game/hull.js), and <map>.play.json the spawns. The levels of CS 1.6
// that differ from their 1.5 namesakes go to assets/levels16, as tools/build-levels.js does.
// Usage: node tools/build-hulls.js [map...]

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readBsp } from './lib/bsp.js';
import { hullOf } from './lib/walk.js';
import { writeHulls } from '../src/shared/game/hull.js';

// Brush entities that stop a player. A door is closed until the game moves doors (spec 11, section 4).
const SOLID = /^(func_wall|func_wall_toggle|func_breakable|func_door|func_door_rotating|func_button|func_rot_button|func_pushable|func_rotating|func_train|func_tracktrain|func_plat|func_plat_rot|momentary_door|momentary_rot_button|func_vehicle|func_pendulum|func_conveyor)$/;
const SPAWNS = { info_player_start: 'CT', info_player_deathmatch: 'T' };

const vector = (text) => (text ?? '0 0 0').trim().split(/\s+/).map(Number);

/**
 * Each ladder with the side a player climbs it from: `normal` points out of its open face, the side of its thin
 * axis where a standing player fits along most of its height.
 */
function laddersOf(bsp, boxes) {
  const hull = hullOf(bsp, { solidEntities: SOLID });
  return boxes.map((l) => {
    const size = [0, 1].map((k) => l.maxs[k] - l.mins[k]);
    const axis = size[0] < size[1] ? 0 : 1;
    const mid = [(l.mins[0] + l.maxs[0]) / 2, (l.mins[1] + l.maxs[1]) / 2];
    const room = (sign) => {
      let n = 0;
      for (let z = l.mins[2] + 36; z <= l.maxs[2]; z += 16) {
        const p = [...mid, z];
        p[axis] = (sign > 0 ? l.maxs[axis] : l.mins[axis]) + sign * 17;
        if (hull.free(p)) n++;
      }
      return n;
    };
    const sign = room(1) >= room(-1) ? 1 : -1;
    const normal = [0, 0, 0];
    normal[axis] = sign;
    return { ...l, normal };
  });
}

/** The hulls and the play facts of one BSP. */
export function playData(bsp) {
  // Hull 0 is the tree of nodes and leaves: its nodes follow the clip nodes, a leaf child becomes its contents.
  const offset = bsp.clipnodes.length;
  const pointNodes = bsp.nodes.map((n) => ({ plane: n.plane, children: n.children.map((c) => (c >= 0 ? c + offset : bsp.leafs[-c - 1].contents)) }));
  const model = (m, origin) => ({ head0: m.headNodes[0] + offset, head1: m.headNodes[1], head3: m.headNodes[3], origin, mins: m.mins, maxs: m.maxs });
  const models = [model(bsp.models[0], [0, 0, 0])];
  // The doors, with the index of their hull model and the keys of their movement (src/shared/game/doors.js).
  const doors = [];
  // The breakables (vents, hatches, windows, crates), with the index of their hull model (src/shared/game/breakables.js).
  const breakables = [];
  for (const e of bsp.entities) {
    const m = /^\*(\d+)$/.exec(e.model ?? '');
    if (!m || !SOLID.test(e.classname)) continue;
    models.push(model(bsp.models[Number(m[1])], vector(e.origin)));
    if (e.classname === 'func_breakable') {
      const bm = bsp.models[Number(m[1])];
      const o = vector(e.origin);
      breakables.push({
        hull: models.length - 1, model: Number(m[1]), health: Number(e.health ?? 1), material: Number(e.material ?? 0),
        flags: Number(e.spawnflags ?? 0), mins: bm.mins.map((v, k) => v + o[k]), maxs: bm.maxs.map((v, k) => v + o[k]),
        // What breaks it by name: a bomb site's target (bomb.js).
        name: e.targetname ?? null,
        // Not drawn solid (rendermode: glass, a grate): a grenade's touch breaks it (grenade.js touch).
        ...(Number(e.rendermode ?? 0) !== 0 && { see: true }),
      });
    }
    if (/^(func_door|func_door_rotating|momentary_door)$/.test(e.classname)) {
      const bm = bsp.models[Number(m[1])];
      doors.push({
        hull: models.length - 1, model: Number(m[1]), rotating: e.classname === 'func_door_rotating',
        origin: vector(e.origin), mins: bm.mins, maxs: bm.maxs, angle: e.angle !== undefined ? Number(e.angle) : null,
        angles: e.angles ? vector(e.angles) : null, speed: Number(e.speed ?? 100), lip: Number(e.lip ?? 0),
        wait: Number(e.wait ?? 3), distance: Number(e.distance ?? 90), flags: Number(e.spawnflags ?? 0),
        name: e.targetname ?? null, sound: Number(e.movesnd ?? 0), stop: Number(e.stopsnd ?? 0),
      });
    }
  }
  // The volumes of the game's rules: the bomb sites, the buy zones and the ladders, as boxes in world units.
  const boxesOf = (classname) => bsp.entities.filter((e) => e.classname === classname && /^\*\d+$/.test(e.model ?? '')).map((e) => {
    const m = bsp.models[Number(e.model.slice(1))];
    const o = vector(e.origin);
    return { mins: m.mins.map((v, k) => v + o[k]), maxs: m.maxs.map((v, k) => v + o[k]) };
  });
  const parameters = bsp.entities.find((e) => e.classname === 'info_map_parameters');
  const spawns = bsp.entities.filter((e) => SPAWNS[e.classname]).map((e) => ({
    // Older maps give the yaw alone in "angle".
    side: SPAWNS[e.classname], origin: vector(e.origin), yaw: e.angles ? vector(e.angles)[1] : Number(e.angle ?? 0),
  }));
  const play = {
    spawns,
    solidModels: models.length - 1,
    // A site names what its bomb's blast fires (the breakables of that name break).
    bombTargets: boxesOf('func_bomb_target').map((z, i) => ({ ...z, target: bsp.entities.filter((e) => e.classname === 'func_bomb_target' && /^\*\d+$/.test(e.model ?? ''))[i].target ?? null })),
    // A map without a brush site names a point; the game takes 256 units around it.
    bombPoints: bsp.entities.filter((e) => e.classname === 'info_bomb_target').map((e) => vector(e.origin)),
    // A buy zone's team: 1 T, 2 CT, 0 both or not named (economy.js finds the side by the spawns in it).
    buyZones: boxesOf('func_buyzone').map((z, i) => ({ ...z, team: Number(bsp.entities.filter((e) => e.classname === 'func_buyzone' && /^\*\d+$/.test(e.model ?? ''))[i].team ?? 0) })),
    ladders: laddersOf(bsp, boxesOf('func_ladder')),
    doors,
    breakables,
    // The areas that open a named door when a player stands in them, and the buttons that open one with use.
    triggers: bsp.entities.filter((e) => /^(trigger_multiple|trigger_once|func_button)$/.test(e.classname) && e.target && /^\*\d+$/.test(e.model ?? '')).map((e) => {
      const bm = bsp.models[Number(e.model.slice(1))];
      return { kind: e.classname === 'func_button' ? 'use' : 'touch', target: e.target, mins: bm.mins, maxs: bm.maxs };
    }),
    bombRadius: Number(parameters?.bombradius) || 500,
    // The lamps that glow (env_glow, and an env_sprite that draws a glow): where, how large and in what colour.
    glows: bsp.entities.filter((e) => (e.classname === 'env_glow' || e.classname === 'env_sprite') && /glow|flare/.test(e.model ?? '') && e.origin).map((e) => ({
      origin: vector(e.origin), scale: Number(e.scale ?? 1) || 1, color: e.rendercolor && e.rendercolor !== '0 0 0' ? vector(e.rendercolor) : [255, 255, 255],
      amount: Number(e.renderamt ?? 255) || 255,
      // The sprite's own name (sprites/glow01.spr -> glow01): the page draws it with that strip when it has it.
      sprite: (e.model ?? '').replace(/^sprites\//, '').replace(/\.spr$/, '') || null,
    })),
    // The level's own sounds that play from the start (ambient_generic not "start silent"): the file, where, how
    // loud (0 to 1), how far it carries (the engine's attenuation; null plays everywhere), and whether it loops
    // ("not toggled" is one that plays once).
    ambients: bsp.entities.filter((e) => e.classname === 'ambient_generic' && e.message && !(Number(e.spawnflags ?? 0) & 16)).map((e) => {
      const flags = Number(e.spawnflags ?? 0);
      return {
        sound: e.message.toLowerCase().replace(/\\/g, '/'), origin: vector(e.origin), volume: Math.max(0, Math.min(1, Number(e.health ?? 10) / 10)),
        attenuation: flags & 1 ? null : flags & 2 ? 2 : flags & 4 ? 1.25 : 0.8, loop: !(flags & 32),
      };
    }),
  };
  return { hulls: writeHulls({ models, planes: bsp.planes, clipnodes: [...bsp.clipnodes, ...pointNodes] }), play };
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
      // A 1.6 level that 1.6 kept as it was: the page reads the 1.5 files.
      if (same && existsSync(`${same}/${file}`) && bytes.equals(readFileSync(`${same}/${file}`))) {
        rmSync(`${out}/${map}.hull.bin`, { force: true });
        rmSync(`${out}/${map}.play.json`, { force: true });
        continue;
      }
      const { hulls, play } = playData(readBsp(bytes));
      writeFileSync(`${out}/${map}.hull.bin`, Buffer.from(hulls));
      writeFileSync(`${out}/${map}.play.json`, `${JSON.stringify({ map, ...play })}\n`);
      console.log(`${out}/${map}: ${hulls.byteLength} bytes, ${play.spawns.length} spawns, ${play.bombTargets.length} bomb sites, ${play.ladders.length} ladders`);
    }
  }
}
