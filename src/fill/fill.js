// Fills a POV timeline: each player that the recorder did not get from the server gets an estimated place in the
// rows, from what the demo still holds of it (the radar, its sounds, its shots, its body) and from the level. The
// archived demo never changes; every estimated sample has the ESTIMATE flag and its span is in
// `timeline.estimates` ({entity, t0, t1, kind}); `timeline.fill` holds the version of the fill and its counts.

import { ESTIMATE } from '../shared/estimates.js';
import { HULL_DUCK, HULL_STAND, fits, traceBox } from '../shared/game/hull.js';
import { nodeAt } from './graph.js';
import { lowerBound, tracksOf, windowsOf } from './rounds.js';
import { fatPvs, holds, holdsAny, leafAt, pasOf, playerLeafs } from './vis.js';
import { guidesFor } from './routes.js';
import { findWay } from './way.js';

export { ESTIMATE };
export const FILL_VERSION = 4;

// Seconds between two known places of a player above which the time between them is a span to fill.
const MIN_GAP = 0.3;
// Seconds between a hint and the next known place from which the rows between them get the player.
const SHORT_GAP = 0.05;
// Seconds at the ends of a span in which a seen place costs nothing: the player is on the edge of the set there.
const GRACE = 0.4;
// Units a second. A hint that needs more than this from the known place before it is not this player's.
const HINT_SPEED = 330;
// Units. A seen player within this of a spawn stands on it.
const ON_SPAWN = 40;
// Seconds after the first known place of a player in which its next known places help to choose its guide.
const LATER = 8;
// Seconds with no player in the rows from which the demo has no packets there.
const BLANK = 1;
// Seconds with no step sound from which a player did not run in the recorder's hearing.
const SILENT = 1;
// Seconds. A shorter span needs no guide: the two known places say enough.
const GUIDED = 2.5;
// The cost of a second 100 units from the guide, and the distance past which a floor costs no more.
const GUIDE_COST = 1;
const GUIDE_FAR = 800;
// Units from its guide within which a player takes the guide's yaw.
const GUIDE_LOOK = 250;
// The cost of a second under which a way follows its guide well enough: about 80 units beside it.
const GOOD_COST = 0.8;
// How much faster than a run a way may be, tried in this order, before the straight line.
const SPEEDS = [1, 1.3, 2];
// Units a second: the fastest that an estimated player goes where its time allows (a run is 250).
const PACE = 255;
// Units a second over which a part of a chain of ways takes time from the parts beside it. The walk graph makes a
// way some percent longer than it is, so a part at the speed of a run stays as it is.
const CHAIN_PACE = 290;
// The sounds that a player makes at its own origin.
const OWN_SOUND = /^(player\/pl_|player\/bhit_|player\/headshot|weapons\/|items\/)/;
const PITCH_LEVEL = 900 << 4;
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * The timeline with the hidden players filled. `level`: {nav, hull, vis, spawns: [{side, origin}], routes}.
 * `routes` is optional (src/fill/routes.js): with it a hidden player follows the route of a real player.
 * Returns the same object when the timeline is no POV demo or holds no eye.
 */
