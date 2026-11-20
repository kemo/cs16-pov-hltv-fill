// Dead air: a stretch of a match where the game stands still (a server that hung while the HLTV proxy kept
// recording, a long pause) plays as KEPT seconds. Chat and every other row of the stretch stay, squeezed in order.

import { retimed } from './join.js';
import { ESTIMATE } from './shared/estimates.js';

/** Seconds without play that make a stretch dead air. */
export const QUIET = 30;
/** Seconds that a stretch of dead air keeps. */
export const KEPT = 2;
/** Seconds that a timeline keeps after the end of the round of its last kill. */
export const TAIL = 15;
/** Seconds that a timeline keeps after its last row. */
export const MARGIN = 1;
// Seconds from a round's end to the next round, in which a kill still belongs to the round that ended.
const POST_ROUND = 5;
// Players who fire within BUSY_SECONDS of a shot to make it a fight.
const BUSY = 4;
const BUSY_SECONDS = 30;

const PLAY = ['kills', 'shots', 'anims', 'sounds', 'rounds', 'bombs'];
const NOT_TIMED = new Set(['players', 'soundNames']);
const tOf = (row) => (Array.isArray(row) ? row[0] : row.t ?? row.t0);
const round2 = (n) => Math.round(n * 100) / 100;

/** The times of play: an event of PLAY, or a sample where a player moved, turned, ducked or died. */
function playTimes(tl) {
  // The legs of an estimated way (the fill's rows of `anims`) are no play either.
  const spans = new Map();
  for (const e of tl.estimates ?? []) {
    if (!spans.has(e.entity)) spans.set(e.entity, []);
    spans.get(e.entity).push(e);
  }
  const estimated = (key, row) => key === 'anims' && (spans.get(row[1]) ?? []).some((e) => row[0] >= e.t0 && row[0] <= e.t1);
  const times = PLAY.flatMap((key) => (tl[key] ?? []).filter((row) => !estimated(key, row)).map(tOf));
  const last = new Map();
  for (const row of tl.samples ?? []) {
    for (let i = 1; i + 5 < row.length; i += 6) {
      // An estimate of the fill (shared/estimates.js) is no play: the demo does not hold it.
      if (row[i + 5] & ESTIMATE) continue;
      const state = row.slice(i + 1, i + 6).join();
      if (last.has(row[i]) && last.get(row[i]) !== state) times.push(row[0]);
      last.set(row[i], state);
    }
  }
  return times.sort((a, b) => a - b);
}

/**
 * The stretches of dead air of a timeline, [from, to] on its clock: more than QUIET seconds between two times of
 * play, from the first kill or round to the last round. The idle server before and after the match stays.
 */
export function deadAir(tl) {
  const rounds = (tl.rounds ?? []).map(tOf);
  if (!rounds.length) return [];
  const from = Math.min(rounds[0], ...(tl.kills ?? []).map(tOf));
  const to = Math.max(...rounds);
  const times = playTimes(tl);
  const out = [];
  for (let i = 1; i < times.length; i++) {
    if (times[i - 1] >= from && times[i] <= to && times[i] - times[i - 1] > QUIET) out.push([times[i - 1], times[i]]);
  }
  return out;
}

/**
 * The shots fired while at least BUSY players fired within BUSY_SECONDS: a fight, not one idle player who shoots
 * at a wall after the match.
 */
function busyShots(shots) {
  const out = [];
  let from = 0;
  let to = 0;
  const count = new Map();
  for (const [t] of shots) {
    while (to < shots.length && shots[to][0] <= t + BUSY_SECONDS) count.set(shots[to][1], (count.get(shots[to][1]) ?? 0) + 1), to++;
    while (shots[from][0] < t - BUSY_SECONDS) {
      const e = shots[from++][1];
      if (count.get(e) === 1) count.delete(e);
      else count.set(e, count.get(e) - 1);
    }
    if (count.size >= BUSY) out.push(t);
  }
  return out;
}

/**
 * The end of the play: the end of the round of the last kill, bomb or busy shot (`busyShots()`), or that time
 * itself when it came in the POST_ROUND seconds after the round's end. Null without a kill, or when that round has
 * no end (the demo stops inside it). An idle round has a winner too (Target_Saved), so a won round alone is no play.
 */
