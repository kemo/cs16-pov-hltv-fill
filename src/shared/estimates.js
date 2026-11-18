// The estimates of a filled POV timeline (src/fill): the players that the demo hides, put into its rows. A reader
// that judges a person (aim, cheats, the profile of a bot) or plays a round again takes a timeline without them.

/** The flag of an estimated sample: bit 15, over the eleven bits of the pitch. */
export const ESTIMATE = 1 << 15;

/**
 * The timeline with the samples of the demo only. Changes `timeline` in place and returns it; a timeline with no
 * estimates comes back untouched. The weapon and animation rows of the fill stay: they judge nobody.
 */
export function withoutEstimates(timeline) {
  if (!timeline?.fill) return timeline;
  timeline.samples = timeline.samples.map((row) => {
    let out = null;
    for (let i = 1; i < row.length; i += 6) {
      if (!(row[i + 5] & ESTIMATE)) continue;
      out ??= row.slice(0, i);
      // The estimates are the last entries of a row.
      break;
    }
    if (!out) return row;
    for (let i = out.length; i < row.length; i += 6) if (!(row[i + 5] & ESTIMATE)) out.push(...row.slice(i, i + 6));
    return out;
  });
  delete timeline.fill;
  delete timeline.estimates;
  return timeline;
}