export function fillTimeline(timeline, level) {
  if (timeline.source?.kind !== 'pov' || !timeline.eyes?.length || timeline.fill) return timeline;
  const ctx = context(timeline, level);
  const ways = new Map();
  const estimates = [];
  const count = { ways: 0, guided: 0, relaxed: 0, straight: 0, seen: 0 };

  for (const win of ctx.windows) {
    // The players with a known place first: their guides name the real rounds that the others of their team follow.
    const lives = [];
    for (const entity of ctx.entities) {
      const life = lifeOf(ctx, win, entity);
      if (life) lives.push({ entity, life, known: knownOf(ctx, entity, life) });
    }
    lives.sort((x, y) => (x.known.length ? 0 : 1) - (y.known.length ? 0 : 1));
    for (const { entity, life, known } of lives) {
      const side = life.side;
      const add = (a, b, open, before = null, after = null, laters = null, short = false) => {
        const way = short ? straight(a, b) : wayOf(ctx, { entity, side, a, b, win, open, before, after, laters, until: life.t1 });
        if (!way) return;
        count.ways++;
        if (way.speed > 1) count.relaxed++;
        if (way.straight) count.straight++;
        if (way.guided) count.guided++;
        count.seen += way.seen;
        if (!ways.has(entity)) ways.set(entity, []);
        // Two ways that meet at a hint are one way: the time of a hint is not as exact as its place, and a way
        // that is too fast on one side of it takes the time from the other side.
        const list = ways.get(entity);
        const last = list.at(-1);
        if (last && a && a.kind !== 'seen' && Math.abs(last.at(-1).t - way.points[0].t) < 0.01) {
          last.push(...way.points.slice(1));
          pace(last, CHAIN_PACE);
        } else list.push(way.points);
        estimates.push({ entity, t0: round2(way.points[0].t), t1: round2(way.points.at(-1).t), kind: way.kind });
      };
      if (!known.length) {
        if (life.fromSpawn) add(null, null, 'both');
        continue;
      }
      if (life.fromSpawn && known[0].t - life.t0 > MIN_GAP) add(null, known[0], 'start', null, known[1], known.slice(1, 5).filter((p) => p.t - known[0].t < LATER && !p.leap));
      // No way into a leap: the game moved the player there (a respawn before the round's own clock).
      for (let i = 1; i < known.length; i++) {
        const [p, q] = [known[i - 1], known[i]];
        if (q.leap) continue;
        if (q.t - p.t > MIN_GAP) add(p, q, null, known[i - 2], known[i + 1]);
        // A short time between a hint and the next known place: without a way the player is gone for a moment and
        // comes back some steps away.
        else if (q.t - p.t > SHORT_GAP && (p.kind !== 'seen' || q.kind !== 'seen')) add(p, q, null, null, null, null, true);
      }
      if (life.t1 - known.at(-1).t > MIN_GAP) add(known.at(-1), null, 'end', known.at(-2));
    }
  }

  // The estimated players into the rows: every row inside a way that does not hold the player.
  const cursors = new Map([...ways].map(([entity, list]) => [entity, { list: list.sort((x, y) => x[0].t - y[0].t), way: 0, at: 0 }]));
  const samples = timeline.samples.map((row) => {
    let out = row;
    for (const [entity, c] of cursors) {
      while (c.way < c.list.length && c.list[c.way].at(-1).t < row[0]) {
        c.way++;
        c.at = 0;
      }
      const points = c.list[c.way];
      if (!points || points[0].t > row[0]) continue;
      if (holdsEntity(row, entity)) continue;
      while (c.at + 2 < points.length && points[c.at + 1].t <= row[0]) c.at++;
      const p = points[c.at];
      const q = points[c.at + 1] ?? p;
      const k = q.t > p.t ? Math.min(1, Math.max(0, (row[0] - p.t) / (q.t - p.t))) : 0;
      if (out === row) out = row.slice();
      const yaw = p.yaw + shortTurn(q.yaw - p.yaw) * k;
      out.push(entity, Math.round(p.x + (q.x - p.x) * k), Math.round(p.y + (q.y - p.y) * k), Math.ceil(p.z + (q.z - p.z) * k),
        Math.round(((yaw % 3600) + 3600) % 3600), ctx.flagsOf(entity, row[0]) | PITCH_LEVEL | ESTIMATE);
    }
    return out;
  });
  estimates.sort((x, y) => x.t0 - y.t0);
  const loadouts = handsOf(timeline, estimates);
  const anims = posesOf(timeline, ways);
  return { ...timeline, samples, loadouts, anims, estimates, fill: { version: FILL_VERSION, ...count, lag: ctx.lag } };
}

/** The weapon key of a shot's event: "mp5n" and the two hands of the elites have other names than their models. */
const shotKey = (weapon) => (weapon === 'mp5n' ? 'mp5' : weapon.startsWith('elite') ? 'elite' : weapon);

/**
 * The weapons in hand (`loadouts`: [t, entity, key]) with the changes of a hidden player inside its hidden time. A
 * demo shows a new weapon only when it shows the player again; the player took it before that. From its spawn it
 * holds the weapon it is first seen with; later it changes in the middle of the hidden time, or just before its
 * first hidden shot with that weapon.
 */
