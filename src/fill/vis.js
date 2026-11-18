// The visibility data of a GoldSrc level (BSP version 30): which leaves the server sends to a client at a point.
// The rules are the engine's: SV_FatPVS (the set of an eye), SV_FindTouchedLeafs and PF_checkvisibility (an entity
// against the set), CM_CalcPAS (the set of the sounds and the events).

const LUMP_PLANES = 1;
const LUMP_VISIBILITY = 4;
const LUMP_NODES = 5;
const LUMP_LEAFS = 10;
const LUMP_MODELS = 14;
const CONTENTS_SOLID = -2;
// SV_AddToFatPVS takes both sides of a plane nearer than this to the eye.
const FAT = 8;
// SV_LinkEdict grows the box of an entity by this on each side.
const LINK_GROW = 1;
// The box of a player around its origin: standing and ducking (hulls 1 and 3).
const STAND = [16, 16, 36];
const DUCK = [16, 16, 18];

/** The visibility data of a level from the bytes of its BSP. */
export function readVis(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getInt32(0, true) !== 30) throw new Error('Not a version 30 BSP.');
  const lump = (n) => ({ at: view.getInt32(4 + n * 8, true), length: view.getInt32(8 + n * 8, true) });

  const pl = lump(LUMP_PLANES);
  const planeCount = pl.length / 20;
  const planes = new Float32Array(planeCount * 4);
  const planeTypes = new Uint8Array(planeCount);
  for (let i = 0; i < planeCount; i++) {
    for (let k = 0; k < 4; k++) planes[i * 4 + k] = view.getFloat32(pl.at + i * 20 + k * 4, true);
    planeTypes[i] = view.getInt32(pl.at + i * 20 + 16, true);
  }

  const nl = lump(LUMP_NODES);
  const nodeCount = nl.length / 24;
  const nodePlanes = new Int32Array(nodeCount);
  const children = new Int16Array(nodeCount * 2);
  for (let i = 0; i < nodeCount; i++) {
    nodePlanes[i] = view.getInt32(nl.at + i * 24, true);
    children[i * 2] = view.getInt16(nl.at + i * 24 + 4, true);
    children[i * 2 + 1] = view.getInt16(nl.at + i * 24 + 6, true);
  }

  const ll = lump(LUMP_LEAFS);
  const leafCount = ll.length / 28;
  const contents = new Int32Array(leafCount);
  const visOffsets = new Int32Array(leafCount);
  for (let i = 0; i < leafCount; i++) {
    contents[i] = view.getInt32(ll.at + i * 28, true);
    visOffsets[i] = view.getInt32(ll.at + i * 28 + 4, true);
  }

  const vl = lump(LUMP_VISIBILITY);
  const ml = lump(LUMP_MODELS);
  // The leaves of the world model that have a row: leaf 0 is the solid leaf and has none.
  const visLeafs = view.getInt32(ml.at + 52, true);
  return {
    planes, planeTypes, nodePlanes, children, contents, visOffsets, visLeafs,
    data: new Uint8Array(bytes.buffer, bytes.byteOffset + vl.at, vl.length),
    rowBytes: (visLeafs + 7) >> 3,
    pvs: new Map(),
    pas: new Map(),
  };
}

const distance = (vis, plane, p) => {
  const type = vis.planeTypes[plane];
  if (type < 3) return p[type] - vis.planes[plane * 4 + 3];
  return vis.planes[plane * 4] * p[0] + vis.planes[plane * 4 + 1] * p[1] + vis.planes[plane * 4 + 2] * p[2] - vis.planes[plane * 4 + 3];
};

/** The leaf of a point; 0 is the solid leaf. */
export function leafAt(vis, p) {
  let node = 0;
  while (node >= 0) node = vis.children[node * 2 + (distance(vis, vis.nodePlanes[node], p) < 0 ? 1 : 0)];
  return -node - 1;
}

