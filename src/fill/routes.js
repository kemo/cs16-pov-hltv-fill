// The routes of real players, from the timelines of a level: where each player of each round was, twice a second,
// on the clock of its round. An HLTV timeline holds every player; a POV timeline holds its recorder and, by the
// radar, the recorder's teammates. A hidden player of a POV demo follows the route of a real player that was at
// the same place at the same time of a round (src/fill/fill.js): the level's usual ways and their timing come
// from here.

import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { lowerBound, tracksOf, windowsOf } from './rounds.js';

/** Seconds between two points of a route. A point k is at k * TICK seconds after its round went live. */
export const TICK = 0.5;
// Seconds of a round that a route keeps.
const MAX_SECONDS = 150;
// Seconds that a player with no later known place goes on along its guide.
const GO_ON = 5;
// The yaw field (lookAt()): units of a cell and of a floor, units between two points of a player that stands, and
// the points from which a cell has a yaw.
const LOOK_CELL = 96;
const LOOK_FLOOR = 128;
const LOOK_STANDS = 12;
const LOOK_FROM = 6;
// Units of one cell of the index.
const CELL_BITS = 7;
const OFFSET = 8192;
const MAGIC = 0x32545246; // 'FRT2'
// The small form of a routes file (shrinkRoutes()).
const SMALL_MAGIC = 0x32435246; // 'FRC2'
// What the small form keeps: units, tenths of a degree (45 steps a turn), and which points. With every second
// point (2) a file is half as large, and on three real POV and HLTV pairs the enemies' median error rose by 1, 5
// and 11 units: so every point stays.
const GRID = 4;
const YAW_GRID = 80;
const YAW_STEPS = 3600 / YAW_GRID;
const EVERY = 1;

/**
 * The routes of one timeline: [{side: 0 T | 1 CT, round, k0, points: [[x, y, z, yaw in tenths]]}], one for each
 * life of a player. `round` counts the rounds of the timeline: the routes of one round are one team's plan.
 * An HLTV timeline gives every player. A POV timeline gives the players whose whole way it holds (knownLives()):
 * take it without estimates.
 */
export function routesOf(timeline) {
  const pov = timeline.source?.kind === 'pov';
  if (pov && timeline.fill) throw new Error('The routes of a POV timeline come from its own samples: take it without the estimates.');
  const tracks = tracksOf(timeline);
  const sides = new Map();
  for (const [t, entity, side] of timeline.sides ?? []) {
    if (!sides.has(entity)) sides.set(entity, []);
    sides.get(entity).push([t, side]);
  }
  const sideAt = (entity, t) => {
    let hit = null;
    for (const [at, side] of sides.get(entity) ?? []) {
      if (at > t) break;
      hit = side;
    }
    return hit;
  };
  const out = [];
  let round = 0;
  for (const win of windowsOf(timeline, tracks)) {
    if (!win.round) continue;
    round++;
    const lives = pov ? knownLives(timeline, tracks, win, sideAt) : [...tracks].map(([entity, track]) => ({ entity, track, until: win.t1 }));
    for (const { entity, track, until } of lives) {
      const side = sideAt(entity, win.t0 + 0.1);
      if (side !== 'T' && side !== 'CT') continue;
      const k0 = Math.ceil((win.t0 + 0.3 - win.goAt) / TICK);
      const points = [];
      let i = lowerBound(track, win.t0 + 0.1);
      for (let k = k0; k * TICK <= MAX_SECONDS; k++) {
        const t = win.goAt + k * TICK;
        if (t >= Math.min(win.t1, until)) break;
        while (i + 1 < track.length && track[i + 1][0] <= t) i++;
        const at = track[i];
        // The route ends where the player is gone: dead, or out of the demo.
        if (!at || Math.abs(at[0] - t) > 0.4) break;
        points.push([at[1], at[2], at[3], at[4]]);
      }
      if (points.length >= 4) out.push({ side: side === 'CT' ? 1 : 0, round, k0, points });
    }
  }
  return out;
}