export function handsOf(timeline, estimates) {
  const spans = new Map();
  for (const span of estimates) {
    if (!spans.has(span.entity)) spans.set(span.entity, []);
    spans.get(span.entity).push(span);
  }
  // The hidden time that ends at t: the spans of the player that follow each other without a seen sample between.
  const hiddenUntil = (entity, t) => {
    const list = spans.get(entity) ?? [];
    let i = list.findIndex((span) => Math.abs(span.t1 - t) <= 0.15);
    if (i < 0) return null;
    let kind = list[i].kind;
    while (i > 0 && Math.abs(list[i - 1].t1 - list[i].t0) <= 0.05 && list[i].kind !== 'start') {
      i--;
      kind = list[i].kind;
    }
    return { t0: list[i].t0, fromSpawn: kind === 'start' || kind === 'both' };
  };
  const hiddenAt = (entity, t) => (spans.get(entity) ?? []).some((span) => t > span.t0 + 0.15 && t < span.t1 - 0.15);
  const shots = (timeline.shots ?? []).map(([t, entity, weapon]) => [t, entity, shotKey(weapon)]);
  const rows = (timeline.loadouts ?? []).map((row) => {
    const [t, entity, key] = row;
    const hidden = hiddenUntil(entity, t);
    if (!hidden) return row;
    const shot = shots.find((x) => x[1] === entity && x[2] === key && x[0] > hidden.t0 && x[0] < t);
    const at = hidden.fromSpawn ? hidden.t0 + 0.1 : Math.min(hidden.t0 + (t - hidden.t0) / 2, shot ? shot[0] - 0.3 : Infinity);
    return [round2(Math.max(hidden.t0 + 0.05, at)), entity, key];
  }).sort((a, b) => a[0] - b[0]);
  // A shot of a hidden player with another weapon than the one in its hand: it changed before the shot.
  for (const [t, entity, key] of shots) {
    if (!hiddenAt(entity, t)) continue;
    let last = -1;
    for (let i = 0; i < rows.length && rows[i][0] <= t; i++) if (rows[i][1] === entity) last = i;
    if (last >= 0 && rows[last][2] === key) continue;
    let at = rows.findIndex((row) => row[0] > t - 0.3);
    if (at < 0) at = rows.length;
    rows.splice(at, 0, [round2(t - 0.3), entity, key]);
  }
  return rows;
}

// The leg sequences of a player model: idle, walk, run.
const GAIT = { idle: 1, walk: 3, run: 4 };
// Units a second from which the legs walk and run (the game's walk is about 130).
const WALKS = 20;
const RUNS = 140;

/**
 * The animations (`anims`: [t, entity, sequence, gait]) with rows for the estimated ways: the legs run, walk or
 * stand as the way goes, and the body keeps the pose of the player's nearest real row that is no death. The rows of
 * the demo stay; at the end of a way the real pose is back.
 */
export function posesOf(timeline, ways) {
  const real = new Map();
  let top = 0;
  for (const row of timeline.anims ?? []) {
    if (!real.has(row[1])) real.set(row[1], []);
    real.get(row[1]).push(row);
    if (row[2] > top) top = row[2];
  }
  // The deaths are the last ten sequences of a player model (101 to 110 in CS 1.6, 85 to 94 before).
  const dead = (sequence) => top >= 80 && sequence > top - 10;
  const added = [];
  for (const [entity, list] of ways) {
    const rows = real.get(entity) ?? [];
    list.forEach((points, n) => {
      const t0 = points[0].t;
      const t1 = points.at(-1).t;
      const before = rows.findLast((row) => row[0] <= t0);
      const after = rows.find((row) => row[0] >= t1 - 0.02 && !dead(row[2]));
      const lastAlive = rows.findLast((row) => row[0] <= t0 && !dead(row[2]));
      // A way from a spawn has no pose of this life before it: the pose that the demo first shows.
      const pose = (before && !dead(before[2]) ? before : after ?? lastAlive)?.[2];
      if (pose === undefined) return;
      let gait = null;
      for (let i = 0; i + 1 < points.length; i++) {
        const [p, q] = [points[i], points[i + 1]];
        if (q.t - p.t < 0.01) continue;
        const speed = Math.hypot(q.x - p.x, q.y - p.y) / (q.t - p.t);
        const now = speed >= RUNS ? GAIT.run : speed >= WALKS ? GAIT.walk : GAIT.idle;
        if (now === gait) continue;
        gait = now;
        added.push([round2(p.t), entity, pose, gait]);
      }
      // The real pose again where the demo shows the player again, unless a row of the demo or the next way does it.
      const next = list[n + 1];
      if (gait === null || (next && next[0].t - t1 < 0.05) || rows.some((row) => Math.abs(row[0] - t1) <= 0.15)) return;
      const back = rows.findLast((row) => row[0] <= t1);
      if (back) added.push([round2(t1), entity, back[2], back[3]]);
    });
  }
  return [...(timeline.anims ?? []), ...added].sort((a, b) => a[0] - b[0]);
}

