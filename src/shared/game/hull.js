// The clip hulls of a level (tools/build-hulls.js) and the box trace through them, in world units. A clip hull is
// the level grown by the player's box, so the box trace of the player is a point trace through the hull.

export const CONTENTS_EMPTY = -1;
export const CONTENTS_SOLID = -2;
export const CONTENTS_WATER = -3;
/** Hull 0 is a point: a bullet, a line of sight. Hulls 1 and 3 are the standing and the ducked player. */
export const HULL_POINT = 0;
export const HULL_STAND = 1;
export const HULL_DUCK = 3;
/** The half size of the box in each hull: [x, y, z]. */
export const HULL_SIZE = { [HULL_POINT]: [0, 0, 0], [HULL_STAND]: [16, 16, 36], [HULL_DUCK]: [16, 16, 18] };

const MAGIC = 0x324c5548; // 'HUL2'
const MODEL_FLOATS = 12;
// The trace stops this far in front of a plane, so the next trace does not start inside it.
const DIST_EPSILON = 0.03125;

/**
 * The binary of tools/build-hulls.js. Layout, little-endian: int32 magic, models, planes, clipnodes; then per model
 * 12 floats (head node of hull 0, 1 and 3, origin, mins, maxs); per plane 5 floats (normal, dist, type); per
 * clipnode 3 int32 (plane, front child, back child). Model 0 is the world. The nodes of hull 0 come after the clip
 * nodes, each leaf already turned into its contents, so one walk serves every hull.
 */
export function writeHulls({ models, planes, clipnodes }) {
  const size = 16 + models.length * MODEL_FLOATS * 4 + planes.length * 20 + clipnodes.length * 12;
  const view = new DataView(new ArrayBuffer(size));
  let at = 0;
  for (const n of [MAGIC, models.length, planes.length, clipnodes.length]) view.setInt32((at += 4) - 4, n, true);
  for (const m of models) {
    for (const f of [m.head0, m.head1, m.head3, ...m.origin, ...m.mins, ...m.maxs]) view.setFloat32((at += 4) - 4, f, true);
  }
  for (const p of planes) for (const f of [...p.normal, p.dist, p.type]) view.setFloat32((at += 4) - 4, f, true);
  for (const c of clipnodes) for (const n of [c.plane, ...c.children]) view.setInt32((at += 4) - 4, n, true);
  return view.buffer;
}

/** The hulls of a level from the binary of writeHulls(). */
export function readHulls(buffer) {
  const view = new DataView(buffer);
  if (view.getInt32(0, true) !== MAGIC) throw new Error('Not a hull file.');
  const [models, planes, nodes] = [4, 8, 12].map((o) => view.getInt32(o, true));
  let at = 16;
  const floats = (n) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = view.getFloat32(at + i * 4, true);
    at += n * 4;
    return out;
  };
  const m = floats(models * MODEL_FLOATS);
  const list = [];
  for (let i = 0; i < models; i++) {
    const o = i * MODEL_FLOATS;
    const mins = [m[o + 6], m[o + 7], m[o + 8]];
    const maxs = [m[o + 9], m[o + 10], m[o + 11]];
    // A turned model reaches as far as its furthest corner from its origin, every way round (traceBox).
    const reach = Math.hypot(Math.max(Math.abs(mins[0]), Math.abs(maxs[0])), Math.max(Math.abs(mins[1]), Math.abs(maxs[1])));
    list.push({ head: { [HULL_POINT]: m[o], [HULL_STAND]: m[o + 1], [HULL_DUCK]: m[o + 2] }, origin: [m[o + 3], m[o + 4], m[o + 5]], mins, maxs, reach });
  }
  const plane = floats(planes * 5);
  const clip = new Int32Array(nodes * 3);
  for (let i = 0; i < nodes * 3; i++) clip[i] = view.getInt32(at + i * 4, true);
  return { models: list, planes: plane, clipnodes: clip };
}

/** The distance of point (x, y, z) from plane p, positive on the front side. */
function distance(h, p, x, y, z) {
  const o = p * 5;
  const type = h.planes[o + 4];
  if (type === 0) return x - h.planes[o + 3];
  if (type === 1) return y - h.planes[o + 3];
  if (type === 2) return z - h.planes[o + 3];
  return h.planes[o] * x + h.planes[o + 1] * y + h.planes[o + 2] * z - h.planes[o + 3];
}