// Seconds between two radar rows of a teammate that moves (the game sends one each second), with some slack.
const RADAR_STEP = 1.6;
// Seconds between the rows of the track that knownLives() makes of a teammate.
const RADAR_TRACK = 0.25;
// Seconds after a round goes live by which a teammate must have a known place.
const RADAR_FROM = 3;

/**
 * The players of a round of a POV timeline whose whole way the demo holds, [{entity, track, until}]: the recorder,
 * and each teammate until it or the recorder dies. A living recorder gets the place of each teammate that moves
 * once a second (the radar, spec 14 section 2): between two rows the teammate goes the straight way, and with no
 * row it stands. An enemy has no whole way in a POV demo.
 */
function knownLives(timeline, tracks, win, sideAt) {
  const recorder = (timeline.recorders ?? [[0, timeline.recorder]]).findLast((r) => r[0] <= win.t0 + 0.2)?.[1] ?? timeline.recorder;
  const side = sideAt(recorder, win.t0 + 0.1);
  if (side !== 'T' && side !== 'CT') return [];
  const deathOf = (entity) => (timeline.kills ?? []).find((k) => k.victim === entity && k.t >= win.t0 && k.t < win.t1)?.t ?? win.t1;
  const out = [{ entity: recorder, track: tracks.get(recorder) ?? [], until: win.t1 }];
  const mates = new Map();
  for (const [t, entity, x, y, z] of timeline.radar ?? []) {
    if (t <= win.t0 + 0.1 || t >= win.t1 || entity === recorder || sideAt(entity, win.t0 + 0.1) !== side) continue;
    if (!mates.has(entity)) mates.set(entity, []);
    mates.get(entity).push([t, x, y, z, null]);
  }
  const recorderDeath = deathOf(recorder);
  for (const [entity, rows] of mates) {
    const until = Math.min(recorderDeath, deathOf(entity));
    const seen = tracks.get(entity) ?? [];
    const known = rows.filter((row) => row[0] < until);
    for (let i = lowerBound(seen, win.t0 + 0.1); i < seen.length && seen[i][0] < until; i++) known.push(seen[i]);
    known.sort((a, b) => a[0] - b[0]);
    if (known.length < 4 || known[0][0] > win.goAt + RADAR_FROM) continue;
    const track = [];
    let i = 0;
    let yaw = 0;
    // Before its first known place the teammate stands there: a round starts in the freeze, on a spawn.
    for (let t = win.t0 + 0.1; t < until; t += RADAR_TRACK) {
      while (i + 1 < known.length && known[i + 1][0] <= t) i++;
      const [a, b] = [known[i], known[i + 1]];
      let [x, y, z] = [a[1], a[2], a[3]];
      if (a[0] <= t && b && b[0] - a[0] <= RADAR_STEP) {
        const f = (t - a[0]) / (b[0] - a[0]);
        [x, y, z] = [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
        // The radar has no yaw: the teammate looks where it goes.
        if (Math.hypot(b[1] - a[1], b[2] - a[2]) > 8) yaw = (Math.round((Math.atan2(b[2] - a[2], b[1] - a[1]) * 1800) / Math.PI) + 3600) % 3600;
      }
      track.push([t, x, y, z, a[4] ?? yaw]);
    }
    out.push({ entity, track, until });
  }
  return out;
}

/**
 * The bytes of a set of routes. `lists`: the routesOf() of each source, in the order of `sources` (their ids).
 * `about`: what the file says of itself, such as {map, level} (the level's id, tools/lib/fill-level.js).
 */
export function packRoutes(sources, lists, about = {}) {
  const head = Buffer.from(JSON.stringify({ sources, ...about }), 'utf8');
  const routes = lists.flatMap((list, source) => list.map((r) => ({ ...r, source })));
  const total = routes.reduce((n, r) => n + r.points.length, 0);
  const pad = (4 - (head.length % 4)) % 4;
  const buf = Buffer.alloc(16 + head.length + pad + routes.length * 16 + total * 8);
  buf.writeInt32LE(MAGIC, 0);
  buf.writeInt32LE(head.length, 4);
  buf.writeInt32LE(routes.length, 8);
  buf.writeInt32LE(total, 12);
  head.copy(buf, 16);
  let at = 16 + head.length + pad;
  for (const r of routes) {
    buf.writeInt32LE(r.source, at);
    // The side in the lowest bit, the round of its timeline above it.
    buf.writeInt32LE(r.side | ((r.round ?? 0) << 1), at + 4);
    buf.writeInt32LE(r.k0, at + 8);
    buf.writeInt32LE(r.points.length, at + 12);
    at += 16;
  }
  for (const r of routes) {
    for (const p of r.points) {
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(p[0]))), at);
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(p[1]))), at + 2);
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(p[2]))), at + 4);
      buf.writeInt16LE(Math.round(p[3] ?? 0), at + 6);
      at += 8;
    }
  }
  return buf;
}