/** What the fill reads of a timeline, indexed once. */
function context(timeline, level) {
  const { nav, vis } = level;
  const tracks = tracksOf(timeline);
  const windows = windowsOf(timeline, tracks);
  // A round with play: a kill in it. In a pause or a warm-up a player with no known place stays on its spawn.
  for (const win of windows) win.play = (timeline.kills ?? []).some((k) => k.t >= win.t0 && k.t < win.t1);
  const byEntity = (rows, at = 1) => {
    const out = new Map();
    for (const row of rows ?? []) {
      if (!out.has(row[at])) out.set(row[at], []);
      out.get(row[at]).push(row);
    }
    return out;
  };
  const sides = byEntity(timeline.sides);
  const attribs = byEntity(timeline.attribs);
  const lastRow = (rows, t) => {
    let hit = null;
    for (const row of rows ?? []) {
      if (row[0] > t) break;
      hit = row;
    }
    return hit;
  };
  const sideOf = (entity, t) => lastRow(sides.get(entity), t)?.[2] ?? null;
  const leftAt = (entity, side, from, to) => (sides.get(entity) ?? []).find((row) => row[0] > from && row[0] < to && row[2] !== side)?.[0] ?? null;
  const entities = [...new Set([...tracks.keys(), ...sides.keys()])].filter((e) => e >= 1).sort((a, b) => a - b);
  const stepNames = (timeline.soundNames ?? []).map((name) => OWN_SOUND.test(name));
  const hints = new Map();
  const hint = (entity, row) => {
    if (!hints.has(entity)) hints.set(entity, []);
    hints.get(entity).push(row);
  };
  // The messages of a demo run ahead of its samples (the client shows the world a moment late): a hint is that
  // much earlier on the clock of the samples.
  const lag = lagOf(timeline, tracks, stepNames);
  for (const [t, entity, x, y, z] of timeline.radar ?? []) hint(entity, { t: t - lag, x, y, z, kind: 'radar' });
  for (const [t, entity, x, y, z, yaw] of timeline.fires ?? []) hint(entity, { t: t - lag, x, y, z, yaw: ((yaw % 3600) + 3600) % 3600, kind: 'fire' });
  for (const [t, name, entity, x, y, z] of timeline.sounds ?? []) if (stepNames[name] && entity >= 1) hint(entity, { t: t - lag, x, y, z, kind: 'sound' });
  const deaths = byEntity((timeline.kills ?? []).map((k) => [k.t, k.victim]));
  const corpses = byEntity(timeline.corpses);

  // The set of the recorder's eye at a time, kept for the last time asked.
  const eyes = timeline.eyes;
  let eyeIndex = -2;
  const set = new Uint8Array(vis.rowBytes);
  let setOk = false;
  const leafs = new Map();
  // The times when the demo holds no player at all: its packets are not there (the start of a recording, before
  // the first full update), so nothing says that the server did not send a player.
  const blanks = [];
  let blankFrom = null;
  for (const row of timeline.samples) {
    if (row.length === 1) blankFrom ??= row[0];
    else if (blankFrom !== null) {
      if (row[0] - blankFrom >= BLANK) blanks.push([blankFrom, row[0]]);
      blankFrom = null;
    }
  }
  if (blankFrom !== null) blanks.push([blankFrom, Infinity]);
  // The way search asks for many floors at one time: the answer of the last time stays.
  let blankT = NaN;
  let blankNow = false;
  const blank = (t) => {
    if (t !== blankT) {
      blankT = t;
      blankNow = blanks.some(([from, to]) => t >= from && t <= to);
    }
    return blankNow;
  };
  const seenAt = (node, t) => {
    let lo = 0;
    let hi = eyes.length - 1;
    if (eyes[0][0] > t || blank(t)) return false;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (eyes[mid][0] <= t) lo = mid; else hi = mid - 1;
    }
    if (lo !== eyeIndex) {
      eyeIndex = lo;
      const eye = [eyes[lo][1], eyes[lo][2], eyes[lo][3]];
      setOk = leafAt(vis, eye) !== 0;
      if (setOk) fatPvs(vis, eye, set);
    }
    if (!setOk) return false;
    let list = leafs.get(node);
    if (!list) {
      list = playerLeafs(vis, [nav.xyz[node * 3], nav.xyz[node * 3 + 1], nav.xyz[node * 3 + 2]]);
      leafs.set(node, list);
    }
    return holdsAny(set, list);
  };
  // Whether the recorder hears a sound at a floor: its place is in the audible set of the floor's leaf.
  const nodeLeaf = new Int32Array(nav.count).fill(-1);
  let earIndex = -2;
  let ear = 0;
  const heardAt = (node, t) => {
    let lo = 0;
    let hi = eyes.length - 1;
    if (eyes[0][0] > t) return false;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (eyes[mid][0] <= t) lo = mid; else hi = mid - 1;
    }
    if (lo !== earIndex) {
      earIndex = lo;
      ear = leafAt(vis, [eyes[lo][1], eyes[lo][2], eyes[lo][3]]);
    }
    if (ear === 0) return false;
    if (nodeLeaf[node] < 0) nodeLeaf[node] = leafAt(vis, [nav.xyz[node * 3], nav.xyz[node * 3 + 1], nav.xyz[node * 3 + 2]]);
    return nodeLeaf[node] !== 0 && holds(pasOf(vis, nodeLeaf[node]), ear);
  };
  // Whether the recorder gets the radar of a player through a span: the same side, and the recorder lives.
  const recorderAt = (t) => (timeline.recorders ?? [[0, timeline.recorder]]).findLast((r) => r[0] <= t)?.[1] ?? timeline.recorder;
  const onRadar = (entity, side, t0, t1) => {
    const recorder = recorderAt(t0);
    if (recorder === entity || sideOf(recorder, t0) !== side) return false;
    const track = tracks.get(recorder) ?? [];
    let last = t0;
    for (let i = lowerBound(track, t0 - 0.5); i < track.length && track[i][0] <= t1 + 0.5; i++) {
      if (track[i][0] - last > 1.2) return false;
      last = track[i][0];
    }
    return t1 - last <= 1.2 && last > t0 - 0.5 && track.length > 0;
  };
  const flagsOf = (entity, t) => (sideOf(entity, t) === 'CT' ? 4 : 0) | ((lastRow(attribs.get(entity), t)?.[2] ?? 0) & 2);
  return { timeline, level, windows, tracks, entities, sideOf, leftAt, onRadar, heardAt, lag, hints, deaths, corpses, seenAt, flagsOf };
}

