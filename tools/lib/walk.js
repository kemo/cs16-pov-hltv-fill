// A walk through a level for the map preview, found in the clip hull of a standing player (hull 1): the floors of
// a ground grid, the steps a player can take between them, and a tour over the spawns and the objectives.
// All points are player origins in world units (36 over the feet); the page puts the eye 17 higher.

import { CONTENTS_SOLID, pointContents } from './bsp.js';

const CELL = 32;
// pm_stepsize; a drop of more than DROP in one sub-step is a fall, which a walk does not take.
const STEP = 18;
const DROP = 20;
const SUB = 8;
const CLEAR = 24;
// Brush entities that block a player. Doors open and a player pushes a func_pushable, so a walk goes through them.
const SOLID_ENTITIES = /^(func_wall|func_wall_toggle|func_breakable)$/;
const HULL = 1;
// The 8 neighbours of a cell.
const AROUND = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** A test for "a standing player fits at this origin", with the solid brush entities. */
export function hullOf(bsp, { solidEntities = SOLID_ENTITIES } = {}) {
  const world = bsp.models[0].headNodes[HULL];
  const solids = [];
  for (const e of bsp.entities) {
    const m = /^\*(\d+)$/.exec(e.model ?? '');
    if (m && solidEntities.test(e.classname)) solids.push(bsp.models[Number(m[1])]);
  }
  const free = (p) => {
    if (pointContents(bsp, world, p) === CONTENTS_SOLID) return false;
    for (const s of solids) {
      // The hull of a model is grown by the player's box already; its bounds are not, so grow them here.
      if (p[0] < s.mins[0] - 16 || p[0] > s.maxs[0] + 16 || p[1] < s.mins[1] - 16 || p[1] > s.maxs[1] + 16) continue;
      if (p[2] < s.mins[2] - 36 || p[2] > s.maxs[2] + 36) continue;
      if (pointContents(bsp, s.headNodes[HULL], p) === CONTENTS_SOLID) return false;
    }
    return true;
  };
  return { free, mins: bsp.models[0].mins, maxs: bsp.models[0].maxs };
}

/** The lowest free z at (x, y) at or under a free z, down to `limit`; null when nothing holds the player there. */
export function settle(free, x, y, z, limit) {
  if (free([x, y, z - limit])) return null;
  let lo = z - limit;
  let hi = z;
  while (hi - lo > 0.25) {
    const mid = (lo + hi) / 2;
    if (free([x, y, mid])) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Walks from a to (bx, by) as the player's movement does: up at most STEP at each sub-step, down at most DROP.
 * Gives the z where the walk ends, or null when a wall, a ceiling or a fall stops it.
 */
export function stride(free, a, bx, by) {
  const dx = bx - a[0];
  const dy = by - a[1];
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / SUB));
  let z = a[2];
  for (let i = 1; i <= steps; i++) {
    const x = a[0] + (dx * i) / steps;
    const y = a[1] + (dy * i) / steps;
    if (!free([x, y, z + STEP])) return null;
    const next = settle(free, x, y, z + STEP, STEP + DROP);
    if (next === null) return null;
    z = next;
  }
  return z;
}

/** Every floor of the grid: the origins where a standing player rests, several per column on a level of floors. */
export function floors(hull, { acceptColumn = () => true } = {}) {
  const { free, mins, maxs } = hull;
  const nodes = [];
  const byCell = new Map();
  for (let x = Math.ceil(mins[0] / CELL) * CELL; x <= maxs[0]; x += CELL) {
    for (let y = Math.ceil(mins[1] / CELL) * CELL; y <= maxs[1]; y += CELL) {
      if (!acceptColumn(x, y)) continue;
      let above = false;
      for (let z = maxs[2]; z >= mins[2]; z -= 4) {
        const open = free([x, y, z]);
        if (above && !open) {
          const rest = settle(free, x, y, z + 4, 4);
          if (rest !== null) {
            const key = `${x},${y}`;
            if (!byCell.has(key)) byCell.set(key, []);
            byCell.get(key).push(nodes.length);
            nodes.push([x, y, rest]);
          }
        }
        above = open;
      }
    }
  }
  return { nodes, byCell };
}

/** The steps from each floor to the floors of the cells around it, as lists of node indices. */
export function steps(hull, grid) {
  const { nodes, byCell } = grid;
  return nodes.map((a) => {
    const out = [];
    for (const [ox, oy] of AROUND) {
      const bx = a[0] + ox * CELL;
      const by = a[1] + oy * CELL;
      const there = byCell.get(`${bx},${by}`);
      if (!there) continue;
      const z = stride(hull.free, a, bx, by);
      if (z === null) continue;
      const hit = there.find((k) => Math.abs(nodes[k][2] - z) < 2);
      if (hit !== undefined) out.push(hit);
    }
    return out;
  });
}

