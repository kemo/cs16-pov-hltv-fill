// A small world for the tests of src/fill: a floor of 32-unit cells with walls, and the visibility of two rooms.

import { readNav, writeNav } from '../src/shared/game/nav.js';

/**
 * The walk graph of a grid. `rows`: strings, '#' a wall, anything else a floor; the cell of column c and row r is
 * at (c * 32, r * 32, 0). Returns {nav, at(c, r) -> node}.
 */
export function gridNav(rows) {
  const index = new Map();
  const nodes = [];
  rows.forEach((line, r) => [...line].forEach((ch, c) => {
    if (ch === '#') return;
    index.set(`${c},${r}`, nodes.length);
    nodes.push([c * 32, r * 32, 0]);
  }));
  const free = (c, r) => index.has(`${c},${r}`);
  const edges = nodes.map(([x, y]) => {
    const [c, r] = [x / 32, y / 32];
    const out = [];
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      // A diagonal step needs both cells beside it: no way through a corner.
      if (free(c + dc, r + dr) && (!dc || !dr || (free(c + dc, r) && free(c, r + dr)))) out.push([index.get(`${c + dc},${r + dr}`), 0]);
    }
    return out;
  });
  return { nav: readNav(writeNav({ nodes, edges })), at: (c, r) => index.get(`${c},${r}`) };
}

/**
 * The bytes of a BSP with two rooms, split at x = `wall`: leaf 1 where x is larger, leaf 2 where it is smaller.
 * `sees`: whether each room sees the other.
 */
export function twoRoomBsp(wall, sees) {
  const sizes = [0, 20, 0, 0, 2, 24, 0, 0, 0, 0, 3 * 28, 0, 0, 0, 64];
  const buf = Buffer.alloc(124 + sizes.reduce((a, b) => a + b, 0));
  buf.writeInt32LE(30, 0);
  const at = [];
  let offset = 124;
  sizes.forEach((size, n) => {
    at.push(offset);
    buf.writeInt32LE(offset, 4 + n * 8);
    buf.writeInt32LE(size, 8 + n * 8);
    offset += size;
  });
  // The plane x = wall, the node on it: the front child is leaf 1 (-2), the back child leaf 2 (-3).
  buf.writeFloatLE(1, at[1]);
  buf.writeFloatLE(wall, at[1] + 12);
  buf.writeInt32LE(0, at[1] + 16);
  buf.writeInt32LE(0, at[5]);
  buf.writeInt16LE(-2, at[5] + 4);
  buf.writeInt16LE(-3, at[5] + 6);
  // Leaf 0 is solid; the rows of leaves 1 and 2 are one byte each: bit 0 is leaf 1, bit 1 is leaf 2.
  buf.writeInt32LE(-2, at[10]);
  buf.writeInt32LE(-1, at[10] + 4);
  for (const leaf of [1, 2]) {
    buf.writeInt32LE(-1, at[10] + leaf * 28);
    buf.writeInt32LE(leaf - 1, at[10] + leaf * 28 + 4);
    buf[at[4] + leaf - 1] = sees ? 3 : 1 << (leaf - 1);
  }
  buf.writeInt32LE(2, at[14] + 52);
  return buf;
}