/**
 * Seconds that the messages of a timeline run ahead of its samples: the shift at which the sounds of the seen
 * players lie nearest their own samples. 0 when too few sounds of running players are there.
 */
export function lagOf(timeline, tracks, own) {
  const picks = [];
  for (const [t, name, entity, x, y] of timeline.sounds ?? []) {
    if (!own[name] || entity < 1) continue;
    const track = tracks.get(entity);
    if (!track) continue;
    const i = lowerBound(track, t);
    const [p, q] = [track[i - 3], track[i + 3]];
    // A running player only: a standing one fits every shift.
    if (!p || !q || q[0] - p[0] > 0.6 || Math.hypot(q[1] - p[1], q[2] - p[2]) < 150 * (q[0] - p[0])) continue;
    picks.push([t, track, x, y]);
    if (picks.length >= 600) break;
  }
  if (picks.length < 30) return 0;
  let best = 0;
  let bestError = Infinity;
  for (let lag = -0.1; lag <= 0.4001; lag += 0.01) {
    const errors = [];
    for (const [t, track, x, y] of picks) {
      const i = lowerBound(track, t - lag);
      const [a, b] = [track[i - 1], track[i]];
      if (!a || !b || b[0] - a[0] > 0.3) continue;
      const k = b[0] > a[0] ? (t - lag - a[0]) / (b[0] - a[0]) : 0;
      errors.push(Math.hypot(a[1] + (b[1] - a[1]) * k - x, a[2] + (b[2] - a[2]) * k - y));
    }
    errors.sort((m, n) => m - n);
    const middle = errors[errors.length >> 1] ?? Infinity;
    if (middle < bestError) [best, bestError] = [lag, middle];
  }
  return Math.round(best * 100) / 100;
}

/** The life of a player in a window: {t0, t1, side, fromSpawn, died}; null when it has no side there. */
function lifeOf(ctx, win, entity) {
  const side = ctx.sideOf(entity, win.t0 + 0.1) ?? ctx.sideOf(entity, win.t1 - 0.1);
  if (side !== 'T' && side !== 'CT') return null;
  const death = (ctx.deaths.get(entity) ?? []).find((d) => d[0] >= win.t0 && d[0] < win.t1);
  const onStart = ctx.sideOf(entity, win.t0 + 0.1) === side;
  // A player that leaves its side (a spectator, a disconnect) is gone from then.
  const left = ctx.leftAt(entity, side, win.t0 + 0.1, win.t1);
  const t1 = Math.min(death ? death[0] : win.t1, left ?? Infinity);
  return { t0: win.t0, t1, side, fromSpawn: win.round && onStart, died: Boolean(death) && death[0] === t1 };
}