/** The parts of the bytes of packRoutes(): {head, n, total, meta: where the routes start, points: where the points start}. */
function partsOf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getInt32(0, true) !== MAGIC) throw new Error('Not a routes file.');
  const headLength = view.getInt32(4, true);
  const n = view.getInt32(8, true);
  const meta = 16 + headLength + ((4 - (headLength % 4)) % 4);
  return { view, n, total: view.getInt32(12, true), meta, points: meta + n * 16, head: JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + headLength))) };
}

/** The points of a route of `count` points that the small form keeps: each EVERY-th one, and the last. */
function keptOf(count) {
  const out = [];
  for (let i = 0; i < count; i += EVERY) out.push(i);
  if (out.at(-1) !== count - 1) out.push(count - 1);
  return out;
}

/**
 * The small form of the bytes of packRoutes(), for a file that ships with the tool: places on a grid of 4 units,
 * yaws of 8 degrees, each value as its step from the point before in one byte where it fits, each coordinate of
 * all points together, compressed. `about` adds to what the file says of
 * itself ({map, level}). Without `names` the ids of the sources go: the file names no match.
 */
export function shrinkRoutes(bytes, { names = false, quality = 11, ...about } = {}) {
  const { view, n, total, meta, points, head } = partsOf(bytes);
  // A step in one byte (zigzag); 255, then two bytes, for a larger one.
  const columns = [0, 1, 2, 3].map(() => ({ bytes: new Uint8Array(total * 3), length: 0 }));
  const put = (column, step) => {
    const zigzag = (step << 1) ^ (step >> 31);
    if (zigzag < 255) column.bytes[column.length++] = zigzag;
    else {
      column.bytes[column.length++] = 255;
      column.bytes[column.length++] = zigzag & 255;
      column.bytes[column.length++] = (zigzag >> 8) & 255;
    }
  };
  let first = 0;
  for (let r = 0; r < n; r++) {
    const count = view.getInt32(meta + r * 16 + 12, true);
    const last = [0, 0, 0, 0];
    for (const i of keptOf(count)) {
      for (let k = 0; k < 3; k++) {
        const v = Math.round(view.getInt16(points + (first + i) * 8 + k * 2, true) / GRID);
        put(columns[k], v - last[k]);
        last[k] = v;
      }
      // The yaw is a turn: its step is the short way round.
      const yaw = ((Math.round(view.getInt16(points + (first + i) * 8 + 6, true) / YAW_GRID) % YAW_STEPS) + YAW_STEPS) % YAW_STEPS;
      put(columns[3], ((yaw - last[3] + YAW_STEPS + (YAW_STEPS >> 1)) % YAW_STEPS) - (YAW_STEPS >> 1));
      last[3] = yaw;
    }
    first += count;
  }
  const say = Buffer.from(JSON.stringify({ ...head, ...about, sources: names ? head.sources : head.sources.length, n, total, columns: columns.map((c) => c.length) }), 'utf8');
  const body = Buffer.concat([Buffer.from(Int32Array.of(say.length).buffer), say, Buffer.from(bytes.buffer, bytes.byteOffset + meta, n * 16), ...columns.map((c) => Buffer.from(c.bytes.buffer, 0, c.length))]);
  const small = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_LGWIN]: 24 } });
  return Buffer.concat([Buffer.from(Int32Array.of(SMALL_MAGIC).buffer), small]);
}

