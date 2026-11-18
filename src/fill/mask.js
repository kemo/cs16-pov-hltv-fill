// Makes the POV timeline that one player of an HLTV timeline would have recorded: the measure of the fill has the
// true place of every hidden player then. The rules are the server's: the set of the recorder's eye for the
// players, the audible set for the sounds and the shots, the radar of the team once a second.

import { fatPvs, holds, leafAt, pasOf, playerSeen } from './vis.js';

const DEAD = 1;
const CT = 4;
const DUCKING = 8;
// The view offset of a standing player; a ducking one has 12 and the game takes 18 off (serverEye()).
const EYE_STAND = 17;
const EYE_DUCK = 12 - 18;
// CBasePlayer::UpdateClientData: the radar goes out once a second for a player that moved this far.
const RADAR_SECONDS = 1;
const RADAR_MOVE = 64;
const STEP_SOUND = /^(player\/|weapons\/|items\/)/;

/** The HLTV timeline as the POV demo of `recorder` (an entity). The input does not change. */
export function maskAsPov(timeline, recorder, vis) {
  const set = new Uint8Array(vis.rowBytes);
  const eyes = [];
  const radar = [];
  const lastRadar = new Map();
  let target = null;
  let eye = null;
  // The recorder's own place at each row, for the audible set: [t, leaf].
  const ears = [];
  const hidden = new Map();
  const state = new Map();

  const samples = timeline.samples.map((row) => {
    state.clear();
    for (let i = 1; i < row.length; i += 6) state.set(row[i], i);
    const alive = (e) => state.has(e) && !(row[state.get(e) + 5] & DEAD);
    const sideBit = (e) => row[state.get(e) + 5] & CT;
    let from = recorder;
    if (!alive(recorder)) {
      // A dead player watches a teammate, then anybody: the server takes the eye of the watched player.
      if (target === null || !alive(target)) {
        const mine = state.has(recorder) ? sideBit(recorder) : null;
        const others = [...state.keys()].filter((e) => e !== recorder && alive(e));
        target = others.find((e) => mine === null || sideBit(e) === mine) ?? others[0] ?? null;
      }
      from = target;
    } else target = null;
    if (from !== null && state.has(from)) {
      const i = state.get(from);
      const next = [row[i + 1], row[i + 2], row[i + 3] + (row[i + 5] & DUCKING ? EYE_DUCK : EYE_STAND)];
      if (!eye || eye[0] !== next[0] || eye[1] !== next[1] || eye[2] !== next[2]) {
        eye = next;
        eyes.push([row[0], ...eye]);
        if (leafAt(vis, eye) !== 0) fatPvs(vis, eye, set);
        else set.fill(255);
      }
      ears.push([row[0], leafAt(vis, [row[i + 1], row[i + 2], row[i + 3]])]);
    }
    const out = [row[0]];
    for (let i = 1; i < row.length; i += 6) {
      const e = row[i];
      const seen = e === recorder || !eye || playerSeen(vis, set, [row[i + 1], row[i + 2], row[i + 3]], (row[i + 5] & DUCKING) !== 0);
      if (seen) out.push(...row.slice(i, i + 6));
      else if (!(row[i + 5] & DEAD)) noteHidden(hidden, e, row[0]);
      // The radar: a living teammate, to a living recorder.
      if (e === recorder || !alive(recorder) || (row[i + 5] & DEAD) || sideBit(e) !== sideBit(recorder)) continue;
      const last = lastRadar.get(e);
      if (last && row[0] - last.t < RADAR_SECONDS) continue;
      if (last && Math.hypot(row[i + 1] - last.x, row[i + 2] - last.y, row[i + 3] - last.z) >= RADAR_MOVE) radar.push([row[0], e, row[i + 1], row[i + 2], row[i + 3]]);
      lastRadar.set(e, { t: row[0], x: row[i + 1], y: row[i + 2], z: row[i + 3] });
    }
    return out;
  });

  const earAt = (t) => {
    let lo = 0;
    let hi = ears.length - 1;
    if (hi < 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ears[mid][0] <= t) lo = mid; else hi = mid - 1;
    }
    return ears[lo][1];
  };
  const hears = (t, x, y, z) => {
    const ear = earAt(t);
    const leaf = leafAt(vis, [x, y, z]);
    return ear === 0 || leaf === 0 || holds(pasOf(vis, leaf), ear);
  };
  const isHidden = (e, t) => (hidden.get(e) ?? []).some(([a, b]) => t >= a - 0.05 && t <= b + 0.05);

  // The sounds of a player reach the recorder inside the audible set of their place.
  const sounds = (timeline.sounds ?? []).filter(([t, name, entity, x, y, z]) => !(entity >= 1 && entity <= 32 && STEP_SOUND.test(timeline.soundNames[name])) || entity === recorder || hears(t, x, y, z));
  // The shots too: one of a hidden player comes with its place and its aim.
  const fires = [];
  const shots = (timeline.shots ?? []).filter(([t, entity]) => {
    if (entity === recorder || !isHidden(entity, t)) return true;
    const at = placeAt(timeline, entity, t);
    if (!at || !hears(t, at[0], at[1], at[2])) return false;
    fires.push([t, entity, at[0], at[1], at[2], at[3], 0]);
    return true;
  });

  return {
    ...timeline,
    source: { ...timeline.source, kind: 'pov', masked: true },
    recorder,
    samples,
    sounds,
    shots,
    eyes,
    radar,
    fires,
  };
}

function noteHidden(hidden, entity, t) {
  if (!hidden.has(entity)) hidden.set(entity, []);
  const spans = hidden.get(entity);
  const last = spans.at(-1);
  if (last && t - last[1] < 0.5) last[1] = t;
  else spans.push([t, t]);
}

/** The place and the yaw of a player in the row nearest a time: [x, y, z, yaw]; null when no row within 0.3 s holds it. */
export function placeAt(timeline, entity, t) {
  const rows = timeline.samples;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  for (const k of [lo, lo + 1, lo - 1]) {
    const row = rows[k];
    if (!row || Math.abs(row[0] - t) > 0.3) continue;
    for (let i = 1; i < row.length; i += 6) if (row[i] === entity) return [row[i + 1], row[i + 2], row[i + 3], row[i + 4]];
  }
  return null;
}