/** The known places of a player in a life, in order: its seen samples, then the hints between them. */
function knownOf(ctx, entity, life) {
  const out = [];
  const track = ctx.tracks.get(entity) ?? [];
  // A row at the very start of a round can still hold the place of the round before.
  for (let i = lowerBound(track, life.t0 + 0.1); i < track.length && track[i][0] <= life.t1; i++) {
    const [t, x, y, z, yaw] = track[i];
    out.push({ t, x, y, z, yaw, kind: 'seen' });
  }
  const hints = (ctx.hints.get(entity) ?? []).filter((h) => h.t > life.t0 + 0.05 && h.t < life.t1);
  if (life.died) {
    // The body lies where the player died: the server sends it some seconds after the kill.
    const body = (ctx.corpses.get(entity) ?? []).find((c) => c[0] >= life.t1 && c[0] < life.t1 + 8);
    if (body) hints.push({ t: life.t1, x: body[2], y: body[3], z: body[4], kind: 'body' });
  }
  if (!hints.length) return out;
  const all = [...out, ...hints].sort((a, b) => a.t - b.t);
  const far = (from, to) => Math.hypot(to.x - from.x, to.y - from.y) > HINT_SPEED * (to.t - from.t) + 64;
  const kept = [];
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    const last = kept.at(-1);
    if (p.kind !== 'seen') {
      // A hint beside a seen sample adds nothing; one that no run reaches from the place before is another's.
      const near = (q) => q && q.kind === 'seen' && Math.abs(q.t - p.t) < MIN_GAP / 2;
      if (near(all[i - 1]) || near(all[i + 1])) continue;
      if (last && (far(last, p) || p.t - last.t < 0.05)) continue;
    } else if (last && last.kind !== 'seen' && far(last, p)) {
      // No run joins the hints before to this seen sample. Hints that lie off the way from the known place before
      // them are another's and go; when that place is as far, the player itself leapt (a respawn).
      let k = kept.length - 1;
      while (k >= 0 && kept[k].kind !== 'seen' && far(kept[k], p)) k--;
      if (k >= 0 && !far(kept[k], p)) kept.length = k + 1;
      else p.leap = true;
    } else if (last && far(last, p) && p.t - last.t > MIN_GAP) p.leap = true;
    kept.push(p);
  }
  return kept;
}