export function playEnd(tl) {
  if (!(tl.kills ?? []).length) return null;
  const busy = busyShots(tl.shots ?? []);
  const last = Math.max(...[...tl.kills, ...(tl.bombs ?? [])].map(tOf), busy.at(-1) ?? 0);
  const rounds = tl.rounds ?? [];
  const start = Math.max(last - POST_ROUND, ...rounds.filter((r) => r.kind === 'start' && r.t <= last).map(tOf));
  const end = rounds.find((r) => r.kind === 'end' && r.t >= start);
  return end ? Math.max(end.t, last) : null;
}

/** The time of the last row of a timeline, records by their start. */
export function lastRow(tl) {
  let last = 0;
  for (const [key, value] of Object.entries(tl)) {
    if (!Array.isArray(value) || NOT_TIMED.has(key) || key === 'cuts') continue;
    for (const row of value) {
      const t = tOf(row);
      if (typeof t === 'number' && t > last) last = t;
    }
  }
  return last;
}

/**
 * The timeline without its tail: at most TAIL seconds after the end of the play (an idle server can run hundreds
 * of empty rounds after a match), and at most MARGIN seconds after its last row (frames with no data). A record
 * that runs past the new end ends there. The cut goes into `cuts` as [new end, seconds removed], with the seconds
 * of each earlier cut inside the tail.
 */
export function cutTail(tl) {
  const play = playEnd(tl);
  const end = round2(Math.min(tl.duration, lastRow(tl) + MARGIN, play === null ? Infinity : play + TAIL));
  if (end >= tl.duration) return tl;
  const out = { ...tl, duration: end };
  for (const [key, value] of Object.entries(tl)) {
    if (!Array.isArray(value) || NOT_TIMED.has(key) || key === 'cuts') continue;
    out[key] = value.filter((row) => !(tOf(row) > end)).map((row) => retimed(row, (t) => Math.min(t, end)));
  }
  // An earlier cut inside the tail goes into the tail's own: its seconds were removed before this clock.
  const earlier = tl.cuts ?? [];
  const folded = earlier.filter(([t]) => t >= end).reduce((sum, [, seconds]) => sum + seconds, 0);
  out.cuts = [...earlier.filter(([t]) => t < end), [end, round2(tl.duration - end + folded)]].sort((a, b) => a[0] - b[0]);
  return out;
}

/**
 * The timeline with each stretch of dead air squeezed to KEPT seconds. `cuts` holds [t, seconds removed] for each
 * stretch on the new clock, so a time saved against the old clock can be moved (see `movedTime`).
 */
export function cutDeadAir(tl) {
  return withoutRepeats(squeezed(tl));
}

/**
 * The rows of `samples` and `views` (one per frame) without a row at the time of the row before: the squeeze of
 * the dead air puts many frames on one hundredth of a second.
 */
export function withoutRepeats(tl) {
  const out = { ...tl };
  let dropped = 0;
  for (const key of ['samples', 'views']) {
    const rows = tl[key];
    if (!Array.isArray(rows)) continue;
    const kept = rows.filter((row, i) => i === 0 || row[0] !== rows[i - 1][0]);
    dropped += rows.length - kept.length;
    out[key] = kept;
  }
  return dropped ? out : tl;
}

function squeezed(tl) {
  const stretches = deadAir(tl);
  if (!stretches.length) return tl;
  const at = (t) => {
    let removed = 0;
    for (const [from, to] of stretches) {
      if (t >= to) {
        removed += to - from - KEPT;
        continue;
      }
      if (t > from) return from - removed + (KEPT * (t - from)) / (to - from);
      break;
    }
    return t - removed;
  };
  const out = { ...tl, duration: round2(at(tl.duration)) };
  for (const [key, value] of Object.entries(tl)) {
    if (Array.isArray(value) && !NOT_TIMED.has(key)) out[key] = value.map((item) => retimed(item, at));
  }
  out.cuts = [...(out.cuts ?? []), ...stretches.map(([from, to]) => [round2(at(from)), round2(to - from - KEPT)])]
    .sort((a, b) => a[0] - b[0]);
  return out;
}

/** A time of the clock before the cuts on the clock after them; a time inside a cut lands at its start. */
export function movedTime(cuts, t) {
  let removed = 0;
  for (const [cut, seconds] of cuts) {
    const before = cut + removed;
    if (t <= before) break;
    if (t < before + seconds + KEPT) return cut;
    removed += seconds;
  }
  return round2(t - removed);
}
