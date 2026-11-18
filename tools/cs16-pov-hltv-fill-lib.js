// The library of the fill: the players that a GoldSrc POV demo hides, estimated (src/fill). It needs the demo and
// the BSP of its map, and no file of this repository. tools/pack-fill-lib.js packs it as a package of its own.

import { fillTimeline } from '../src/fill/fill.js';
import { buildTimeline } from '../src/timeline.js';
import { fillLevelFromBsp } from './lib/fill-level.js';

export { buildTimeline } from '../src/timeline.js';
export { ESTIMATE, FILL_VERSION, fillTimeline } from '../src/fill/fill.js';
export { withoutEstimates } from '../src/shared/estimates.js';
export { maskAsPov } from '../src/fill/mask.js';
export { packRoutes, readRoutes, routesOf, shrinkRoutes } from '../src/fill/routes.js';
export { joinTimelines } from '../src/join.js';
export { fillLevelFromBsp, levelFit, levelIdOf } from './lib/fill-level.js';
export { add, line, measureRun, newStats, recordersOf, report } from './lib/fill-measure.js';
export { findRoutes, listRoutes, routesName } from './lib/fill-routes.js';
export { checkPair } from './lib/fill-pair.js';

/**
 * The filled timeline of a POV demo. `demo` and `bsp` are the bytes of the .dem file and of its map; `routes` is
 * optional: the routes of real players on that map (readRoutes()). The demo itself never changes.
 */
export function fillDemo(demo, bsp, { routes = null, file = null } = {}) {
  const timeline = buildTimeline(demo, { file });
  const level = fillLevelFromBsp(bsp, timeline.map);
  level.routes = routes;
  return fillTimeline(timeline, level);
}