/** The contents at a point from a head node: CONTENTS_SOLID, CONTENTS_EMPTY, or in hull 0 water, sky and the rest. */
export function contentsAt(h, head, x, y, z) {
  let num = head;
  while (num >= 0) {
    const o = num * 3;
    num = h.clipnodes[o + (distance(h, h.clipnodes[o], x, y, z) < 0 ? 2 : 1)];
  }
  return num;
}

/**
 * Walks the segment p1 -> p2 (fractions f1 -> f2 of the whole trace) down the tree from `num`. Returns false at the
 * first solid that the segment enters, with the trace stopped in front of it.
 */
function walk(h, head, num, f1, f2, x1, y1, z1, x2, y2, z2, tr) {
  let o;
  let plane;
  let t1;
  let t2;
  // Both ends on one side of a plane: the walk goes down that side in this loop, with no new call.
  for (;;) {
    if (num < 0) {
      if (num !== CONTENTS_SOLID) tr.allSolid = false;
      else tr.startSolid = true;
      return true;
    }
    o = num * 3;
    plane = h.clipnodes[o];
    t1 = distance(h, plane, x1, y1, z1);
    t2 = distance(h, plane, x2, y2, z2);
    if (t1 >= 0 && t2 >= 0) num = h.clipnodes[o + 1];
    else if (t1 < 0 && t2 < 0) num = h.clipnodes[o + 2];
    else break;
  }

  // The segment crosses the plane: split it a little on the near side of the plane.
  let frac = t1 < 0 ? (t1 + DIST_EPSILON) / (t1 - t2) : (t1 - DIST_EPSILON) / (t1 - t2);
  frac = Math.min(1, Math.max(0, frac));
  let fm = f1 + (f2 - f1) * frac;
  let xm = x1 + (x2 - x1) * frac;
  let ym = y1 + (y2 - y1) * frac;
  let zm = z1 + (z2 - z1) * frac;
  const side = t1 < 0 ? 1 : 0;
  const near = h.clipnodes[o + 1 + side];
  const far = h.clipnodes[o + 2 - side];

  if (!walk(h, head, near, f1, fm, x1, y1, z1, xm, ym, zm, tr)) return false;
  if (contentsAt(h, far, xm, ym, zm) !== CONTENTS_SOLID) return walk(h, head, far, fm, f2, xm, ym, zm, x2, y2, z2, tr);
  if (tr.allSolid) return false;

  // The far side is solid: the hit is on this plane, its normal facing the start.
  const p = plane * 5;
  const sign = side === 0 ? 1 : -1;
  tr.normal[0] = h.planes[p] * sign;
  tr.normal[1] = h.planes[p + 1] * sign;
  tr.normal[2] = h.planes[p + 2] * sign;
  // Float error can leave the split point inside the solid: back off until it is free.
  while (contentsAt(h, head, xm, ym, zm) === CONTENTS_SOLID) {
    frac -= 0.1;
    // Also the end for a trace with a number that is not finite: no comparison holds, and the loop must not go on.
    if (!(frac >= 0)) {
      tr.fraction = fm;
      tr.end[0] = xm;
      tr.end[1] = ym;
      tr.end[2] = zm;
      return false;
    }
    fm = f1 + (f2 - f1) * frac;
    xm = x1 + (x2 - x1) * frac;
    ym = y1 + (y2 - y1) * frac;
    zm = z1 + (z2 - z1) * frac;
  }
  tr.fraction = fm;
  tr.end[0] = xm;
  tr.end[1] = ym;
  tr.end[2] = zm;
  return false;
}

/** A trace result: how far the box moved (0 to 1), where it stopped, the normal of the plane it hit. */
export function newTrace() {
  return { fraction: 1, end: [0, 0, 0], normal: [0, 0, 0], startSolid: false, allSolid: true, model: -1 };
}

function traceModel(h, model, hull, start, end, tr, passOut = false) {
  const ox = model.origin[0];
  const oy = model.origin[1];
  const oz = model.origin[2];
  tr.fraction = 1;
  tr.allSolid = true;
  tr.startSolid = false;
  // A turned model (a rotating door, `rot` degrees about z): the trace turns back into the model's own space.
  const rot = model.rot ? (model.rot * Math.PI) / 180 : 0;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const rx = start[0] - ox;
  const ry = start[1] - oy;
  const qx = end[0] - ox;
  const qy = end[1] - oy;
  const sx = rot ? rx * c + ry * s : rx;
  const sy = rot ? -rx * s + ry * c : ry;
  tr.end[0] = rot ? qx * c + qy * s : qx;
  tr.end[1] = rot ? -qx * s + qy * c : qy;
  tr.end[2] = end[2] - oz;
  const head = model.head[hull];
  walk(h, head, head, 0, 1, sx, sy, start[2] - oz, tr.end[0], tr.end[1], tr.end[2], tr);
  if (rot) {
    const [nx, ny] = [tr.normal[0], tr.normal[1]];
    tr.normal[0] = nx * c - ny * s;
    tr.normal[1] = nx * s + ny * c;
  }
  if (tr.allSolid) tr.startSolid = true;
  if (tr.startSolid && (!passOut || tr.allSolid)) tr.fraction = 0;
  tr.end[0] = start[0] + (end[0] - start[0]) * tr.fraction;
  tr.end[1] = start[1] + (end[1] - start[1]) * tr.fraction;
  tr.end[2] = start[2] + (end[2] - start[2]) * tr.fraction;
}