/** The leaves that a leaf sees, one bit each: bit n is leaf n + 1. A leaf with no row sees every leaf. */
export function pvsOf(vis, leaf) {
  let row = vis.pvs.get(leaf);
  if (row) return row;
  row = new Uint8Array(vis.rowBytes);
  const at = vis.visOffsets[leaf];
  if (leaf === 0 || at < 0 || !vis.data.length) row.fill(leaf === 0 ? 0 : 255);
  else {
    // Mod_DecompressVis: a zero byte, then how many zero bytes it stands for.
    for (let i = at, out = 0; out < vis.rowBytes;) {
      if (vis.data[i]) row[out++] = vis.data[i++];
      else {
        out += vis.data[i + 1];
        i += 2;
      }
    }
  }
  vis.pvs.set(leaf, row);
  return row;
}

/** The leaves that hear a leaf: the leaves that any leaf of its PVS sees (CM_CalcPAS). */
export function pasOf(vis, leaf) {
  let row = vis.pas.get(leaf);
  if (row) return row;
  const pvs = pvsOf(vis, leaf);
  row = new Uint8Array(pvs);
  for (let n = 0; n < vis.visLeafs; n++) {
    if (!(pvs[n >> 3] & (1 << (n & 7)))) continue;
    const other = pvsOf(vis, n + 1);
    for (let k = 0; k < row.length; k++) row[k] |= other[k];
  }
  vis.pas.set(leaf, row);
  return row;
}

/** The set that the server builds for an eye: the PVS of every leaf within 8 units of it (SV_FatPVS). */
export function fatPvs(vis, eye, out = new Uint8Array(vis.rowBytes)) {
  out.fill(0);
  const stack = [0];
  while (stack.length) {
    const node = stack.pop();
    if (node < 0) {
      const leaf = -node - 1;
      if (vis.contents[leaf] === CONTENTS_SOLID) continue;
      const row = pvsOf(vis, leaf);
      for (let k = 0; k < out.length; k++) out[k] |= row[k];
      continue;
    }
    const d = distance(vis, vis.nodePlanes[node], eye);
    if (d > FAT) stack.push(vis.children[node * 2]);
    else if (d < -FAT) stack.push(vis.children[node * 2 + 1]);
    else stack.push(vis.children[node * 2], vis.children[node * 2 + 1]);
  }
  return out;
}

/** Whether a set holds a leaf. */
export const holds = (set, leaf) => leaf > 0 && (set[(leaf - 1) >> 3] & (1 << ((leaf - 1) & 7))) !== 0;

/**
 * The leaves that the box of a player at `origin` touches (SV_FindTouchedLeafs). The box is the game's, one unit
 * larger on each side.
 */
export function playerLeafs(vis, origin, ducking = false) {
  const half = ducking ? DUCK : STAND;
  const out = [];
  const stack = [0];
  while (stack.length) {
    const node = stack.pop();
    if (node < 0) {
      if (vis.contents[-node - 1] !== CONTENTS_SOLID) out.push(-node - 1);
      continue;
    }
    const plane = vis.nodePlanes[node];
    const type = vis.planeTypes[plane];
    let reach;
    if (type < 3) reach = half[type] + LINK_GROW;
    else {
      reach = Math.abs(vis.planes[plane * 4]) * (half[0] + LINK_GROW) + Math.abs(vis.planes[plane * 4 + 1]) * (half[1] + LINK_GROW)
        + Math.abs(vis.planes[plane * 4 + 2]) * (half[2] + LINK_GROW);
    }
    const d = distance(vis, plane, origin);
    if (d >= -reach) stack.push(vis.children[node * 2]);
    if (d < reach) stack.push(vis.children[node * 2 + 1]);
  }
  return out;
}

/** Whether a set holds one of the leaves. */
export function holdsAny(set, leafs) {
  for (let i = 0; i < leafs.length; i++) if (holds(set, leafs[i])) return true;
  return false;
}

/** Whether the server sends a player at `origin` to a client with this set (PF_checkvisibility). */
export const playerSeen = (vis, set, origin, ducking = false) => holdsAny(set, playerLeafs(vis, origin, ducking));