/** The node nearest to a point, among the nodes in `allowed`. */
function nearest(nodes, allowed, p) {
  let best = -1;
  let bestD = Infinity;
  for (const k of allowed) {
    const n = nodes[k];
    const d = (n[0] - p[0]) ** 2 + (n[1] - p[1]) ** 2 + ((n[2] - p[2]) * 2) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** The shortest walk from one node to another (A*), as node indices; null when none. */
export function route(nodes, edges, from, to) {
  const dist = (a, b) => Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1], nodes[a][2] - nodes[b][2]);
  const g = new Map([[from, 0]]);
  const back = new Map();
  const open = new Heap();
  open.push(from, dist(from, to));
  const done = new Set();
  while (open.size) {
    const at = open.pop();
    if (at === to) {
      const path = [at];
      while (back.has(path[0])) path.unshift(back.get(path[0]));
      return path;
    }
    if (done.has(at)) continue;
    done.add(at);
    for (const next of edges[at]) {
      // A floor with fewer ways out is near a wall: the walk keeps to the middle of a passage.
      const cost = g.get(at) + dist(at, next) * (1 + (8 - edges[next].length) * 0.15);
      if (cost < (g.get(next) ?? Infinity)) {
        g.set(next, cost);
        back.set(next, at);
        open.push(next, cost + dist(next, to));
      }
    }
  }
  return null;
}

/**
 * Cuts the corners of a grid route: each point goes to the farthest later point that a straight walk reaches, with
 * CLEAR units free on each side, so the eye does not brush the walls.
 */
export function straighten(free, points) {
  const reaches = (a, b, side) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = (-(b[1] - a[1]) / len) * side;
    const ny = ((b[0] - a[0]) / len) * side;
    const from = [a[0] + nx, a[1] + ny, a[2]];
    if (!free(from)) return false;
    const z = stride(free, from, b[0] + nx, b[1] + ny);
    return z !== null && Math.abs(z - b[2]) < 2;
  };
  const out = [points[0]];
  let i = 0;
  while (i < points.length - 1) {
    let j = Math.min(points.length - 1, i + 24);
    for (; j > i + 1; j--) {
      if (reaches(points[i], points[j], 0) && reaches(points[i], points[j], CLEAR) && reaches(points[i], points[j], -CLEAR)) break;
    }
    out.push(points[j]);
    i = j;
  }
  return out;
}

/** A point every CELL units along a straightened route, each at the floor that a walk finds there. */
export function densify(free, points) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const parts = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / CELL));
    let at = a;
    for (let k = 1; k < parts; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / parts;
      const y = a[1] + ((b[1] - a[1]) * k) / parts;
      at = [x, y, stride(free, at, x, y) ?? a[2] + ((b[2] - a[2]) * k) / parts];
      out.push(at);
    }
    out.push(b);
  }
  return out;
}

/** The places of a level that a tour visits: the two spawns and every objective, with a label of the page. */
export function places(bsp) {
  const origin = (e) => e.origin?.split(/\s+/).map(Number);
  const centre = (e) => {
    const m = /^\*(\d+)$/.exec(e.model ?? '');
    if (!m) return origin(e);
    const { mins, maxs } = bsp.models[Number(m[1])];
    return [0, 1, 2].map((k) => (mins[k] + maxs[k]) / 2);
  };
  const mean = (list) => [0, 1, 2].map((k) => list.reduce((s, p) => s + p[k], 0) / list.length);
  const of = (re) => bsp.entities.filter((e) => re.test(e.classname));
  const out = [];
  const t = of(/^info_player_deathmatch$/).map(origin);
  const ct = of(/^info_player_start$/).map(origin);
  if (t.length) out.push({ kind: 't', label: 'T start', at: mean(t) });
  // Only the map's own signs say which site is A: the level does not.
  of(/^(func_bomb_target|info_bomb_target)$/).forEach((e) => out.push({ kind: 'bomb', label: 'Bomb site', at: centre(e) }));
  of(/^hostage_entity$/).forEach((e) => out.push({ kind: 'hostage', label: 'Taoci', at: origin(e) }));
  of(/^(func_hostage_rescue|info_hostage_rescue)$/).forEach((e) => out.push({ kind: 'rescue', label: 'Spašavanje talaca', at: centre(e) }));
  of(/^(func_vip_safetyzone)$/).forEach((e) => out.push({ kind: 'vip', label: 'Izlaz za VIP-a', at: centre(e) }));
  if (ct.length) out.push({ kind: 'ct', label: 'CT start', at: mean(ct) });
  // Hostages stand together: one stop for the group.
  const hostages = out.filter((p) => p.kind === 'hostage');
  if (hostages.length > 1) {
    const group = { kind: 'hostage', label: 'Taoci', at: mean(hostages.map((p) => p.at)) };
    return [...out.filter((p) => p.kind !== 'hostage'), group];
  }
  return out;
}

/**
 * The tour of a level: from the T spawn to the nearest objective, the CT spawn, the other objectives, and back. A
 * level without two objectives that connect (a bhop or a deathmatch map) gets a wander instead: from the spawn to the
 * far ends of what a player reaches from it, and back. Gives {path: [[x, y, z]...], stops: [{label, kind, at}]}
 * (at: an index of path), or null when the spawn reaches too little to walk.
 */
