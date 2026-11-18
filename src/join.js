// One match that the recording split over several demos (an HLTV demo that stops at the half, an overtime in a
// new file): joins.json names the parts by the SHA-256 of each file, in order, and the import builds one timeline
// from them. Each part keeps its own clock; a later part starts GAP seconds after the end of the one before.

import { readFileSync } from 'node:fs';

/** Seconds between the end of one part and the start of the next. */
export const GAP = 1;

const TIMES = ['t', 't0', 't1', 'burst'];
const round2 = (n) => Math.round(n * 100) / 100;

/** A row ([t, ...]) or a record (t, t0, t1, burst, path) of a timeline with each time through `at`. */
export function retimed(item, at) {
  if (Array.isArray(item)) return [round2(at(item[0])), ...item.slice(1)];
  const out = { ...item };
  for (const key of TIMES) if (typeof out[key] === 'number') out[key] = round2(at(out[key]));
  if (Array.isArray(out.path)) out.path = out.path.map((p) => [round2(at(p[0])), ...p.slice(1)]);
  return out;
}

/** The joins of joins.json: [{parts: [sha256, ...], note}], each part at most once. */
export function readJoins(file = new URL('../joins.json', import.meta.url)) {
  let joins;
  try {
    joins = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const seen = new Set();
  for (const join of joins) {
    if (!Array.isArray(join.parts) || join.parts.length < 2) throw new Error(`A join needs two parts or more: ${join.note ?? '?'}`);
    for (const sha of join.parts) {
      if (seen.has(sha)) throw new Error(`A demo is a part of two joins: ${sha}`);
      seen.add(sha);
    }
  }
  return joins;
}

/** A row or a record of a later part on the clock of the joined timeline. */
function shifted(item, dt, soundIndex) {
  const out = retimed(item, (t) => t + dt);
  if (soundIndex && Array.isArray(out)) out[1] = soundIndex[out[1]];
  return out;
}

/**
 * The timelines of the parts as one, on the clock of the first. At each join every slot of the part before leaves
 * (a null name and side), because the next demo connects again and a slot can hold another player then.
 */
export function joinTimelines(parts) {
  const [first] = parts;
  for (const tl of parts) {
    if (tl.map !== first.map) throw new Error(`The parts of a join play different maps: ${first.map}, ${tl.map}`);
    if (tl.source.kind !== first.source.kind) throw new Error('The parts of a join are HLTV and POV demos');
    if (tl.version !== first.version) throw new Error('The parts of a join have timelines of different versions');
  }
  const joined = structuredClone(first);
  joined.source = { ...first.source, parts: parts.map((tl) => tl.source) };
  // A POV part can hold its recorder in another slot: [t, entity] from the start of each part.
  if (first.source.kind === 'pov') joined.recorders = [[0, first.recorder]];
  for (const tl of parts.slice(1)) {
    const dt = round2(joined.duration + GAP);
    const left = joined.duration;
    if (joined.recorders) joined.recorders.push([dt, tl.recorder]);
    for (const { entity } of joined.players) {
      joined.names.push([left, entity, null]);
      joined.sides.push([left, entity, null]);
    }
    const soundIndex = (tl.soundNames ?? []).map((name) => {
      let i = joined.soundNames.indexOf(name);
      if (i < 0) i = joined.soundNames.push(name) - 1;
      return i;
    });
    for (const [key, value] of Object.entries(tl)) {
      if (!Array.isArray(value) || key === 'players' || key === 'soundNames') continue;
      joined[key] = [...(joined[key] ?? []), ...value.map((item) => shifted(item, dt, key === 'sounds' ? soundIndex : null))];
    }
    // timeline.players keeps the last name of each slot, so a later part wins.
    const players = new Map(joined.players.map((p) => [p.entity, p]));
    for (const p of tl.players) players.set(p.entity, p);
    joined.players = [...players.values()];
    joined.duration = round2(dt + tl.duration);
  }
  return joined;
}
