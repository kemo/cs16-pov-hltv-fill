// The windows of a timeline: a round from its restart to the next one, and the time before the first round.

// Units. A seen player that goes further than this in two seconds went to a spawn.
const RESPAWN = 500;

/** The seen samples of each living player: entity -> [[t, x, y, z, yaw]]. */
export function tracksOf(timeline) {
  const tracks = new Map();
  for (const row of timeline.samples) {
    for (let i = 1; i < row.length; i += 6) {
      if (row[i + 5] & 1) continue;
      if (!tracks.has(row[i])) tracks.set(row[i], []);
      tracks.get(row[i]).push([row[0], row[i + 1], row[i + 2], row[i + 3], row[i + 4]]);
    }
  }
  return tracks;
}

// Seconds between a clock and the scoreboard row of a player that lives again with it.
const REVIVED = 0.3;
// Seconds by which a clock may differ from the running one and still be the same clock.
const GOES_ON = 2.5;

/** The times at which a dead player lives again (ScoreAttrib goes to every client): the game does that only at a restart. */
function revivals(timeline) {
  const dead = new Set();
  const out = [];
  for (const [t, entity, flags] of timeline.attribs ?? []) {
    if (flags & 1) dead.add(entity);
    else if (dead.delete(entity) && out.at(-1) !== t) out.push(t);
  }
  return out;
}

/** The first index of a track ([t, ...] rows) at or after t. */
export function lowerBound(track, t) {
  let lo = 0;
  let hi = track.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid][0] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * [{t0, t1, round, goAt}]: `round` when the window starts with a restart (every player on a spawn), `goAt` when
 * the players may move (the end of the freeze).
 */
export function windowsOf(timeline, tracks = tracksOf(timeline)) {
  // A round sends its clock twice: the freeze at the restart, then the round's own time when it goes live. A POV
  // demo holds more clocks: the server sends the time that is left again when the recorder's HUD starts again (a
  // dead recorder that watches another player). A clock is a restart only after a round end, or where a seen
  // player leaps (a restart by the admin has no round end).
  const starts = [];
  const live = new Map();
  const ends = (timeline.rounds ?? []).filter((r) => r.kind === 'end').map((r) => r.t);
  const leapAt = (t) => {
    for (const track of tracks.values()) {
      const i = lowerBound(track, t - 1);
      const j = lowerBound(track, t + 1) - 1;
      if (i < track.length && j > i && track[j][0] - track[i][0] < 2.5 && Math.hypot(track[j][1] - track[i][1], track[j][2] - track[i][2]) > RESPAWN) return true;
    }
    return false;
  };
  const revived = revivals(timeline);
  const revivedAt = (t) => revived.some((at) => Math.abs(at - t) <= REVIVED);
  let lastStart = null;
  // The clock before this one, whatever it was: a clock that the recorder's HUD asked for goes on from it.
  let clock = null;
  for (const r of timeline.rounds ?? []) {
    if (r.kind !== 'start') continue;
    const goesOn = clock !== null && Math.abs(Math.max(0, clock.seconds - (r.t - clock.t)) - r.seconds) <= GOES_ON;
    clock = r;
    if (lastStart && r.t - lastStart.t < 1 && r.seconds === lastStart.seconds) continue;
    // A dead player lives again with a clock that starts anew: a restart, also with no round end and no seen leap
    // (the admin starts the round again while the recorder is dead). A recorder that joins late lives again too,
    // but its clock goes on.
    if (lastStart && !goesOn && revivedAt(r.t)) {
      starts.push(r.t);
      lastStart = r;
      continue;
    }
    if (lastStart && r.seconds > lastStart.seconds && r.t - lastStart.t < lastStart.seconds + 3 && !live.has(lastStart.t)) {
      live.set(lastStart.t, r.t);
      continue;
    }
    if (lastStart && !ends.some((t) => t >= lastStart.t && t <= r.t + 0.5) && !leapAt(r.t)) continue;
    starts.push(r.t);
    lastStart = r;
  }
  // A part of a joined timeline starts a window too: the recording stopped between the parts.
  const cuts = new Set(starts);
  for (const [t] of (timeline.recorders ?? []).slice(1)) cuts.add(t);
  const edges = [...cuts].sort((a, b) => a - b);
  const windows = [];
  if (!edges.length || edges[0] > 0) windows.push({ t0: 0, t1: edges[0] ?? timeline.duration, round: false, goAt: 0 });
  edges.forEach((t, i) => windows.push({ t0: t, t1: edges[i + 1] ?? timeline.duration, round: starts.includes(t), goAt: live.get(t) ?? null }));
  // Without the second clock, the freeze ends when the first seen player leaves its place.
  for (const win of windows) {
    if (win.goAt !== null) continue;
    win.goAt = win.t0;
    if (!win.round) continue;
    let go = Infinity;
    for (const track of tracks.values()) {
      let first = null;
      for (let i = lowerBound(track, win.t0 + 0.3); i < track.length && track[i][0] < Math.min(win.t1, go); i++) {
        first ??= track[i];
        if (Math.hypot(track[i][1] - first[1], track[i][2] - first[2]) > 24) {
          go = track[i][0];
          break;
        }
      }
    }
    if (go !== Infinity) win.goAt = go;
  }
  return windows;
}
