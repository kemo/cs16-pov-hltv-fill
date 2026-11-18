// The walk graph of a level in seconds: how long a player needs from one floor to another. The graph is the nav
// of src/shared/game/nav.js: {count, xyz, offsets, to, kinds}, a floor every 32 units, points at the origin.

/** Units a second: the fastest run (the knife and the pistols). */
export const RUN = 250;
// The lists of nearOf() that a graph keeps.
const NEAR_CACHE = 120000;
// Units a second along an edge of each kind: walk, drop, jump, ladder.
const SPEED = [RUN, 400, 200, 120];

/** The seconds of each edge, and the edges turned round (for the way to a node). Made once for a graph. */
export function timesOf(nav) {
  if (nav.fillTimes) return nav.fillTimes;
  const { count, xyz, offsets, to, kinds } = nav;
  const seconds = new Float32Array(to.length);
  const inCount = new Int32Array(count + 1);
  for (let a = 0; a < count; a++) {
    for (let e = offsets[a]; e < offsets[a + 1]; e++) {
      const b = to[e];
      seconds[e] = Math.hypot(xyz[a * 3] - xyz[b * 3], xyz[a * 3 + 1] - xyz[b * 3 + 1], xyz[a * 3 + 2] - xyz[b * 3 + 2]) / SPEED[kinds[e]];
      inCount[b + 1]++;
    }
  }
  for (let i = 0; i < count; i++) inCount[i + 1] += inCount[i];
  const backOffsets = inCount.slice();
  const backFrom = new Int32Array(to.length);
  const backSeconds = new Float32Array(to.length);
  const fill = inCount.slice(0, count);
  for (let a = 0; a < count; a++) {
    for (let e = offsets[a]; e < offsets[a + 1]; e++) {
      const at = fill[to[e]]++;
      backFrom[at] = a;
      backSeconds[at] = seconds[e];
    }
  }
  nav.fillTimes = { seconds, backOffsets, backFrom, backSeconds, near: new Map() };
  return nav.fillTimes;
}

/** A binary heap of (key, node) pairs. */
class Heap {
  constructor() {
    this.keys = [];
    this.nodes = [];
  }

  push(key, node) {
    const { keys, nodes } = this;
    let i = keys.length;
    keys.push(key);
    nodes.push(node);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (keys[up] <= key) break;
      keys[i] = keys[up];
      nodes[i] = nodes[up];
      i = up;
    }
    keys[i] = key;
    nodes[i] = node;
  }

  pop() {
    const { keys, nodes } = this;
    const top = nodes[0];
    const key = keys.pop();
    const node = nodes.pop();
    const n = keys.length;
    if (n) {
      let i = 0;
      for (;;) {
        let child = i * 2 + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        nodes[i] = nodes[child];
        i = child;
      }
      keys[i] = key;
      nodes[i] = node;
    }
    return top;
  }
}

/**
 * The seconds from the start nodes to every node (or, `back`, from every node to them), no further than `limit`.
 * `starts` is a node or a list of nodes. Infinity where no way is.
 */
export function secondsFrom(nav, starts, { back = false, limit = Infinity, out = new Float32Array(nav.count) } = {}) {
  const t = timesOf(nav);
  const offsets = back ? t.backOffsets : nav.offsets;
  const ends = back ? t.backFrom : nav.to;
  const seconds = back ? t.backSeconds : t.seconds;
  out.fill(Infinity);
  const heap = new Heap();
  for (const s of typeof starts === 'number' ? [starts] : starts) {
    out[s] = 0;
    heap.push(0, s);
  }
  while (heap.keys.length) {
    const key = heap.keys[0];
    const at = heap.pop();
    if (key > out[at]) continue;
    for (let e = offsets[at]; e < offsets[at + 1]; e++) {
      const next = ends[e];
      // Rounded as the array keeps it: a sum that the array rounds up would pass the test again and again.
      const d = Math.fround(key + seconds[e]);
      if (d < out[next] && d <= limit) {
        out[next] = d;
        heap.push(d, next);
      }
    }
  }
  return out;
}

/**
 * The nodes within `budget` seconds of a node, itself first: {nodes, seconds, prev, mid1, mid2}; `prev` is the node
 * before each on its way from the start (-1 for the start), `mid1` and `mid2` the last two floors between. Cached.
 */
export function nearOf(nav, node, budget) {
  const t = timesOf(nav);
  const key = node * 128 + Math.min(127, Math.round(budget * 20));
  let hit = t.near.get(key);
  if (hit) return hit;
  const best = new Map([[node, 0]]);
  const before = new Map([[node, -1]]);
  const heap = new Heap();
  heap.push(0, node);
  while (heap.keys.length) {
    const d0 = heap.keys[0];
    const at = heap.pop();
    if (d0 > best.get(at)) continue;
    for (let e = nav.offsets[at]; e < nav.offsets[at + 1]; e++) {
      const d = d0 + t.seconds[e];
      if (d > budget) continue;
      const next = nav.to[e];
      if (d < (best.get(next) ?? Infinity)) {
        best.set(next, d);
        before.set(next, at);
        heap.push(d, next);
      }
    }
  }
  const nodes = Int32Array.from(best.keys());
  const prev = Int32Array.from(nodes, (v) => before.get(v));
  // The floors between the start and each node, two at most with a budget of one step: -1 where none.
  const mid = (v, steps) => {
    let at = before.get(v);
    for (let k = 1; k < steps && at >= 0; k++) at = before.get(at);
    return at >= 0 && at !== node ? at : -1;
  };
  hit = { nodes, seconds: Float32Array.from(best.values()), prev, mid1: Int32Array.from(nodes, (v) => mid(v, 1)), mid2: Int32Array.from(nodes, (v) => mid(v, 2)) };
  // A few hundred bytes each: the cache of a long run over many levels stays under some hundred megabytes.
  if (t.near.size >= NEAR_CACHE) t.near.clear();
  t.near.set(key, hit);
  return hit;
}

/** The nodes of the way from the start of a nearOf() to one of its nodes, both ends in: [{node, seconds}]. */
export function chainOf(near, node) {
  const out = [];
  for (let v = node; v >= 0;) {
    const i = near.nodes.indexOf(v);
    if (i < 0) return [];
    out.push({ node: v, seconds: near.seconds[i] });
    v = near.prev[i];
  }
  return out.reverse();
}

/** The node of a point: the nearest floor, height counted twice; -1 when none is within `reach` cells. */
export function nodeAt(nav, p, reach = 3) {
  const cx = Math.floor(p[0] / 32 + 0.5);
  const cy = Math.floor(p[1] / 32 + 0.5);
  let best = -1;
  let bestD = Infinity;
  // One ring past the first hit: a floor of the next ring can be nearer.
  let found = Infinity;
  for (let r = 0; r <= reach && r <= found + 1; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        for (const i of nav.cells.get((cx + dx) * 65536 + cy + dy) ?? []) {
          const d = Math.hypot(nav.xyz[i * 3] - p[0], nav.xyz[i * 3 + 1] - p[1], (nav.xyz[i * 3 + 2] - p[2]) * 2);
          if (d < bestD) {
            bestD = d;
            best = i;
            if (found === Infinity) found = r;
          }
        }
      }
    }
  }
  return best;
}
