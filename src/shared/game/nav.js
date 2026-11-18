// The navigation graph of a level (tools/build-nav.js) and the way through it (spec 11, section 7): a floor every
// 32 units, its walks to the floors around it, the drops off a ledge, the jumps up onto one and the ladders. Points are player
// origins (36 over the feet).

const MAGIC = 0x3156414e; // 'NAV1'
export const WALK = 0;
export const DROP = 1;
export const JUMP = 2;
export const LADDER = 3;
const CELL = 32;
// A jump costs as much as this much more walk: a route takes it only to save the way round.
const KIND_COST = [0, 16, 48, 32];

/** The binary: int32 magic, nodes, edges; floats x y z per node; int32 offsets (nodes + 1); int32 edges; uint8 kinds. */
export function writeNav({ nodes, edges }) {
  const flat = edges.flat();
  const size = 12 + nodes.length * 12 + (nodes.length + 1) * 4 + flat.length * 4 + flat.length;
  const view = new DataView(new ArrayBuffer(size));
  let at = 0;
  for (const n of [MAGIC, nodes.length, flat.length]) view.setInt32((at += 4) - 4, n, true);
  for (const n of nodes) for (const v of n) view.setFloat32((at += 4) - 4, v, true);
  let offset = 0;
  for (let i = 0; i <= nodes.length; i++) {
    view.setInt32((at += 4) - 4, offset, true);
    offset += edges[i]?.length ?? 0;
  }
  for (const [to] of flat) view.setInt32((at += 4) - 4, to, true);
  for (const [, kind] of flat) view.setUint8(at++, kind);
  return view.buffer;
}

/** The graph from the binary, with a grid of the nodes for the nearest-node search. */
export function readNav(buffer) {
  const view = new DataView(buffer);
  if (view.getInt32(0, true) !== MAGIC) throw new Error('Not a nav file.');
  const count = view.getInt32(4, true);
  const edgeCount = view.getInt32(8, true);
  let at = 12;
  const xyz = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++, at += 4) xyz[i] = view.getFloat32(at, true);
  const offsets = new Int32Array(count + 1);
  for (let i = 0; i <= count; i++, at += 4) offsets[i] = view.getInt32(at, true);
  const to = new Int32Array(edgeCount);
  for (let i = 0; i < edgeCount; i++, at += 4) to[i] = view.getInt32(at, true);
  const kinds = new Uint8Array(buffer.slice(at, at + edgeCount));
  const cells = new Map();
  for (let i = 0; i < count; i++) {
    const key = cellKey(xyz[i * 3], xyz[i * 3 + 1]);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(i);
  }
  return { count, xyz, offsets, to, kinds, cells };
}

const cellKey = (x, y) => Math.floor(x / CELL + 0.5) * 65536 + Math.floor(y / CELL + 0.5);
export const nodePoint = (nav, i) => [nav.xyz[i * 3], nav.xyz[i * 3 + 1], nav.xyz[i * 3 + 2]];

/**
 * The node nearest a point: the cells around it, out to `reach` cells; height counts twice, and a node more than
 * `rise` above or below is no floor of that point. -1 when none.
 */
export function nearestNode(nav, p, reach = 4, rise = Infinity) {
  const cx = Math.floor(p[0] / CELL + 0.5);
  const cy = Math.floor(p[1] / CELL + 0.5);
  let best = -1;
  let bestD = Infinity;
  for (let r = 0; r <= reach; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        for (const i of nav.cells.get((cx + dx) * 65536 + cy + dy) ?? []) {
          const o = i * 3;
          if (Math.abs(nav.xyz[o + 2] - p[2]) > rise) continue;
          const d = (nav.xyz[o] - p[0]) ** 2 + (nav.xyz[o + 1] - p[1]) ** 2 + ((nav.xyz[o + 2] - p[2]) * 2) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    // A node found in this ring is as near as any further out can be, near enough.
    if (best >= 0 && r >= 1) break;
  }
  return best;
}

/**
 * The search arrays of a graph, allocated once: a node's slot counts for a search only while its stamp is that
 * search's number. The heap is two arrays of priorities and values, in the order of the former Heap class.
 */
function searchOf(nav) {
  return nav.search ??= {
    gen: 0,
    stamp: new Uint32Array(nav.count),
    closed: new Uint32Array(nav.count),
    g: new Float64Array(nav.count),
    parent: new Int32Array(nav.count),
    kind: new Uint8Array(nav.count),
    prio: new Float64Array(1024),
    node: new Int32Array(1024),
    size: 0,
  };
}

function heapPush(s, value, priority) {
  if (s.size === s.node.length) {
    const prio = new Float64Array(s.size * 2);
    prio.set(s.prio);
    s.prio = prio;
    const node = new Int32Array(s.size * 2);
    node.set(s.node);
    s.node = node;
  }
  const { prio, node } = s;
  let i = s.size++;
  prio[i] = priority;
  node[i] = value;
  while (i > 0) {
    const up = (i - 1) >> 1;
    if (prio[up] <= prio[i]) break;
    const p = prio[up];
    const n = node[up];
    prio[up] = prio[i];
    node[up] = node[i];
    prio[i] = p;
    node[i] = n;
    i = up;
  }
}

function heapPop(s) {
  const { prio, node } = s;
  const top = node[0];
  const last = --s.size;
  if (last > 0) {
    prio[0] = prio[last];
    node[0] = node[last];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < last && prio[l] < prio[m]) m = l;
      if (r < last && prio[r] < prio[m]) m = r;
      if (m === i) break;
      const p = prio[m];
      const n = node[m];
      prio[m] = prio[i];
      node[m] = node[i];
      prio[i] = p;
      node[i] = n;
      i = m;
    }
  }
  return top;
}

