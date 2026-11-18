// How many frames the offset between the two clocks is the median of, and how many it needs before it is trusted.
const WINDOW = 101;
const WARM = 9;
// A snapshot cannot be later than the frame that brought it: one that is, by more than this, is a glitch.
const AHEAD = 0.1;

/**
 * The time of a frame's snapshot on the frame clock. A demo stamps a frame when the proxy wrote it, but the
 * proxy writes in bunches: two frames 0.01 s apart can carry snapshots 0.055 s apart, and positions on the frame
 * clock jump, then wait. The server time of the snapshot (svc_time) spaces them right; the median of
 * (frame time - server time) moves it onto the frame clock, which the messages of the demo keep.
 */
export class SnapshotClock {
  constructor() {
    // The window in arrival order, and the same values sorted.
    this.offsets = [];
    this.sorted = [];
  }

  /** The snapshot's time, or null for a snapshot that cannot be placed (a server time ahead of its frame). */
  at(frameTime, serverTime) {
    const offset = frameTime - serverTime;
    this.offsets.push(offset);
    this.sorted.splice(lowerBound(this.sorted, offset), 0, offset);
    if (this.offsets.length > WINDOW) this.sorted.splice(lowerBound(this.sorted, this.offsets.shift()), 1);
    if (this.offsets.length < WARM) return frameTime;
    const at = serverTime + this.sorted[this.sorted.length >> 1];
    return at > frameTime + AHEAD ? null : at;
  }
}

/** The first index of a sorted list whose value is not below `value`. */
function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
