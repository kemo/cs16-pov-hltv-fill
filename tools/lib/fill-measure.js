// The measure of the fill on an HLTV timeline (tools/measure-fill.js, tools/cs16-pov-hltv-fill.js): one player's POV
// is made from the timeline (src/fill/mask.js), the fill estimates the players that this POV hides, and the HLTV
// timeline has their true places. Two kinds of numbers: the error of the estimate, and the faults that need no
// truth, counted on the estimates and on the real samples.

import { HULL_STAND, fits } from '../../src/shared/game/hull.js';
import { ESTIMATE, fillTimeline } from '../../src/fill/fill.js';
import { maskAsPov } from '../../src/fill/mask.js';
import { windowsOf } from '../../src/fill/rounds.js';
import { fatPvs, leafAt, playerSeen } from '../../src/fill/vis.js';

// Units a second. The fastest run is 250; a fall or a jump down is faster for a moment.
const TOO_FAST = 320;
// Units. A larger step between an estimate and a real sample 0.3 s apart at most is a leap.
const LEAP = 100;
// Units a second. Faster than any fall: a player that goes from one place to another in no time.
const JUMP = 700;
const SAMPLE = 0.25;
const GRACE = 0.5;

/** The counts of one run: the POV of `recorder` made from `truth`, filled on `level`, against `truth`. */
export function measureRun(truth, recorder, level) {
  const started = Date.now();
  const masked = maskAsPov(truth, recorder, level.vis);
  const filled = fillTimeline(masked, level);
  const stats = compare(truth, masked, filled, recorder, level);
  stats.ms = Date.now() - started;
  return stats;
}

/** The players with the most rows, one of each side first. */
export function recordersOf(tl, n) {
  const count = new Map();
  for (const row of tl.samples) for (let i = 1; i < row.length; i += 6) count.set(row[i], (count.get(row[i]) ?? 0) + 1);
  const sideOf = (e) => tl.sides.findLast((s) => s[1] === e)?.[2];
  const order = [...count.keys()].sort((a, b) => count.get(b) - count.get(a));
  const out = [];
  for (const side of ['CT', 'T']) {
    const e = order.find((x) => sideOf(x) === side);
    if (e !== undefined) out.push(e);
  }
  for (const e of order) if (!out.includes(e)) out.push(e);
  return out.slice(0, n);
}

export function newStats() {
  const who = () => ({ hidden: 0, filled: 0, err: [], hold: [], yaw: [] });
  return { kinds: {}, mate: who(), enemy: who(), steps: 0, fast: 0, jumps: 0, wall: 0, inSet: 0, checked: 0, seams: 0, leaps: 0, ms: 0, ways: 0, relaxed: 0, straight: 0, realSteps: 0, realFast: 0, realJumps: 0, realPlaces: 0, realWall: 0, places: 0 };
}

export function add(sum, s) {
  for (const who of ['mate', 'enemy']) {
    sum[who].hidden += s[who].hidden;
    sum[who].filled += s[who].filled;
    sum[who].err.push(...s[who].err);
    sum[who].hold.push(...s[who].hold);
    sum[who].yaw.push(...s[who].yaw);
  }
  for (const [kind, list] of Object.entries(s.kinds)) (sum.kinds[kind] ??= []).push(...list);
  for (const key of ['steps', 'fast', 'jumps', 'wall', 'inSet', 'checked', 'seams', 'leaps', 'ms', 'ways', 'relaxed', 'straight', 'realSteps', 'realFast', 'realJumps', 'realPlaces', 'realWall', 'places']) sum[key] += s[key];
}

