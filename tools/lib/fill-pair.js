// The check of the fill on a match that exists twice: as the POV demo of one player and as an HLTV demo, which has
// the true place of every player that the POV demo hides (tools/check-fill-pair.js, tools/cs16-pov-hltv-fill.js).

import { ESTIMATE, fillTimeline } from '../../src/fill/fill.js';
import { maskAsPov } from '../../src/fill/mask.js';

/**
 * Prints (through `log`) how well the mask of the measure agrees with the real POV timeline, and the error of the
 * fill of the real POV timeline against the HLTV timeline. `level` as fillTimeline() takes it. Returns the raw
 * errors (units, one each 0.25 s) so that a caller can join many pairs.
 */
export function checkPair(pov, hltv, level, log = console.log) {
  if (pov.source.kind !== 'pov' || hltv.source.kind !== 'hltv') throw new Error('The first demo must be a POV demo and the second an HLTV demo.');

  // The clocks: the same kill is in both demos. A kill that is the only one of its killer, victim and weapon gives
  // the first shift; from it every kill of the POV demo finds its twin, in order. A POV demo can stop and go on
  // (its recorder paused it), so the shift is the one of the nearest kill, not one number.
  const same = (h, k) => h.victim === k.victim && h.killer === k.killer && h.weapon === k.weapon;
  const firsts = [];
  for (const k of pov.kills) {
    const twin = hltv.kills.filter((h) => same(h, k));
    if (twin.length === 1) firsts.push(twin[0].t - k.t);
  }
  firsts.sort((a, b) => a - b);
  if (firsts.length < 3) throw new Error('The two demos share fewer than 3 kills: not the same match.');
  let near = firsts[firsts.length >> 1];
  const pairs = [];
  for (const k of pov.kills) {
    const twin = hltv.kills.filter((h) => same(h, k) && Math.abs(h.t - k.t - near) < 20).sort((x, y) => Math.abs(x.t - k.t - near) - Math.abs(y.t - k.t - near))[0];
    if (!twin) continue;
    near = twin.t - k.t;
    pairs.push([k.t, near]);
  }
  function shiftOf(t) {
    let best = pairs[0];
    for (const p of pairs) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    return best[1];
  }
  const spread = pairs.map((p) => p[1]).sort((a, b) => a - b);
  log(`${pov.map}: ${pov.kills.length} kills in the POV demo, ${pairs.length} of them in the HLTV demo, at ${spread[0].toFixed(2)} to ${spread.at(-1).toFixed(2)} s`);

  const recorder = pov.recorder;
  const sampleOf = (rows, entity, t) => {
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rows[mid][0] <= t) lo = mid; else hi = mid - 1;
    }
    const [a, b] = [rows[lo], rows[Math.min(rows.length - 1, lo + 1)]];
    let i = -1;
    let j = -1;
    for (let k = 1; k < a.length; k += 6) if (a[k] === entity) i = k;
    for (let k = 1; k < b.length; k += 6) if (b[k] === entity) j = k;
    if (i < 0 || j < 0 || Math.abs(a[0] - t) > 0.3 || (a[i + 5] & 1)) return null;
    const f = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
    return [a[i + 1] + (b[j + 1] - a[i + 1]) * f, a[i + 2] + (b[j + 2] - a[i + 2]) * f, a[i + 3] + (b[j + 3] - a[i + 3]) * f];
  };
  // The samples of a demo lie on another clock than its messages. The players that both demos show give the rest of
  // the shift: the one with the smallest middle distance between the two recordings.
  let fine = 0;
  let fineError = Infinity;
  for (let d = -0.6; d <= 0.6001; d += 0.05) {
    const ds = [];
    for (let k = 0; k < pov.samples.length; k += 23) {
      const row = pov.samples[k];
      for (let i = 1; i < row.length; i += 6) {
        if (row[i + 5] & 1) continue;
        const at = sampleOf(hltv.samples, row[i], row[0] + shiftOf(row[0]) + d);
        if (at) ds.push(Math.hypot(at[0] - row[i + 1], at[1] - row[i + 2]));
      }
    }
    ds.sort((x, y) => x - y);
    const mid = ds[ds.length >> 1] ?? Infinity;
    if (mid < fineError) [fine, fineError] = [d, mid];
  }
  log(`the samples of the two demos agree best at ${fine >= 0 ? '+' : ''}${fine.toFixed(2)} s more: seen players then lie ${fineError.toFixed(0)} units apart (middle)`);
  const dtAt = (t) => shiftOf(t) + fine;
  const masked = maskAsPov(hltv, recorder, level.vis);
  const filled = fillTimeline(pov, level);
  // The same fill on the mask: the two errors are near each other when the mask is a fair copy of a real POV demo.
  const filledMask = fillTimeline(masked, level);
  const sideAt = (tl, e, t) => tl.sides.findLast((s) => s[1] === e && s[0] <= t)?.[2];
  const entryOf = (row, entity) => {
    for (let i = 1; i < row.length; i += 6) if (row[i] === entity) return i;
    return -1;
  };
  const rowAt = (rows, t) => {
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rows[mid][0] <= t) lo = mid; else hi = mid - 1;
    }
    return rows[lo];
  };
  const agree = { both: 0, neither: 0, realOnly: 0, maskOnly: 0 };
  const errors = { mate: [], enemy: [] };
  const maskErrors = { mate: [], enemy: [] };
  const detail = {};
  const hidden = { mate: 0, enemy: 0 };
  const [from, to] = [pov.kills[0].t - 20, pov.kills.at(-1).t + 5];
  for (let t = Math.max(0, from); t < Math.min(pov.duration, to); t += 0.25) {
    const real = rowAt(pov.samples, t);
    const est = rowAt(filled.samples, t);
    const dt = dtAt(t);
    const truth = rowAt(hltv.samples, t + dt);
    const synth = rowAt(masked.samples, t + dt);
    if (Math.abs(real[0] - t) > 0.3 || Math.abs(truth[0] - t - dt) > 0.3) continue;
    for (let i = 1; i < truth.length; i += 6) {
      const e = truth[i];
      if (e === recorder || (truth[i + 5] & 1)) continue;
      const shown = entryOf(real, e) >= 0;
      const masks = entryOf(synth, e) >= 0;
      agree[shown ? (masks ? 'both' : 'realOnly') : masks ? 'maskOnly' : 'neither']++;
      const who0 = sideAt(hltv, e, t + dt) === sideAt(hltv, recorder, t + dt) ? 'mate' : 'enemy';
      if (!masks) {
        const m = rowAt(filledMask.samples, t + dt);
        const k = entryOf(m, e);
        if (k >= 0 && (m[k + 5] & ESTIMATE)) maskErrors[who0].push(Math.hypot(m[k + 1] - truth[i + 1], m[k + 2] - truth[i + 2], m[k + 3] - truth[i + 3]));
      }
      if (shown) continue;
      const who = sideAt(hltv, e, t + dt) === sideAt(hltv, recorder, t + dt) ? 'mate' : 'enemy';
      hidden[who]++;
      const at = entryOf(est, e);
      if (at < 0 || !(est[at + 5] & ESTIMATE)) continue;
      const place = sampleOf(hltv.samples, e, est[0] + dt);
      if (!place) continue;
      const error = Math.hypot(est[at + 1] - place[0], est[at + 2] - place[1], est[at + 3] - place[2]);
      errors[who].push(error);
      const span = filled.estimates.find((x) => x.entity === e && est[0] >= x.t0 - 0.01 && est[0] <= x.t1 + 0.01);
      const length = span ? span.t1 - span.t0 : 0;
      const alive = entryOf(real, recorder) >= 0 && !(real[entryOf(real, recorder) + 5] & 1);
      (detail[`${who}, recorder ${alive ? 'alive' : 'dead'}, ${span?.kind ?? 'none'} ${length < 2 ? 'under 2 s' : length < 8 ? '2 to 8 s' : 'over 8 s'}`] ??= []).push(error);
    }
  }
  const all = agree.both + agree.neither + agree.realOnly + agree.maskOnly;
  const pct = (n) => `${((n / all) * 100).toFixed(1)}%`;
  log(`mask against the real POV demo, ${all} samples: shown in both ${pct(agree.both)}, hidden in both ${pct(agree.neither)}, only the real demo shows ${pct(agree.realOnly)}, only the mask shows ${pct(agree.maskOnly)}`);
  const inSpan = (rows) => rows.filter((r) => r[0] >= from && r[0] <= to).length;
  const [hFrom, hTo] = [from + dtAt(from), to + dtAt(to)];
  const inSpanShifted = (rows) => rows.filter((r) => r[0] >= hFrom && r[0] <= hTo).length;
  log(`hints, real / mask: radar ${inSpan(pov.radar)} / ${inSpanShifted(masked.radar)}, shots of hidden players ${inSpan(pov.fires)} / ${inSpanShifted(masked.fires)}, sounds ${inSpan(pov.sounds)} / ${inSpanShifted(masked.sounds)}`);
  for (const who of ['mate', 'enemy']) {
    const list = errors[who].sort((a, b) => a - b);
    const q = (p) => Math.round(list[Math.min(list.length - 1, Math.floor(list.length * p))] ?? NaN);
    log(`fill of the real POV demo, ${who}: ${Math.round(hidden[who] / 4)} s hidden, ${Math.round((list.length / Math.max(1, hidden[who])) * 100)}% estimated, error median ${q(0.5)}, p75 ${q(0.75)}, p90 ${q(0.9)} units`);
  }
  for (const [key, list] of Object.entries(detail).sort((a, b) => b[1].length - a[1].length).slice(0, 14)) {
    list.sort((a, b) => a - b);
    log(`  ${key}: ${Math.round(list.length / 4)} s, median ${Math.round(list[list.length >> 1])}, p90 ${Math.round(list[Math.floor(list.length * 0.9)])}`);
  }
  for (const who of ['mate', 'enemy']) {
    const list = maskErrors[who].sort((a, b) => a - b);
    const q = (p) => Math.round(list[Math.min(list.length - 1, Math.floor(list.length * p))] ?? NaN);
    log(`fill of the mask, ${who}: error median ${q(0.5)}, p75 ${q(0.75)}, p90 ${q(0.9)} units`);
  }
  log(`fill: ${JSON.stringify(filled.fill)}; of the mask: ${JSON.stringify(filledMask.fill)}`);
  return { agree, hidden, errors, maskErrors, detail };
}