/** The bytes of packRoutes() again from their small form: a point that the small form left out lies between its neighbours. */
function expandRoutes(bytes) {
  const body = brotliDecompressSync(bytes.subarray(4));
  const sayLength = body.readInt32LE(0);
  const say = JSON.parse(body.toString('utf8', 4, 4 + sayLength));
  const { n, total, columns, ...about } = say;
  const sources = Array.isArray(say.sources) ? say.sources : Array.from({ length: say.sources }, (_, i) => String(i));
  const head = Buffer.from(JSON.stringify({ ...about, sources }), 'utf8');
  const pad = (4 - (head.length % 4)) % 4;
  const out = Buffer.alloc(16 + head.length + pad + n * 16 + total * 8);
  out.writeInt32LE(MAGIC, 0);
  out.writeInt32LE(head.length, 4);
  out.writeInt32LE(n, 8);
  out.writeInt32LE(total, 12);
  head.copy(out, 16);
  const meta = 16 + head.length + pad;
  body.copy(out, meta, 4 + sayLength, 4 + sayLength + n * 16);
  const at = [];
  let offset = 4 + sayLength + n * 16;
  for (const length of columns) {
    at.push(offset);
    offset += length;
  }
  const take = (k) => {
    let zigzag = body[at[k]++];
    if (zigzag === 255) {
      zigzag = body[at[k]] | (body[at[k] + 1] << 8);
      at[k] += 2;
    }
    return (zigzag >>> 1) ^ -(zigzag & 1);
  };
  const points = meta + n * 16;
  const write = (index, k, v) => out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), points + index * 8 + k * 2);
  let first = 0;
  for (let r = 0; r < n; r++) {
    const count = out.readInt32LE(meta + r * 16 + 12);
    const last = [0, 0, 0, 0];
    let before = -1;
    let old = null;
    for (const i of keptOf(count)) {
      for (let k = 0; k < 3; k++) last[k] += take(k);
      last[3] = (last[3] + take(3) + YAW_STEPS) % YAW_STEPS;
      const now = [last[0] * GRID, last[1] * GRID, last[2] * GRID, last[3] * YAW_GRID];
      for (let k = 0; k < 4; k++) write(first + i, k, now[k]);
      // The points between two kept ones: on the line between them, the yaw the short way round.
      for (let j = before + 1; before >= 0 && j < i; j++) {
        const f = (j - before) / (i - before);
        for (let k = 0; k < 3; k++) write(first + j, k, Math.round(old[k] + (now[k] - old[k]) * f));
        const turn = ((now[3] - old[3] + 5400) % 3600) - 1800;
        write(first + j, 3, Math.round(((old[3] + turn * f) % 3600 + 3600) % 3600));
      }
      before = i;
      old = now;
    }
    first += count;
  }
  return out;
}

/**
 * Where the real players of a side look while they stand at a place: the yaw in tenths of a degree, or null where
 * fewer than LOOK_FROM points of standing players lie in the cell of the place. `side`: 0 T, 1 CT.
 */
export function lookAt(routes, side, x, y, z) {
  routes.look ??= lookOf(routes);
  return routes.look[side].get(lookKey(x, y, z)) ?? null;
}

const lookKey = (x, y, z) => ((Math.round(x / LOOK_CELL) + 512) * 1024 + Math.round(y / LOOK_CELL) + 512) * 256 + Math.round(z / LOOK_FLOOR) + 128;