function compare(truth, masked, filled, recorder, level) {
  const s = newStats();
  Object.assign(s, { ways: filled.fill?.ways ?? 0, relaxed: filled.fill?.relaxed ?? 0, straight: filled.fill?.straight ?? 0 });
  const set = new Uint8Array(level.vis.rowBytes);
  let eyeAt = -1;
  let setOk = false;
  const eyes = masked.eyes;
  const lastSeen = new Map();
  // The spans of each player, to name the kind of an error: enemies only.
  const spans = new Map();
  for (const { entity: e, t0, t1, kind } of filled.estimates ?? []) {
    if (!spans.has(e)) spans.set(e, []);
    spans.get(e).push([t0, t1, kind]);
  }
  const kindAt = (e, t) => {
    const hit = (spans.get(e) ?? []).find(([t0, t1]) => t >= t0 - 0.01 && t <= t1 + 0.01);
    if (!hit) return 'none';
    const length = hit[1] - hit[0];
    return `${hit[2]} ${length < 2 ? '<2s' : length < 6 ? '2-6s' : length < 15 ? '6-15s' : '15s+'}`;
  };
  const last = new Map();
  const estSince = new Map();
  let nextSample = 0;
  // A leap at a restart is the game's own: every player goes to a spawn.
  const restarts = windowsOf(truth).map((w) => w.t0);
  const atRestart = (t) => restarts.some((r) => Math.abs(t - r) < 0.6);
  const recSide = (t) => truth.sides.findLast((x) => x[1] === recorder && x[0] <= t)?.[2];
  for (let r = 0; r < truth.samples.length; r++) {
    const row = truth.samples[r];
    const got = filled.samples[r];
    const t = row[0];
    const at = new Map();
    for (let i = 1; i < got.length; i += 6) at.set(got[i], i);
    // The faults that need no truth, at every row.
    for (const [e, i] of at) {
      const est = (got[i + 5] & ESTIMATE) !== 0;
      const p = last.get(e);
      // A step from a dead sample is a respawn, the game's own leap.
      if (p && t - p.t < 0.5 && !atRestart(t) && !(got[i + 5] & 1) && !p.dead) {
        const d = Math.hypot(got[i + 1] - p.x, got[i + 2] - p.y);
        const speed = d / Math.max(0.01, t - p.t);
        if (est || p.est) {
          s.steps++;
          if (speed > TOO_FAST && d > 24) s.fast++;
          if (speed > JUMP && d > 60) s.jumps++;
          if (est !== p.est && t - p.t <= 0.3) {
            s.seams++;
            if (d > LEAP) s.leaps++;
          }
        } else {
          // The same counts on the real samples: the game itself has falls, and a demo has lag.
          s.realSteps++;
          if (speed > TOO_FAST && d > 24) s.realFast++;
          if (speed > JUMP && d > 60) s.realJumps++;
        }
      }
      if (est && !p?.est) estSince.set(e, t);
      last.set(e, { t, x: got[i + 1], y: got[i + 2], est, dead: (got[i + 5] & 1) !== 0 });
    }
    if (t < nextSample) continue;
    nextSample = t + SAMPLE;
    while (eyeAt + 1 < eyes.length && eyes[eyeAt + 1][0] <= t) {
      eyeAt++;
      setOk = false;
    }
    const mine = recSide(t);
    for (let i = 1; i < row.length; i += 6) {
      const e = row[i];
      if (e === recorder || (row[i + 5] & 1)) continue;
      const shown = masked.samples[r].includes(e) && holds(masked.samples[r], e);
      if (shown) {
        lastSeen.set(e, [row[i + 1], row[i + 2], row[i + 3]]);
        s.realPlaces++;
        if (inWall(level, [row[i + 1], row[i + 2], row[i + 3]])) s.realWall++;
        continue;
      }
      const who = s[(row[i + 5] & 4 ? 'CT' : 'T') === mine ? 'mate' : 'enemy'];
      who.hidden++;
      const g = at.get(e);
      if (g === undefined) continue;
      who.filled++;
      const error = Math.round(Math.hypot(got[g + 1] - row[i + 1], got[g + 2] - row[i + 2], got[g + 3] - row[i + 3]));
      who.err.push(error);
      // Degrees between where the estimate looks and where the player looks.
      const turn = Math.abs(got[g + 4] - row[i + 4]) % 3600;
      who.yaw.push(Math.round((turn > 1800 ? 3600 - turn : turn) / 10));
      if (who === s.enemy) (s.kinds[kindAt(e, t)] ??= []).push(error);
      const held = lastSeen.get(e);
      if (held) who.hold.push(Math.round(Math.hypot(held[0] - row[i + 1], held[1] - row[i + 2], held[2] - row[i + 3])));
      const place = [got[g + 1], got[g + 2], got[g + 3]];
      s.places++;
      if (inWall(level, place)) s.wall++;
      // In the recorder's set: the server would have sent this player. The ends of a span lie on the edge of the set.
      if (eyeAt >= 0 && t - (estSince.get(e) ?? t) > GRACE && stillEstimated(filled, r, e, GRACE)) {
        if (!setOk) {
          const eye = [eyes[eyeAt][1], eyes[eyeAt][2], eyes[eyeAt][3]];
          setOk = leafAt(level.vis, eye) !== 0;
          if (setOk) fatPvs(level.vis, eye, set);
        }
        if (setOk) {
          s.checked++;
          if (playerSeen(level.vis, set, place)) s.inSet++;
        }
      }
    }
  }
  return s;
}

