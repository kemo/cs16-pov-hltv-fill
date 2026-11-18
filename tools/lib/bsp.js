// Reads GoldSrc levels (BSP version 30) and texture WADs (WAD3).

const LUMP = { ENTITIES: 0, PLANES: 1, TEXTURES: 2, VERTICES: 3, NODES: 5, TEXINFO: 6, FACES: 7, LIGHTING: 8, CLIPNODES: 9, LEAFS: 10, EDGES: 12, SURFEDGES: 13, MODELS: 14 };

export function readBsp(buf) {
  if (buf.readInt32LE(0) !== 30) throw new Error('Not a version 30 BSP.');
  const lump = (n) => ({ at: buf.readInt32LE(4 + n * 8), length: buf.readInt32LE(8 + n * 8) });

  const ent = lump(LUMP.ENTITIES);
  const entities = parseEntities(buf.toString('latin1', ent.at, ent.at + ent.length));

  const v = lump(LUMP.VERTICES);
  const vertices = [];
  for (let at = v.at; at < v.at + v.length; at += 12) vertices.push([buf.readFloatLE(at), buf.readFloatLE(at + 4), buf.readFloatLE(at + 8)]);

  const e = lump(LUMP.EDGES);
  const edges = [];
  for (let at = e.at; at < e.at + e.length; at += 4) edges.push([buf.readUInt16LE(at), buf.readUInt16LE(at + 2)]);

  const se = lump(LUMP.SURFEDGES);
  const surfedges = [];
  for (let at = se.at; at < se.at + se.length; at += 4) surfedges.push(buf.readInt32LE(at));

  const ti = lump(LUMP.TEXINFO);
  const texinfo = [];
  for (let at = ti.at; at < ti.at + ti.length; at += 40) {
    const f = (k) => buf.readFloatLE(at + k * 4);
    texinfo.push({ s: [f(0), f(1), f(2), f(3)], t: [f(4), f(5), f(6), f(7)], miptex: buf.readInt32LE(at + 32), flags: buf.readInt32LE(at + 36) });
  }

  const fl = lump(LUMP.FACES);
  const faces = [];
  for (let at = fl.at; at < fl.at + fl.length; at += 20) {
    faces.push({
      firstEdge: buf.readInt32LE(at + 4),
      numEdges: buf.readUInt16LE(at + 8),
      texinfo: buf.readUInt16LE(at + 10),
      styles: [buf[at + 12], buf[at + 13], buf[at + 14], buf[at + 15]],
      lightOffset: buf.readInt32LE(at + 16),
    });
  }

  const ml = lump(LUMP.MODELS);
  const models = [];
  for (let at = ml.at; at < ml.at + ml.length; at += 64) {
    const vec = (o) => [0, 1, 2].map((k) => buf.readFloatLE(at + o + k * 4));
    const headNodes = [0, 1, 2, 3].map((k) => buf.readInt32LE(at + 36 + k * 4));
    models.push({ mins: vec(0), maxs: vec(12), headNodes, firstFace: buf.readInt32LE(at + 56), numFaces: buf.readInt32LE(at + 60) });
  }

  const pl = lump(LUMP.PLANES);
  const planes = [];
  for (let at = pl.at; at < pl.at + pl.length; at += 20) {
    planes.push({ normal: [0, 1, 2].map((k) => buf.readFloatLE(at + k * 4)), dist: buf.readFloatLE(at + 12), type: buf.readInt32LE(at + 16) });
  }

  const cl = lump(LUMP.CLIPNODES);
  const clipnodes = [];
  for (let at = cl.at; at < cl.at + cl.length; at += 8) clipnodes.push({ plane: buf.readInt32LE(at), children: [buf.readInt16LE(at + 4), buf.readInt16LE(at + 6)] });

  // The tree of hull 0 (a point): nodes split by planes down to leaves, each leaf with its contents.
  const nl = lump(LUMP.NODES);
  const nodes = [];
  for (let at = nl.at; at < nl.at + nl.length; at += 24) nodes.push({ plane: buf.readInt32LE(at), children: [buf.readInt16LE(at + 4), buf.readInt16LE(at + 6)] });
  const ll = lump(LUMP.LEAFS);
  const leafs = [];
  for (let at = ll.at; at < ll.at + ll.length; at += 28) leafs.push({ contents: buf.readInt32LE(at) });

  const tl = lump(LUMP.TEXTURES);
  const textures = [];
  const count = buf.readInt32LE(tl.at);
  for (let i = 0; i < count; i++) {
    const offset = buf.readInt32LE(tl.at + 4 + i * 4);
    textures.push(offset < 0 ? { name: '', width: 16, height: 16, pixels: null } : readMiptex(buf, tl.at + offset));
  }

  const li = lump(LUMP.LIGHTING);
  return { entities, vertices, edges, surfedges, texinfo, faces, models, textures, planes, clipnodes, nodes, leafs, lighting: buf.subarray(li.at, li.at + li.length) };
}

export const CONTENTS_EMPTY = -1;
export const CONTENTS_SOLID = -2;

/**
 * The contents at a point in a clip hull, from its head node (models[n].headNodes[hull]). Hull 1 is a standing
 * player: the point is the origin, 36 units over the feet.
 */
export function pointContents(bsp, headNode, point) {
  let num = headNode;
  while (num >= 0) {
    const node = bsp.clipnodes[num];
    const plane = bsp.planes[node.plane];
    const d = plane.type < 3
      ? point[plane.type] - plane.dist
      : plane.normal[0] * point[0] + plane.normal[1] * point[1] + plane.normal[2] * point[2] - plane.dist;
    num = node.children[d < 0 ? 1 : 0];
  }
  return num;
}

/** A miptex: name, size and, where it is embedded, the first mip level and the palette that follows mip 3. */
export function readMiptex(buf, at) {
  const nameEnd = buf.indexOf(0, at);
  const name = buf.toString('latin1', at, Math.min(at + 16, nameEnd < 0 ? at + 16 : nameEnd)).toLowerCase();
  const width = buf.readUInt32LE(at + 16);
  const height = buf.readUInt32LE(at + 20);
  const mip0 = buf.readUInt32LE(at + 24);
  if (mip0 === 0) return { name, width, height, pixels: null, palette: null };
  const mip3 = buf.readUInt32LE(at + 36);
  const paletteAt = at + mip3 + (width / 8) * (height / 8) + 2;
  return {
    name,
    width,
    height,
    pixels: buf.subarray(at + mip0, at + mip0 + width * height),
    palette: buf.subarray(paletteAt, paletteAt + 768),
  };
}

/** The miptex textures of a WAD3 file, by lower-case name. */
export function readWad(buf) {
  if (buf.toString('latin1', 0, 4) !== 'WAD3') throw new Error('Not a WAD3 file.');
  const count = buf.readInt32LE(4);
  const table = buf.readInt32LE(8);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const at = table + i * 32;
    // Type 0x43 is a miptex; compression is never used.
    if (buf[at + 12] !== 0x43) continue;
    const tex = readMiptex(buf, buf.readInt32LE(at));
    out.set(tex.name, tex);
  }
  return out;
}

/** The entity lump: [{classname, key: value...}]. */
export function parseEntities(text) {
  const out = [];
  for (const block of text.matchAll(/\{([^}]*)\}/g)) {
    const entity = {};
    for (const [, key, value] of block[1].matchAll(/"([^"]*)"\s*"([^"]*)"/g)) entity[key] = value;
    out.push(entity);
  }
  return out;
}