/** The yaw of each cell of each side: the mean direction of the points at which a real player stands. */
function lookOf(routes) {
  const sums = [new Map(), new Map()];
  for (let r = 0; r < routes.n; r++) {
    if (routes.out?.[r]) continue;
    for (let i = 1; i < routes.count[r]; i++) {
      const [a, b] = [(routes.start[r] + i - 1) * 3, (routes.start[r] + i) * 3];
      if (Math.hypot(routes.points[b] - routes.points[a], routes.points[b + 1] - routes.points[a + 1]) > LOOK_STANDS) continue;
      const key = lookKey(routes.points[b], routes.points[b + 1], routes.points[b + 2]);
      const cells = sums[routes.side[r]];
      if (!cells.has(key)) cells.set(key, [0, 0, 0]);
      const sum = cells.get(key);
      const yaw = (routes.yaws[routes.start[r] + i] * Math.PI) / 1800;
      sum[0] += Math.cos(yaw);
      sum[1] += Math.sin(yaw);
      sum[2]++;
    }
  }
  return sums.map((cells) => new Map([...cells].filter(([, sum]) => sum[2] >= LOOK_FROM).map(([key, sum]) => [key, (Math.round((Math.atan2(sum[1], sum[0]) * 1800) / Math.PI) + 3600) % 3600])));
}

/**
 * The routes from their bytes (packRoutes() or shrinkRoutes()), with the index of their points by place.
 * `skip(sourceId)` leaves sources out. `map` and `level` are what the file says of itself, or undefined.
 */
export function readRoutes(bytes, skip = null) {
  if (bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true) === SMALL_MAGIC) bytes = expandRoutes(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getInt32(0, true) !== MAGIC) throw new Error('Not a routes file.');
  const headLength = view.getInt32(4, true);
  const n = view.getInt32(8, true);
  const total = view.getInt32(12, true);
  const { sources, map, level } = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + headLength)));
  let at = 16 + headLength + ((4 - (headLength % 4)) % 4);
  const source = new Int32Array(n);
  const side = new Uint8Array(n);
  const k0 = new Int32Array(n);
  // The round of each route, one number over all sources.
  const round = new Int32Array(n);
  const count = new Int32Array(n);
  const start = new Int32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++, at += 16) {
    source[i] = view.getInt32(at, true);
    side[i] = view.getInt32(at + 4, true) & 1;
    round[i] = source[i] * 4096 + (view.getInt32(at + 4, true) >> 1);
    k0[i] = view.getInt32(at + 8, true);
    count[i] = view.getInt32(at + 12, true);
    start[i] = sum;
    sum += count[i];
  }
  const points = new Int16Array(total * 3);
  const yaws = new Int16Array(total);
  for (let i = 0; i < total; i++, at += 8) {
    for (let k = 0; k < 3; k++) points[i * 3 + k] = view.getInt16(at + k * 2, true);
    yaws[i] = view.getInt16(at + 6, true);
  }
  const out = skip ? new Uint8Array(n) : null;
  if (skip) for (let i = 0; i < n; i++) out[i] = skip(sources[source[i]]) ? 1 : 0;

  // The index: the points of each cell of each side, as (route, point) pairs.
  const cells = 1 << (2 * (14 - CELL_BITS) + 1);
  const offsets = new Int32Array(cells + 1);
  const keyOf = (s, x, y) => (((s << (14 - CELL_BITS)) | ((x + OFFSET) >> CELL_BITS)) << (14 - CELL_BITS)) | ((y + OFFSET) >> CELL_BITS);
  for (let r = 0; r < n; r++) {
    if (out?.[r]) continue;
    for (let i = 0; i < count[r]; i++) offsets[keyOf(side[r], points[(start[r] + i) * 3], points[(start[r] + i) * 3 + 1]) + 1]++;
  }
  for (let c = 0; c < cells; c++) offsets[c + 1] += offsets[c];
  const cellRoute = new Int32Array(offsets[cells]);
  const cellPoint = new Int32Array(offsets[cells]);
  const fill = offsets.slice(0, cells);
  for (let r = 0; r < n; r++) {
    if (out?.[r]) continue;
    for (let i = 0; i < count[r]; i++) {
      const slot = fill[keyOf(side[r], points[(start[r] + i) * 3], points[(start[r] + i) * 3 + 1])]++;
      cellRoute[slot] = r;
      cellPoint[slot] = i;
    }
  }
  return { sources, map, level, n, source, side, round, k0, count, start, points, yaws, out, offsets, cellRoute, cellPoint, keyOf };
}