export function tour(bsp) {
  const hull = hullOf(bsp);
  const grid = floors(hull);
  const edges = steps(hull, grid);
  const stops = places(bsp);
  const spawns = stops.filter((p) => p.kind === 't' || p.kind === 'ct');
  if (!spawns.length || !grid.nodes.length) return null;

  // Only floors that a player reaches from a spawn: the tops of walls and the sky are floors too.
  const reach = new Set();
  const queue = spawns.map((p) => nearest(grid.nodes, grid.nodes.keys(), p.at));
  for (const k of queue) reach.add(k);
  while (queue.length) for (const next of edges[queue.pop()]) if (!reach.has(next)) reach.add(next), queue.push(next);
  // A place that no floor near it reaches is not on the map: a target left outside the world, for one.
  const near = [];
  for (const p of stops) {
    p.node = nearest(grid.nodes, reach, p.at);
    const n = grid.nodes[p.node];
    if (p.node >= 0 && Math.hypot(n[0] - p.at[0], n[1] - p.at[1]) < 384 && Math.abs(n[2] - p.at[2]) < 384) near.push(p);
  }

  const visit = (near.length > 1 ? objectives(grid, edges, near) : null) ?? wander(grid, edges, near[0] ?? spawns[0]);
  if (!visit) return null;
  const { order, legs, loops } = visit;
  const path = [];
  const marks = [{ label: order[0].label, kind: order[0].kind, at: 0 }];
  legs.forEach((leg, i) => {
    const points = densify(hull.free, straighten(hull.free, leg.map((k) => grid.nodes[k])));
    for (let k = path.length ? 1 : 0; k < points.length; k++) path.push(points[k].map((v) => Math.round(v * 10) / 10));
    const end = order[i + 1];
    if (end?.label && (i < legs.length - 1 || !loops)) marks.push({ label: end.label, kind: end.kind, at: path.length - 1 });
  });
  return { path, stops: marks, reached: order.filter((p) => p.label).length - (loops ? 1 : 0), places: stops.length, floors: grid.nodes.length };
}

/** The legs over the objectives, or null when fewer than two places connect. */
function objectives(grid, edges, near) {
  const order = [near[0]];
  const left = near.slice(1);
  const legs = [];
  while (left.length) {
    const from = order[order.length - 1];
    let best = null;
    const ct = left.find((p) => p.kind === 'ct');
    const next = order.length === 2 && ct ? [ct] : left.filter((p) => p !== ct || left.length === 1);
    for (const p of next) {
      const leg = route(grid.nodes, edges, from.node, p.node);
      if (leg && (!best || length(grid.nodes, leg) < length(grid.nodes, best.leg))) best = { p, leg };
    }
    if (!best) break;
    order.push(best.p);
    legs.push(best.leg);
    left.splice(left.indexOf(best.p), 1);
  }
  if (order.length < 2) return null;
  const home = route(grid.nodes, edges, order[order.length - 1].node, order[0].node);
  if (!home) return { order, legs, loops: false };
  return { order: [...order, order[0]], legs: [...legs, home], loops: true };
}

/** From the spawn to the floor farthest from it, then to the floor farthest from that one, and back. */
function wander(grid, edges, spawn) {
  const farthest = (from) => {
    const hops = new Map([[from, 0]]);
    const queue = [from];
    let last = from;
    for (let i = 0; i < queue.length; i++) {
      for (const next of edges[queue[i]]) {
        if (hops.has(next)) continue;
        hops.set(next, hops.get(queue[i]) + 1);
        queue.push(next);
        last = next;
      }
    }
    return last;
  };
  const start = spawn.node ?? nearest(grid.nodes, grid.nodes.keys(), spawn.at);
  const a = farthest(start);
  const [sx, sy] = grid.nodes[start];
  if (Math.hypot(grid.nodes[a][0] - sx, grid.nodes[a][1] - sy) < 256) return null;
  const b = farthest(a);
  const out = route(grid.nodes, edges, start, a);
  const across = route(grid.nodes, edges, a, b);
  const home = across && route(grid.nodes, edges, b, start);
  const back = home ? null : route(grid.nodes, edges, a, start);
  if (!out || (!home && !back)) return null;
  const label = { label: 'Start', kind: 'start' };
  const stop = { label: null, kind: 'wander' };
  return home
    ? { order: [label, stop, stop, label], legs: [out, across, home], loops: true }
    : { order: [label, stop, label], legs: [out, back], loops: true };
}

function length(nodes, leg) {
  let sum = 0;
  for (let i = 1; i < leg.length; i++) sum += Math.hypot(...[0, 1, 2].map((k) => nodes[leg[i]][k] - nodes[leg[i - 1]][k]));
  return sum;
}

class Heap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(value, priority) {
    const a = this.items;
    a.push([priority, value]);
    let i = a.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (a[up][0] <= a[i][0]) break;
      [a[up], a[i]] = [a[i], a[up]];
      i = up;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0][1];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
