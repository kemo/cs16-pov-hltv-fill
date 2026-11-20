// Which game a demo is of. CS 1.6 has its own player models, view models and builds of four levels.

// The player models of CS 1.5 hold 95 sequences. CS 1.6 holds 111: its flinches and deaths are 99 to 110.
const SEQUENCES_15 = 95;
const known = new WeakMap();

/**
 * Whether a timeline is of CS 1.6: net protocol 47 and up, or a demo of the 1.6 beta of 2003, which keeps
 * protocol 46 and shows itself by a player sequence that CS 1.5 does not have (`anims`: [t, entity, sequence, gait]).
 */
export function isCs16(timeline) {
  const protocol = timeline?.source?.netProtocol ?? 0;
  if (protocol !== 46) return protocol >= 47;
  if (!known.has(timeline)) known.set(timeline, (timeline.anims ?? []).some((row) => row[2] >= SEQUENCES_15));
  return known.get(timeline);
}
