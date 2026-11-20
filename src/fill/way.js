// The way of a hidden player between two known places: the cheapest walk on the graph that fits the time. A step
// of the walk is STEP seconds; at each step the player stays or goes to a floor that a run reaches in that time.

import { chainOf, nearOf, secondsFrom } from './graph.js';

/** Seconds of one step of the walk. */
export const STEP = 0.4;
// The time of a step may pass the run on the graph by this: the graph's ways are longer than the straight line.
const SLACK = 1.1;
// The cost of a step in a place that the recorder would have got from the server.
const SEEN_COST = 500;
// The cost of a second of travel: among ways of the same other cost, the shortest.
const MOVE_COST = 1;
// The cost of a step that runs where the recorder would have heard it, and the seconds of way in one step up to
// which a player walks (one cell: without a sound).
const HEARD_COST = 6;
const QUIET = 0.19;
// Steps times nodes above which the steps get longer.
const MAX_CELLS = 24e6;

/**
 * The walk from `starts` ([{node, cost}]) at t0 to `end` (a node, or -1 for any) at t1.
 * `costOf(node, t)` is the cost of a second at a floor (the prior), `seenAt(node, t)` whether the recorder would
 * have got a player there, `speed` how much faster than a run the player may go (1 is the game's limit), `goAt`
 * the time before which nobody moves (the freeze of a round), `cap` the cost of a second from which a floor is
 * off the way (too far from the guide), `heardAt(node, t)` whether the recorder would have heard a run there: the
 * demo holds no step of this span, so a run in such a place costs. `still`: the stretches ([from, to]) in which
 * nobody moves (the demo holds no play there).
 * Returns {steps: [{t, node}], cost, seen: floors of the way in a seen place} or null when the time is too short for any way.
 */
export function findWay(nav, { starts, end = -1, t0, t1, costOf = null, seenAt = null, speed = 1, goAt = -Infinity, cap = Infinity, heardAt = null, still = null }) {
  const n = nav.count;
  let count = Math.max(1, Math.ceil((t1 - t0) / STEP));
  while ((count + 1) * n > MAX_CELLS && count > 8) count = Math.ceil(count / 2);
  const dt = (t1 - t0) / count;
  const reach = dt * speed * SLACK;
  const total = (t1 - t0) * speed * SLACK + 0.05;
  const fromStart = secondsFrom(nav, starts.map((s) => s.node), { limit: total });
  const toEnd = end < 0 ? null : secondsFrom(nav, end, { back: true, limit: total });
  if (end >= 0 && fromStart[end] > total) return null;

  let now = new Float64Array(n).fill(Infinity);
  let next = new Float64Array(n).fill(Infinity);
  const back = new Int32Array((count + 1) * n).fill(-1);
  // The floors that hold a cost at this step and at the next one.
  let live = [];
  let born = [];
  for (const s of starts) {
    if (now[s.node] === Infinity) live.push(s.node);
    if (s.cost < now[s.node]) now[s.node] = s.cost;
  }
  const stamp = new Int32Array(n).fill(-1);
  const placeCost = new Float64Array(n);
  const inSight = new Uint8Array(n);
  const loud = new Uint8Array(n);
  const price = (v, k, t) => {
    stamp[v] = k;
    inSight[v] = seenAt && seenAt(v, t) ? 1 : 0;
    loud[v] = heardAt && heardAt(v, t) ? 1 : 0;
    const own = costOf ? costOf(v, t) : 0;
    // A floor too far from the guide is off the way.
    placeCost[v] = own >= cap ? Infinity : own * dt + (inSight[v] ? SEEN_COST : 0);
  };
  const budget = Math.ceil(reach * 20) / 20;

  for (let k = 1; k <= count; k++) {
    const t = t0 + k * dt;
    const left = (count - k) * reach + 0.05;
    const frozen = t - dt < goAt || Boolean(still?.some(([from, to]) => t > from && t - dt < to));
    for (let a = 0; a < live.length; a++) {
      const u = live[a];
      const base = now[u];
      const near = frozen ? null : nearOf(nav, u, budget);
      const size = near ? near.nodes.length : 1;
      for (let i = 0; i < size; i++) {
        const v = near ? near.nodes[i] : u;
        const seconds = near ? near.seconds[i] : 0;
        if (seconds > reach) continue;
        if (toEnd && toEnd[v] > left) continue;
        if (stamp[v] !== k) price(v, k, t);
        let cost = base + seconds * MOVE_COST + placeCost[v];
        if (loud[v] && seconds > QUIET) cost += HEARD_COST;
        if (cost >= next[v]) continue;
        // The floors between two steps count too: a way through a seen place is seen.
        if (seenAt && near) {
          const m1 = near.mid1[i];
          if (m1 >= 0) {
            if (stamp[m1] !== k) price(m1, k, t);
            if (inSight[m1]) cost += SEEN_COST;
            const m2 = near.mid2[i];
            if (m2 >= 0) {
              if (stamp[m2] !== k) price(m2, k, t);
              if (inSight[m2]) cost += SEEN_COST;
            }
          }
          if (cost >= next[v]) continue;
        }
        if (next[v] === Infinity) born.push(v);
        next[v] = cost;
        back[k * n + v] = u;
      }
    }
    for (let a = 0; a < live.length; a++) now[live[a]] = Infinity;
    [now, next] = [next, now];
    [live, born] = [born, live];
    born.length = 0;
  }

  let last = end;
  if (last < 0) {
    let best = Infinity;
    for (const v of live) {
      if (now[v] < best) {
        best = now[v];
        last = v;
      }
    }
  }
  if (last < 0 || now[last] === Infinity) return null;
  const nodes = new Array(count + 1);
  for (let k = count, v = last; k >= 0; k--) {
    nodes[k] = v;
    if (k > 0) v = back[k * n + v];
  }
  // Every floor of the way, not only the one at each step: a line between two steps can cut a corner.
  const steps = [{ t: t0, node: nodes[0] }];
  for (let k = 1; k <= count; k++) {
    const from = t0 + (k - 1) * dt;
    if (nodes[k] === nodes[k - 1]) {
      steps.push({ t: from + dt, node: nodes[k] });
      continue;
    }
    const chain = chainOf(nearOf(nav, nodes[k - 1], budget), nodes[k]);
    const whole = chain.at(-1)?.seconds || 1;
    for (let i = 1; i < chain.length; i++) steps.push({ t: from + (dt * chain[i].seconds) / whole, node: chain[i].node });
    if (!chain.length) steps.push({ t: from + dt, node: nodes[k] });
  }
  let seen = 0;
  if (seenAt) for (const s of steps.slice(1, -1)) if (seenAt(s.node, s.t)) seen++;
  return { steps, cost: now[last], seen };
}