// The start nodes whose floods stay cached: a few KB each.
const FLOODS = 2048;

/** True when the graph has a way from one node to another. One flood per start node serves every target (cached on the graph). */
export function canReach(nav, from, to) {
  const floods = (nav.floods ??= new Map());
  let bits = floods.get(from);
  if (!bits) {
    if (floods.size >= FLOODS) floods.clear();
    bits = new Uint8Array((nav.count >> 3) + 1);
    const stack = nav.floodStack ??= new Int32Array(nav.count);
    let top = 0;
    stack[top++] = from;
    bits[from >> 3] |= 1 << (from & 7);
    while (top) {
      const at = stack[--top];
      for (let e = nav.offsets[at]; e < nav.offsets[at + 1]; e++) {
        const next = nav.to[e];
        if (bits[next >> 3] & (1 << (next & 7))) continue;
        bits[next >> 3] |= 1 << (next & 7);
        stack[top++] = next;
      }
    }
    floods.set(from, bits);
  }
  return Boolean(bits[to >> 3] & (1 << (to & 7)));
}

/**
 * The length of each edge, longer toward a floor with fewer ways out: such a floor lies by a wall, and the way keeps
 * to the middle of a passage. Made once for a graph; findPath adds it to the cost as it was, for the same sums.
 */
function edgeWeights(nav) {
  if (nav.edgeWeights) return nav.edgeWeights;
  const { xyz, offsets, to } = nav;
  const out = new Float64Array(to.length);
  for (let at = 0; at < nav.count; at++) {
    for (let e = offsets[at]; e < offsets[at + 1]; e++) {
      const next = to[e];
      const narrow = 8 - (offsets[next + 1] - offsets[next]);
      const length = Math.hypot(xyz[at * 3] - xyz[next * 3], xyz[at * 3 + 1] - xyz[next * 3 + 1], xyz[at * 3 + 2] - xyz[next * 3 + 2]);
      out[e] = length * (1 + Math.max(0, narrow) * 0.08);
    }
  }
  nav.edgeWeights = out;
  return out;
}

/**
 * The shortest way between two nodes (A*): [{point, kind}] from the first to the last; null when none. `avoid` holds
 * edges to leave out, as `from * nav.count + to`. The order of the heap decides ties: keep it when this changes.
 */
export function findPath(nav, from, to, limit = 20000, avoid = null) {
  if (from < 0 || to < 0) return null;
  // No way at all: the search would read up to `limit` nodes for the same null. The flood of `from` is cached.
  if (!canReach(nav, from, to)) return null;
  const { xyz, offsets } = nav;
  const dist = (a, b) => Math.hypot(xyz[a * 3] - xyz[b * 3], xyz[a * 3 + 1] - xyz[b * 3 + 1], xyz[a * 3 + 2] - xyz[b * 3 + 2]);
  const s = searchOf(nav);
  if (++s.gen === 0xffffffff) {
    s.stamp.fill(0);
    s.closed.fill(0);
    s.gen = 1;
  }
  const { gen, stamp, closed, g, parent, kind } = s;
  const weight = edgeWeights(nav);
  s.size = 0;
  stamp[from] = gen;
  g[from] = 0;
  parent[from] = -1;
  kind[from] = WALK;
  heapPush(s, from, dist(from, to));
  let done = 0;
  while (s.size && done < limit) {
    const at = heapPop(s);
    if (at === to) {
      const path = [];
      for (let k = at; k !== -1; k = parent[k]) path.push({ point: nodePoint(nav, k), kind: kind[k], node: k });
      return path.reverse();
    }
    if (closed[at] === gen) continue;
    closed[at] = gen;
    done++;
    for (let e = offsets[at]; e < offsets[at + 1]; e++) {
      const next = nav.to[e];
      // An edge the walker failed (bot.js): left out.
      if (avoid?.has(at * nav.count + next)) continue;
      const cost = g[at] + weight[e] + KIND_COST[nav.kinds[e]];
      if (stamp[next] !== gen || cost < g[next]) {
        stamp[next] = gen;
        g[next] = cost;
        parent[next] = at;
        kind[next] = nav.kinds[e];
        heapPush(s, next, cost + dist(next, to));
      }
    }
  }
  return null;
}