const scratch = newTrace();

/**
 * Moves a box (hull HULL_STAND or HULL_DUCK, origin at its centre) or a point (HULL_POINT) from start to end
 * through the world and the solid brush models. Writes the nearest hit into `tr` (a newTrace()) and returns it.
 * `passOut`: a start inside a solid leaves it freely and stops at the next one, as the engine's line trace for a
 * bullet does (SV_RecursiveHullCheck); a segment that never leaves it is allSolid with fraction 0. A player's move
 * needs the default: a start inside a solid moves nowhere (PM_PlayerTrace).
 */
export function traceBox(h, hull, start, end, tr = newTrace(), passOut = false) {
  traceModel(h, h.models[0], hull, start, end, tr, passOut);
  tr.model = tr.fraction < 1 || tr.startSolid ? 0 : -1;
  const size = HULL_SIZE[hull];
  // The bounds of the segment, grown by the box and a unit: a model wholly outside them cannot stop it.
  const x0 = (start[0] < end[0] ? start[0] : end[0]) - size[0] - 1;
  const x1 = (start[0] > end[0] ? start[0] : end[0]) + size[0] + 1;
  const y0 = (start[1] < end[1] ? start[1] : end[1]) - size[1] - 1;
  const y1 = (start[1] > end[1] ? start[1] : end[1]) + size[1] + 1;
  const z0 = (start[2] < end[2] ? start[2] : end[2]) - size[2] - 1;
  const z1 = (start[2] > end[2] ? start[2] : end[2]) + size[2] + 1;
  for (let i = 1; i < h.models.length; i++) {
    const m = h.models[i];
    // A broken breakable (breakables.js) stops nothing.
    if (m.gone) continue;
    const o = m.origin;
    if (o[2] + m.mins[2] > z1 || o[2] + m.maxs[2] < z0) continue;
    if (m.rot) {
      const r = m.reach;
      if (o[0] - r > x1 || o[0] + r < x0 || o[1] - r > y1 || o[1] + r < y0) continue;
    } else if (o[0] + m.mins[0] > x1 || o[0] + m.maxs[0] < x0 || o[1] + m.mins[1] > y1 || o[1] + m.maxs[1] < y0) continue;
    traceModel(h, m, hull, start, end, scratch, passOut);
    if ((scratch.startSolid && (!passOut || scratch.allSolid)) || scratch.fraction < tr.fraction) {
      const wasSolid = tr.startSolid;
      tr.fraction = scratch.fraction;
      for (let k = 0; k < 3; k++) {
        tr.end[k] = scratch.end[k];
        tr.normal[k] = scratch.normal[k];
      }
      tr.startSolid = wasSolid || scratch.startSolid;
      tr.allSolid = tr.allSolid || scratch.allSolid;
      tr.model = i;
    }
  }
  // The other players: boxes that a player's box does not pass through (a bullet does; hitboxes take it).
  if (hull !== HULL_POINT && h.movers) {
    for (const m of h.movers) {
      if (!solidTo(h, m)) continue;
      // The overlap rule holds between players that the game moves. The page's prediction (h.lateBoxes) sees
      // the others late, so an overlap there is no overlap of the room.
      const hit = sweepBox(start, end, size, m, !h.lateBoxes && !m.placed);
      if (hit && hit.fraction < tr.fraction) {
        tr.fraction = hit.fraction;
        for (let k = 0; k < 3; k++) {
          tr.end[k] = start[k] + (end[k] - start[k]) * hit.fraction;
          tr.normal[k] = hit.normal[k];
        }
        tr.model = -2;
      }
    }
  }
  return tr;
}

