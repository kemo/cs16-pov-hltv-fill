// Cleans the tracks of the timeline's samples. Pure module.

const MAX_RUN = 6;
const JUMP = 250;
const BRIDGE_SPEED = 600;
const BRIDGE_TIME = 1.5;

/**
 * Replaces spikes in the tracks of living players: a run of 1 to 6 samples (a third of a second) far from both its neighbours, while
 * the neighbours themselves are a plausible step apart. Some servers send a player to an old or a zero position
 * for a frame (anti-wallhack plugins of 2002); a real teleport, such as a respawn, does not come back, so it
 * stays. The run takes the line between its neighbours. `samples` is changed in place and returned.
 */
export function smoothSpikes(samples) {
  const tracks = new Map();
  for (let r = 0; r < samples.length; r++) {
    const row = samples[r];
    for (let i = 1; i < row.length; i += 6) {
      if (row[i + 5] & 1) continue;
      if (!tracks.has(row[i])) tracks.set(row[i], []);
      tracks.get(row[i]).push({ row, i });
    }
  }
  const at = ({ row, i }) => ({ t: row[0], x: row[i + 1], y: row[i + 2], z: row[i + 3] });
  const far = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > JUMP;
  for (const track of tracks.values()) {
    for (let s = 1; s < track.length - 1; s++) {
      const before = at(track[s - 1]);
      for (let k = 1; k <= MAX_RUN && s + k < track.length; k++) {
        const after = at(track[s + k]);
        const span = after.t - before.t;
        if (span <= 0 || span > BRIDGE_TIME) break;
        const bridge = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
        const run = track.slice(s, s + k).map(at);
        if (!far(before, run[0]) || !far(run[k - 1], after) || bridge > Math.max(JUMP, BRIDGE_SPEED * span)) continue;
        for (let j = 0; j < k; j++) {
          const { row, i } = track[s + j];
          const f = (row[0] - before.t) / span;
          row[i + 1] = Math.round(before.x + (after.x - before.x) * f);
          row[i + 2] = Math.round(before.y + (after.y - before.y) * f);
          row[i + 3] = Math.round(before.z + (after.z - before.z) * f);
        }
        s += k - 1;
        break;
      }
    }
  }
  return samples;
}

/**
 * The samples of a POV demo without the players at 0,0,0: the demo holds a player with no place yet there (the
 * baseline before its first full packet). Runs after `smoothSpikes()`, which takes the short runs. Changed in place.
 */
export function withoutUnplaced(samples) {
  for (const row of samples) {
    for (let i = row.length - 6; i >= 1; i -= 6) {
      if (!row[i + 1] && !row[i + 2] && !row[i + 3]) row.splice(i, 6);
    }
  }
  return samples;
}