/** The place of a route at point index i (a fraction lies between two points; outside the route, its end). */
export function placeOf(routes, r, i, to = [0, 0, 0]) {
  const last = routes.count[r] - 1;
  const at = Math.max(0, Math.min(last, i));
  const a = Math.floor(at);
  const b = Math.min(last, a + 1);
  const k = at - a;
  const p = routes.points;
  const [ia, ib] = [(routes.start[r] + a) * 3, (routes.start[r] + b) * 3];
  to[0] = p[ia] + (p[ib] - p[ia]) * k;
  to[1] = p[ia + 1] + (p[ib + 1] - p[ia + 1]) * k;
  to[2] = p[ia + 2] + (p[ib + 2] - p[ia + 2]) * k;
  return to;
}

/** The yaw of a route at the point nearest index i, in tenths of a degree. */
export const yawOf = (routes, r, i) => routes.yaws[routes.start[r] + Math.max(0, Math.min(routes.count[r] - 1, Math.round(i)))];

/** Calls `each(route, point index, distance)` for every point of a side within `radius` of a place. */
export function pointsNear(routes, side, place, radius, each) {
  const { points, start, offsets, cellRoute, cellPoint, keyOf } = routes;
  const size = 1 << CELL_BITS;
  for (let x = place[0] - radius; x < place[0] + radius + size; x += size) {
    for (let y = place[1] - radius; y < place[1] + radius + size; y += size) {
      if (x < -OFFSET || y < -OFFSET || x >= OFFSET || y >= OFFSET) continue;
      const key = keyOf(side, Math.floor(x), Math.floor(y));
      for (let slot = offsets[key]; slot < offsets[key + 1]; slot++) {
        const at = (start[cellRoute[slot]] + cellPoint[slot]) * 3;
        const d = Math.hypot(points[at] - place[0], points[at + 1] - place[1], (points[at + 2] - place[2]) * 2);
        if (d <= radius) each(cellRoute[slot], cellPoint[slot], d);
      }
    }
  }
}

const best = (found, limit) => [...found.values()].sort((a, b) => a.score - b.score).slice(0, limit);
const keep = (found, r, hit) => {
  const old = found.get(r);
  if (!old || hit.score < old.score) found.set(r, hit);
};

/**
 * The guides of a span: up to `limit` of {route, at, yawAt}, the likeliest first. `at(seconds, to) -> [x, y, z]`
 * is the place of a real player at a time of the round (seconds since it went live), `yawAt(seconds)` its yaw. `a` and `b` are the known places at the ends
 * ({x, y, z} with `at`, the seconds of the round), either can be null; `heading` is the unit vector of the
 * player's way at `a`, `headingB` at `b`, or null. `used` holds the routes that other players of this round follow,
 * `rounds` the real rounds of the guides of its team: a player with no known place takes a route of one of them.
 * `laterB`: the known places after `b` ({x, y, z, at}), which a guide to `b` should pass too.
 */
