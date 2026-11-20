// The spawn point of each player at each restart. The game gives the points of a side out in turn
// (EntSelectSpawnPoint: the next free point after the one it gave last, the players in the order of their
// entities). The point of the first player of a side at a restart is the state of a chain over the restarts; what
// the demo shows of each player (on its point, or its first known place and the time of it) says how likely each
// state is.

import { TICK, placeOf, pointsNear } from './routes.js';

// Units from a spawn point within which a player stands on it.
const ON_SPOT = 24;
// How sure a player that stands on a point is of that point.
const SEEN = 0.98;
// The chance that the game leaves one point out at a restart (a player stands on it), or two.
const SKIP = [0.9, 0.07, 0.02];
// Seconds of a round after which a first known place says nothing of the spawn point.
const EARLY = 30;
// Units and seconds within which a real player from a point passes the first known place of the hidden one.
const PASS = 120;
const PASS_SECONDS = 0.5;
// What a point with no such real player still counts: the routes do not hold every way.
const ALPHA = 0.3;
// Units from a spawn point within which its player can spray (the game reaches 128 from the eye), and how
// likely a spray is from another point (a player that the freeze does not hold, a wrong clock).
const SPRAY_REACH = 150;
const SPRAY_MISS = 0.03;
// Seconds between two round windows under which they can be one restart.
const TWICE = 4;
// The most restarts that the gap between two parts of a match can hold.
const GAP = 8;

/** The index of the spawn point of `side` that a place lies on, or -1. */
function spotAt(spots, x, y) {
  let best = -1;
  let near = ON_SPOT;
  spots.forEach((s, k) => {
    const d = Math.hypot(s.origin[0] - x, s.origin[1] - y);
    if (d < near) [near, best] = [d, k];
  });
  return best;
}

/** The spawn point of each route that starts with its round: Int16Array(route -> index of its side's points, or -1). */
function routeSpots(routes, spots) {
  if (routes.spots) return routes.spots;
  const out = new Int16Array(routes.n).fill(-1);
  const at = [0, 0, 0];
  const total = [new Float64Array(spots[0].length), new Float64Array(spots[1].length)];
  for (let r = 0; r < routes.n; r++) {
    if (routes.out?.[r] || routes.k0[r] > 2) continue;
    placeOf(routes, r, 0, at);
    out[r] = spotAt(spots[routes.side[r]], at[0], at[1]);
    if (out[r] >= 0) total[routes.side[r]][out[r]]++;
  }
  routes.spots = out;
  routes.spotTotals = total;
  return out;
}

/**
 * The spawn points of the players: Map(window -> Map(entity -> {x, y, z, yaw, sure, shown})). `sure` is the
 * chance of the chosen state of that restart, `shown` whether the demo shows that state itself.
 * `rounds`: [{win, players}], the players of both sides that take a point at each restart, in the order of their
 * entities: {entity, side, own, seen, first, spray}. `seen`: [x, y] of one that the demo shows at the restart;
 * `own`: the recorder; `first`: {x, y, z, at} of the first known place of a hidden one (`at`: seconds of the
 * round); `spray`: [x, y, z] of a logo that it sprayed in the freeze.
 * `breaks`: the indexes of `rounds` before which nobody knows the count of restarts (a new part of a joined match).
 */