/** A place where a standing player does not fit, even a step higher: on stairs an estimate lies between two floors. */
function inWall(level, place) {
  return ![0, 1, 4, 18].some((up) => fits(level.hull, HULL_STAND, [place[0], place[1], place[2] + up]));
}

function holds(row, entity) {
  for (let i = 1; i < row.length; i += 6) if (row[i] === entity) return true;
  return false;
}

/** Whether a player is still an estimate `seconds` after row r. */
function stillEstimated(filled, r, entity, seconds) {
  const rows = filled.samples;
  const until = rows[r][0] + seconds;
  for (let k = r + 1; k < rows.length; k++) {
    const row = rows[k];
    if (row[0] < until) continue;
    for (let i = 1; i < row.length; i += 6) if (row[i] === entity) return (row[i + 5] & ESTIMATE) !== 0;
    return true;
  }
  return true;
}

function quantile(sorted, q) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null;
}

export function report(s) {
  const out = {};
  for (const who of ['mate', 'enemy']) {
    const err = s[who].err.slice().sort((a, b) => a - b);
    const hold = s[who].hold.slice().sort((a, b) => a - b);
    const yaw = (s[who].yaw ?? []).slice().sort((a, b) => a - b);
    out[who] = {
      hiddenSeconds: Math.round(s[who].hidden * SAMPLE), filledShare: share(s[who].filled, s[who].hidden),
      median: quantile(err, 0.5), p75: quantile(err, 0.75), p90: quantile(err, 0.9),
      within150: share(err.filter((v) => v <= 150).length, err.length), within400: share(err.filter((v) => v <= 400).length, err.length),
      holdMedian: quantile(hold, 0.5), holdP90: quantile(hold, 0.9),
      yawMedian: quantile(yaw, 0.5), yawP90: quantile(yaw, 0.9), yawWithin30: share(yaw.filter((v) => v <= 30).length, yaw.length),
    };
  }
  out.kinds = Object.fromEntries(Object.entries(s.kinds).sort().map(([kind, list]) => {
    const sorted = list.slice().sort((a, b) => a - b);
    return [kind, `${Math.round(list.length * SAMPLE)} s, median ${quantile(sorted, 0.5)}, p90 ${quantile(sorted, 0.9)}`];
  }));
  out.faults = {
    fast: s.fast, fastShare: share(s.fast, s.steps, 5), realFastShare: share(s.realFast, s.realSteps, 5),
    jumps: s.jumps, jumpShare: share(s.jumps, s.steps, 5), realJumpShare: share(s.realJumps, s.realSteps, 5),
    wall: s.wall, wallShare: share(s.wall, s.places), realWallShare: share(s.realWall, s.realPlaces),
    inSet: s.inSet, inSetShare: share(s.inSet, s.checked), leaps: s.leaps, seams: s.seams,
    ways: s.ways, relaxed: s.relaxed, straight: s.straight,
  };
  return out;
}

function share(a, b, digits = 3) {
  return b ? Math.round((a / b) * 10 ** digits) / 10 ** digits : null;
}

export function line(s) {
  const r = report(s);
  const who = (w) => `${w} ${r[w].hiddenSeconds} s hidden, median ${r[w].median} p90 ${r[w].p90} (hold ${r[w].holdMedian}/${r[w].holdP90}), in 150: ${r[w].within150}, yaw ${r[w].yawMedian}/${r[w].yawP90} deg`;
  return `${who('mate')}; ${who('enemy')}; faults: fast ${r.faults.fastShare} (real ${r.faults.realFastShare}), jumps ${r.faults.jumps} (${r.faults.jumpShare}, real ${r.faults.realJumpShare}), wall ${r.faults.wallShare} (real ${r.faults.realWallShare}), in set ${r.faults.inSet} (${r.faults.inSetShare}), leaps ${r.faults.leaps}/${r.faults.seams}, relaxed ${r.faults.relaxed}/${r.faults.ways}, straight ${r.faults.straight}`;
}