/**
 * Where a box of half size `size` moving from start to end first touches a still box {origin, half}: {fraction,
 * normal} (shared, see hitOf), or null. A box that starts inside the other passes out of it freely, so two players never lock. With
 * `strict` it can move only where the move does not bring the centres nearer along the axis of least overlap
 * (roadmap A1): the two never pass through each other. That axis, not the full distance, keeps a slide along the
 * other box and a probe of the floor free.
 */
function sweepBox(start, end, size, m, strict) {
  // Most boxes lie off the segment's bounds: no hit, before any division.
  for (let k = 0; k < 3; k++) {
    const reach = m.half[k] + size[k];
    const a = start[k];
    const b = end[k];
    if ((a > b ? a : b) < m.origin[k] - reach || (a < b ? a : b) > m.origin[k] + reach) return null;
  }
  if (strict) {
    let least = Infinity;
    let deep = -1;
    for (let k = 0; k < 3 && least > 0; k++) {
      const gap = m.half[k] + size[k] - Math.abs(start[k] - m.origin[k]);
      if (gap < least) {
        least = gap;
        deep = k;
      }
    }
    if (least > 0) {
      const off = start[deep] - m.origin[deep];
      if (off * (end[deep] - start[deep]) >= 0) return null;
      return hitOf(0, deep, off > 0 ? 1 : -1);
    }
  }
  let enter = -Infinity;
  let exit = Infinity;
  let axis = -1;
  let sign = 0;
  for (let k = 0; k < 3; k++) {
    const lo = m.origin[k] - m.half[k] - size[k];
    const hi = m.origin[k] + m.half[k] + size[k];
    const d = end[k] - start[k];
    if (Math.abs(d) < 1e-9) {
      if (start[k] <= lo || start[k] >= hi) return null;
      continue;
    }
    let a = (lo - start[k]) / d;
    let b = (hi - start[k]) / d;
    let s = -1;
    if (a > b) {
      [a, b] = [b, a];
      s = 1;
    }
    if (a > enter) {
      enter = a;
      axis = k;
      sign = s;
    }
    exit = Math.min(exit, b);
  }
  if (axis < 0 || enter < 0 || enter > 1 || enter >= exit) return null;
  const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]) || 1;
  return hitOf(Math.max(0, enter - DIST_EPSILON / length), axis, sign);
}

// The one result of sweepBox: its caller reads it before the next sweep.
const sweepHit = { fraction: 0, normal: [0, 0, 0] };
function hitOf(fraction, axis, sign) {
  sweepHit.fraction = fraction;
  sweepHit.normal[0] = sweepHit.normal[1] = sweepHit.normal[2] = 0;
  sweepHit.normal[axis] = sign;
  return sweepHit;
}

/** True when the segment start -> end of a box of half size `size` stays clear of the bounds of model `m`. */
function apart(m, size, start, end) {
  const r = m.reach;
  for (let k = 0; k < 3; k++) {
    const a = m.rot && k < 2 ? -r : m.mins[k];
    const b = m.rot && k < 2 ? r : m.maxs[k];
    if (Math.max(start[k], end[k]) < m.origin[k] + a - size[k] - 1 || Math.min(start[k], end[k]) > m.origin[k] + b + size[k] + 1) return true;
  }
  return false;
}

/** True when a box of the hull at `origin` is clear of brush model `index` alone, where that model stands now. */
export function fitsModel(h, hull, origin, index) {
  const m = h.models[index];
  if (!m || m.gone || apart(m, HULL_SIZE[hull], origin, origin)) return true;
  traceModel(h, m, hull, origin, origin, scratchFit);
  return !scratchFit.startSolid;
}

/**
 * True when the player's box fits at `origin` in the hull. `players`: the boxes of the players that a move of
 * `h.self` meets (h.movers) count too.
 */
export function fits(h, hull, origin, players = false) {
  const tr = traceBox(h, hull, origin, origin, scratchFit);
  if (tr.startSolid) return false;
  if (!players || hull === HULL_POINT || !h.movers) return true;
  const size = HULL_SIZE[hull];
  for (const m of h.movers) {
    if (!solidTo(h, m)) continue;
    let inside = true;
    for (let k = 0; k < 3 && inside; k++) inside = Math.abs(origin[k] - m.origin[k]) < m.half[k] + size[k];
    if (inside) return false;
  }
  return true;
}

/**
 * A player's box stops a move of `h.self`, unless it is that player. A rails bot is a ghost for its own team, the
 * person too: it cannot step aside (rails.js). It is solid once it leaves its recording (owner, 2026-11-14).
 */
function solidTo(h, m) {
  return m.id !== h.self && (m.ghostTo === null || m.ghostTo !== h.selfTeam);
}
const scratchFit = newTrace();