export function spawnPlan(level, rounds, breaks = new Set()) {
  const out = new Map();
  if (!level.spawns?.length || !rounds.length) return out;
  const spots = [level.spawns.filter((s) => s.side === 'T'), level.spawns.filter((s) => s.side === 'CT')];
  const routes = level.routes ?? null;
  const ofRoute = routes ? routeSpots(routes, spots) : null;
  const sides = ['T', 'CT'];
  // How likely each point of a side is for a player with a first known place: the share of the real players from
  // that point that pass the place at that time.
  const clue = (s, first) => {
    const n = spots[s].length;
    const like = new Float64Array(n).fill(1);
    if (!routes || !first || first.at > EARLY || first.at < 0.5) return like;
    const hits = new Float64Array(n);
    const done = new Set();
    pointsNear(routes, s, [first.x, first.y, first.z], PASS, (r, i) => {
      if (ofRoute[r] < 0 || done.has(r) || Math.abs((routes.k0[r] + i) * TICK - first.at) > PASS_SECONDS) return;
      done.add(r);
      hits[ofRoute[r]]++;
    });
    let any = 0;
    for (let k = 0; k < n; k++) any += hits[k];
    if (any < 3) return like;
    for (let k = 0; k < n; k++) like[k] = (hits[k] + ALPHA) / (routes.spotTotals[s][k] + 10 * ALPHA);
    return like;
  };
  const plan = [null, null];
  for (const s of [0, 1]) {
    const n = spots[s].length;
    if (!n) continue;
    // The players of the side at each restart, and how likely each state is by what the demo shows of them.
    const rows = rounds.map(({ players }) => {
      const mine = players.filter((p) => p.side === sides[s]);
      const emit = new Float64Array(n).fill(1);
      let known = null;
      const votes = new Map();
      mine.forEach((p, rank) => {
        if (p.seen) {
          const at = spotAt(spots[s], p.seen[0], p.seen[1]);
          if (at < 0) return;
          const start = (((at - rank) % n) + n) % n;
          votes.set(start, (votes.get(start) ?? 0) + 1);
          for (let state = 0; state < n; state++) emit[state] *= state === start ? SEEN : (1 - SEEN) / Math.max(1, n - 1);
          return;
        }
        const like = clue(s, p.first);
        for (let state = 0; state < n; state++) emit[state] *= like[(state + rank) % n];
        // A spray in the freeze: the player is on its point, within reach of the logo.
        if (p.spray) {
          for (let state = 0; state < n; state++) {
            const spot = spots[s][(state + rank) % n];
            emit[state] *= Math.hypot(spot.origin[0] - p.spray[0], spot.origin[1] - p.spray[1]) <= SPRAY_REACH ? 1 : SPRAY_MISS;
          }
        }
      });
      // Two players on their points agree on the state, or the recorder itself stands on its point: the demo shows it.
      const top = [...votes].sort((a, b) => b[1] - a[1])[0];
      const own = mine.findIndex((p) => p.own && p.seen);
      const ownAt = own >= 0 ? spotAt(spots[s], mine[own].seen[0], mine[own].seen[1]) : -1;
      if (ownAt >= 0) known = (((ownAt - own) % n) + n) % n;
      else if (top && top[1] >= 2) known = top[0];
      const sum = emit.reduce((a, b) => a + b, 0) || 1;
      for (let state = 0; state < n; state++) emit[state] /= sum;
      return { count: mine.length, emit, known, mine };
    });
    plan[s] = rows;
  }
  // The restarts between two round windows, counted on a side whose state the demo shows at both: 0 when the
  // demo holds one restart as two windows (the clock of a round can come twice), 1 for the next round, more
  // when the demo shows no window for a restart (three restarts in a row before a match). Each restart gives
  // every player a new point, so the count holds for the other side too. Null where no side shows it.
  const turns = rounds.map((_, i) => {
    if (i === 0 || breaks.has(i)) return null;
    for (const s of [0, 1]) {
      if (!plan[s]) continue;
      const [a, b] = [plan[s][i - 1], plan[s][i]];
      const n = spots[s].length;
      if (a.known === null || b.known === null || !a.count || !b.count) continue;
      const step = (((b.known - a.known) % n) + n) % n;
      // The same state a moment later is the same restart; later, the restarts between went once round the list.
      if (step === 0 && rounds[i].win.t0 - rounds[i - 1].win.t0 < TWICE) return 0;
      for (let turn = 1; turn <= 4; turn++) {
        for (const skip of [0, 1]) if ((a.count + (turn - 1) * b.count + skip) % n === step) return turn;
      }
      if (step === 0) return 0;
    }
    return null;
  });
  for (const s of [0, 1]) {
    const rows = plan[s];
    const n = spots[s]?.length;
    if (!rows || !n) continue;
    // The chance to go from a state to the next one: the players of the round before take their points, then
    // every hidden restart gives the players of this round new ones, and a point or two can be left out.
    const move = (i) => {
      const m = new Float64Array(n * n);
      const base = rows[i - 1].count;
      // The restarts before this window, each with its chance. Between two parts of a match nobody knows the
      // count, but each restart gave every player of the side a new point: on a level with 20 points and 5
      // players only 4 states are left. With no shown side, two windows within a few seconds are more likely
      // one restart seen twice than two.
      const twice = rounds[i].win.t0 - rounds[i - 1].win.t0 < TWICE ? 0.6 : 0.05;
      const extras = breaks.has(i) ? Array.from({ length: GAP }, (_, k) => [k + 1, 1 / GAP])
        : turns[i] === null ? [[0, twice], [1, (1 - twice) * 0.7], [2, (1 - twice) * 0.1], [3, (1 - twice) * 0.1], [4, (1 - twice) * 0.1]] : [[turns[i], 1]];
      const noise = breaks.has(i) ? 0.2 : 0.01;
      for (let from = 0; from < n; from++) {
        for (const [turn, weight] of extras) {
          // No restart between the two windows: the state stays.
          if (turn === 0) m[from * n + from] += weight * (1 - noise);
          else SKIP.forEach((p, skip) => { m[from * n + ((from + base + (turn - 1) * rows[i].count + skip) % n)] += weight * p * (1 - noise); });
        }
        for (let to = 0; to < n; to++) m[from * n + to] += noise / n;
      }
      return m;
    };
    const moves = rows.map((_, i) => (i === 0 ? null : move(i)));
    const norm = (v) => {
      const sum = v.reduce((a, b) => a + b, 0) || 1;
      for (let k = 0; k < n; k++) v[k] /= sum;
      return v;
    };
    const fwd = rows.map(() => new Float64Array(n));
    const bwd = rows.map(() => new Float64Array(n));
    for (let k = 0; k < n; k++) fwd[0][k] = rows[0].emit[k] / n;
    norm(fwd[0]);
    for (let i = 1; i < rows.length; i++) {
      for (let to = 0; to < n; to++) {
        let sum = 0;
        for (let from = 0; from < n; from++) sum += fwd[i - 1][from] * moves[i][from * n + to];
        fwd[i][to] = sum * rows[i].emit[to];
      }
      norm(fwd[i]);
    }
    bwd[rows.length - 1].fill(1 / n);
    for (let i = rows.length - 2; i >= 0; i--) {
      for (let from = 0; from < n; from++) {
        let sum = 0;
        for (let to = 0; to < n; to++) sum += moves[i + 1][from * n + to] * rows[i + 1].emit[to] * bwd[i + 1][to];
        bwd[i][from] = sum;
      }
      norm(bwd[i]);
    }
    rows.forEach((row, i) => {
      const post = norm(Float64Array.from(fwd[i], (v, k) => v * bwd[i][k]));
      let best = 0;
      for (let k = 1; k < n; k++) if (post[k] > post[best]) best = k;
      const win = rounds[i].win;
      if (!out.has(win)) out.set(win, new Map());
      row.mine.forEach((p, rank) => {
        const spot = spots[s][(best + rank) % n];
        out.get(win).set(p.entity, { x: spot.origin[0], y: spot.origin[1], z: spot.origin[2], yaw: spot.yaw ?? null, sure: post[best], shown: row.known !== null });
      });
    });
  }
  return out;
}