export function guidesFor(routes, { side, a, b, until, heading = null, headingB = null, used = null, rounds = null, laterB = null, limit = 3, seed = 0 }) {
  const found = new Map();
  const free = (r) => !used?.has(r);
  const tau = (r, i) => (routes.k0[r] + i) * TICK;
  const scratch = [0, 0, 0];
  const other = [0, 0, 0];
  const guide = (r, index) => ({ route: r, at: (seconds, to) => placeOf(routes, r, index(seconds), to), yawAt: (seconds) => yawOf(routes, r, index(seconds)) });
  // How far the way of a route at point i turns from a heading: 0 the same way, 160 the other way.
  const turnOf = (r, i, way) => {
    if (!way) return 0;
    const p = placeOf(routes, r, i - 1, other);
    const [px, py] = [p[0], p[1]];
    const q = placeOf(routes, r, i + 1, other);
    const length = Math.hypot(q[0] - px, q[1] - py);
    return length > 24 ? (1 - ((q[0] - px) * way[0] + (q[1] - py) * way[1]) / length) * 80 : 60;
  };
  // How far a route passes the known places after b, when it is at b at point i: half the mean distance.
  const later = (r, i) => {
    if (!laterB?.length) return 0;
    let sum = 0;
    for (const p of laterB) {
      placeOf(routes, r, i + (p.at - b.at) / TICK, other);
      sum += Math.hypot(other[0] - p.x, other[1] - p.y);
    }
    return sum / laterB.length / 2;
  };
  if (a && b) {
    // A real player that went from the first place to the second in about the same time.
    const span = b.at - a.at;
    const steps = span / TICK;
    pointsNear(routes, side, [a.x, a.y, a.z], 112, (r, i, d) => {
      if (!free(r)) return;
      for (const slip of [0, -1, 1, -2, 2, -3, 3]) {
        const j = Math.round(i + steps) + slip;
        if (j <= i || j >= routes.count[r]) continue;
        placeOf(routes, r, j, scratch);
        const d2 = Math.hypot(scratch[0] - b.x, scratch[1] - b.y, (scratch[2] - b.z) * 2);
        if (d2 > 144) continue;
        const clock = Math.min(20, Math.abs(tau(r, i) - a.at));
        keep(found, r, { r, i, j, score: d + d2 + 60 * Math.abs(slip) * TICK + 2 * clock + turnOf(r, i, heading) / 2 + turnOf(r, j, headingB) / 2 });
      }
    });
    return best(found, limit).map(({ r, i, j }) => guide(r, (seconds) => i + ((seconds - a.at) / span) * (j - i)));
  }
  if (b) {
    // A real player that came from its spawn to the place at about the same time of the round.
    pointsNear(routes, side, [b.x, b.y, b.z], 144, (r, i, d) => {
      if (!free(r) || routes.k0[r] > 2) return;
      const late = b.at - tau(r, i);
      if (Math.abs(late) > 5) return;
      keep(found, r, { r, i, late, score: d + 40 * Math.abs(late) + turnOf(r, i, headingB) + later(r, i) });
    });
    // A later player waited that much longer before it left; an earlier one goes that much sooner on the way.
    return best(found, limit).map(({ r, i, late }) => guide(r, (seconds) => {
      const k = late >= 0 ? (seconds - late) / TICK : ((seconds / Math.max(0.5, b.at)) * tau(r, i)) / TICK;
      return Math.min(i, k - routes.k0[r]);
    }));
  }
  if (a) {
    // A real player that was at the place at about the same time, going the same way: the hidden one goes on as it did.
    pointsNear(routes, side, [a.x, a.y, a.z], 112, (r, i, d) => {
      if (!free(r)) return;
      const early = Math.abs(tau(r, i) - a.at);
      if (early > 8 || tau(r, routes.count[r] - 1) < Math.min(until, a.at + 3)) return;
      keep(found, r, { r, i, score: d + 15 * early + turnOf(r, i, heading) });
    });
    // Only so far: a player that nothing shows again went to a place and stayed, more often than it went on.
    return best(found, limit).map(({ r, i }) => guide(r, (seconds) => i + Math.min(GO_ON, seconds - a.at) / TICK));
  }
  // No known place at all: the whole round of some real player of the side, chosen by the seed.
  const whole = [];
  for (let r = 0; r < routes.n; r++) if (routes.side[r] === side && !routes.out?.[r] && routes.k0[r] <= 2 && free(r) && tau(r, routes.count[r] - 1) >= Math.min(until, 20)) whole.push(r);
  // A teammate of the real players that the team follows already, when one is free.
  const mates = whole.filter((r) => rounds?.has(routes.round[r]));
  const from = mates.length ? mates : whole;
  const picks = [];
  for (let k = 0; k < limit && from.length; k++) picks.push(from[Math.abs((seed * 7919 + k * 104729) % from.length)]);
  return picks.map((r) => guide(r, (seconds) => seconds / TICK - routes.k0[r]));
}