/** The estimated way of one span: {points: [{t, x, y, z, yaw}], kind, speed, straight, seen}. */
function wayOf(ctx, { entity, side, a, b, win, open, before, after, laters, until }) {
  const { nav, hull, spawns, routes } = ctx.level;
  const t0 = a ? a.t : win.t0;
  const t1 = b ? b.t : until;
  if (t1 - t0 <= MIN_GAP) return null;
  let starts;
  if (a) {
    const node = floorOf(nav, a);
    if (node < 0) return b ? straight(a, b) : null;
    starts = [{ node, cost: 0 }];
  } else {
    // A free spawn of the side: one that no seen player stands on at the round's start.
    const taken = [];
    for (const track of ctx.tracks.values()) {
      const i = lowerBound(track, win.t0 + 0.2);
      if (i < track.length && track[i][0] < win.t0 + 3) taken.push(track[i]);
    }
    win.spawned ??= new Set();
    starts = (spawns ?? []).filter((s) => s.side === side && !taken.some((p) => Math.hypot(p[1] - s.origin[0], p[2] - s.origin[1]) < ON_SPAWN))
      .map((s) => ({ node: nodeAt(nav, s.origin, 4), cost: 0 })).filter((s) => s.node >= 0 && !win.spawned.has(s.node));
    if (!starts.length) return null;
  }
  const end = b ? floorOf(nav, b) : -1;
  if (b && end < 0) return a ? straight(a, b) : null;
  const graceFrom = a?.kind === 'seen' ? t0 + GRACE : t0;
  const graceTo = b?.kind === 'seen' ? t1 - GRACE : t1;
  // A hint inside the recorder's set: the demo heard the player there and did not get it, so the set hides
  // nothing of this player now, and a way that left the set between such hints would be a detour.
  const heardInSet = (p, node) => Boolean(p) && p.kind !== 'seen' && node >= 0 && ctx.seenAt(node, p.t);
  const heard = heardInSet(a, a ? starts[0].node : -1) || heardInSet(b, end);
  const seenAt = heard ? null : (node, t) => t > graceFrom && t < graceTo && ctx.seenAt(node, t);
  // The guides: real players of the routes that fit the known ends. Each gives a way; the cheapest stays.
  let guides = [];
  const clock = (t) => t - win.goAt;
  // A teammate of a living recorder with no radar row did not move (the radar sends each one that moves): it
  // needs no guide, and takes the short way between its known places.
  const quiet = ctx.onRadar(entity, side, t0, t1);
  if (routes && win.round && t1 - t0 >= GUIDED && (a || b || win.play) && !quiet) {
    const end = (p) => p && { x: p.x, y: p.y, z: p.z, at: clock(p.t) };
    // The way a player goes at a known place: from the known place before it, or to the one after it.
    const wayAt = (p, q) => {
      if (!p || !q || Math.abs(q.t - p.t) > 1.5) return null;
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      return length > 8 ? [(q.x - p.x) / length, (q.y - p.y) / length] : null;
    };
    const heading = wayAt(before, a);
    const headingB = wayAt(b, after);
    win.used ??= new Set();
    guides = guidesFor(routes, { side: side === 'CT' ? 1 : 0, a: end(a), b: end(b), until: clock(t1), heading, headingB, laterB: laters?.map(end), used: win.used, rounds: (win.teams ??= { T: new Set(), CT: new Set() })[side], seed: entity * 131 + Math.round(win.t0) });
  }
  const at = [0, 0, 0];
  const costOf = (guide) => (node, t) => {
    guide.at(clock(t), at);
    return (GUIDE_COST * Math.min(GUIDE_FAR, Math.hypot(nav.xyz[node * 3] - at[0], nav.xyz[node * 3 + 1] - at[1], (nav.xyz[node * 3 + 2] - at[2]) * 2))) / 100;
  };
  let way = null;
  let speed = 1;
  let guide = null;
  const cap = (GUIDE_COST * GUIDE_FAR) / 100;
  for (speed of SPEEDS) {
    // A span of a second or more with no step of the player: it did not run where the recorder hears.
    const base = { starts, end, t0, t1, seenAt, speed, goAt: a ? -Infinity : win.goAt, heardAt: t1 - t0 >= SILENT && !ctx.level.deaf ? ctx.heardAt : null };
    for (const g of guides.length ? guides : [null]) {
      const found = (g && findWay(nav, { ...base, costOf: costOf(g), cap })) || findWay(nav, { ...base, costOf: g ? costOf(g) : null });
      if (found && (!way || found.cost < way.cost)) [way, guide] = [found, g];
      // A way that follows its guide closely, out of the recorder's sight, is good: the other guides stay unread.
      if (found && g && found.seen === 0 && found.cost < (t1 - t0) * GOOD_COST) break;
    }
    if (way) break;
  }
  if (guide) {
    win.used.add(guide.route);
    win.teams[side].add(routes.round[guide.route]);
  }
  // One hidden player on a spawn.
  if (way && !a) win.spawned.add(way.steps[0].node);
  // No way at the speed of a run: the player took a way that the graph does not have (a jump over a gap or onto a
  // box). Where nothing stands between the two known places, that way is the straight line.
  if (a && b && (!way || speed > 1) && clearLine(hull, a, b)) return straight(a, b);
  if (!way) return a && b ? straight(a, b) : null;

  const points = way.steps.map(({ t, node }) => ({ t, x: nav.xyz[node * 3], y: nav.xyz[node * 3 + 1], z: nav.xyz[node * 3 + 2], yaw: null }));
  if (a) Object.assign(points[0], { x: a.x, y: a.y, z: a.z, yaw: a.yaw ?? null });
  if (b) Object.assign(points.at(-1), { x: b.x, y: b.y, z: b.z, yaw: b.yaw ?? null });
  smooth(points, hull);
  pace(points);
  if (guide) {
    // Near its guide the player looks where the real player looked.
    for (const p of points) {
      guide.at(clock(p.t), at);
      if (p.yaw === null && Math.hypot(p.x - at[0], p.y - at[1]) < GUIDE_LOOK) p.yaw = ((guide.yawAt(clock(p.t)) % 3600) + 3600) % 3600;
    }
  }
  turn(points);
  return { points, kind: open ?? (a.kind === 'seen' && b.kind === 'seen' ? 'between' : 'hint'), speed, straight: false, seen: way.seen, guided: Boolean(guide) };
}

/** The floor of a known place: a player in a jump or on a box is some cells from one. */
const floorOf = (nav, p) => {
  const node = nodeAt(nav, [p.x, p.y, p.z]);
  return node >= 0 ? node : nodeAt(nav, [p.x, p.y, p.z], 6);
};

/** Whether a ducked player passes from one place to the other in a straight line, a jump high (the legs up). */
function clearLine(hull, a, b) {
  if (!hull) return false;
  for (const lift of [0, 20, 45]) {
    const tr = traceBox(hull, HULL_DUCK, [a.x, a.y, a.z + lift], [b.x, b.y, b.z + lift]);
    if (!tr.startSolid && tr.fraction === 1) return true;
  }
  return false;
}

/** A span with no floor at one end: the straight line. */
function straight(a, b) {
  const points = [{ t: a.t, x: a.x, y: a.y, z: a.z, yaw: a.yaw ?? null }, { t: b.t, x: b.x, y: b.y, z: b.z, yaw: b.yaw ?? null }];
  turn(points);
  return { points, kind: 'straight', speed: 1, straight: true, seen: 0 };
}

/**
 * Moves the times of the inner points so that no part of the way is faster than a run, where the whole time
 * allows it: the time that a fast part needs comes out of the waits beside it.
 */
export function pace(points, speed = PACE) {
  const need = [];
  let whole = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    need.push(Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y, points[i + 1].z - points[i].z) / speed);
    whole += need[i];
  }
  const last = points.length - 1;
  const span = points[last].t - points[0].t;
  if (whole >= span) {
    // Too little time for a run: the same speed all the way.
    let at = points[0].t;
    for (let i = 0; i < last; i++) {
      at += whole > 0 ? (need[i] / whole) * span : span / last;
      points[i + 1].t = i + 1 === last ? points[last].t : at;
    }
    return;
  }
  for (let i = 0; i + 1 < last; i++) points[i + 1].t = Math.max(points[i + 1].t, points[i].t + need[i]);
  for (let i = last - 1; i >= 1; i--) points[i].t = Math.min(points[i].t, points[i + 1].t - need[i]);
}

/** Rounds the corners of a way: each inner point twice toward the middle of its neighbours, where the box still fits. */
function smooth(points, hull) {
  for (let pass = 0; pass < 2; pass++) {
    const from = points.map((p) => [p.x, p.y, p.z]);
    for (let i = 1; i + 1 < points.length; i++) {
      const [p, q, r] = [from[i - 1], from[i], from[i + 1]];
      // A player that stands stays where it stands.
      if ((p[0] === q[0] && p[1] === q[1]) || (r[0] === q[0] && r[1] === q[1])) continue;
      const at = [(p[0] + 2 * q[0] + r[0]) / 4, (p[1] + 2 * q[1] + r[1]) / 4, (p[2] + 2 * q[2] + r[2]) / 4];
      if (hull && !fits(hull, HULL_STAND, at)) continue;
      Object.assign(points[i], { x: at[0], y: at[1], z: at[2] });
    }
  }
}

/** The yaw of each point (tenths of a degree): the known one at an end, else the way the player goes. */
function turn(points) {
  let last = points.find((p) => p.yaw !== null)?.yaw ?? null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.yaw !== null) {
      last = p.yaw;
      continue;
    }
    const q = points[Math.min(i + 1, points.length - 1)];
    const o = points[Math.max(i - 1, 0)];
    const [dx, dy] = [q.x - o.x, q.y - o.y];
    if (Math.hypot(dx, dy) > 8) last = Math.round((((Math.atan2(dy, dx) * 1800) / Math.PI) + 3600) % 3600);
    p.yaw = last ?? 0;
  }
  // A known yaw at the end: the player turns to it over the last point.
  for (let i = 0; i < points.length; i++) points[i].yaw ??= 0;
}

function holdsEntity(row, entity) {
  for (let i = 1; i < row.length; i += 6) if (row[i] === entity) return true;
  return false;
}

/** The turn in tenths of a degree, the short way round. */
function shortTurn(d) {
  return ((((d + 5400) % 3600) + 3600) % 3600) - 1800;
}
