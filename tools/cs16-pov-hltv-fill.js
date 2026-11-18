#!/usr/bin/env node
// The command line of the fill (tools/cs16-pov-hltv-fill-lib.js).
//   cs16-pov-hltv-fill fill <pov.dem> [<second half.dem>...] --maps <folder> [--out <timeline.json or .json.br>]
//                           [--dem <folder>]
//       The timeline of a POV demo with the players that it hides, estimated. Several demos are the parts of one
//       match, in their order (one demo for each half): they become one timeline. --dem writes a copy of each demo
//       with the estimated players in it (<name>.filled.dem), which the game plays; the demos themselves stay.
//   cs16-pov-hltv-fill routes <hltv.dem>... --maps <folder> --out <folder>
//       The routes of the real players of your own HLTV demos, one file for each map: the fill follows them.
//   cs16-pov-hltv-fill check <pov.dem> <hltv.dem> --maps <folder>
//       The error of the fill on a match that you have as a POV demo and as an HLTV demo.
//   cs16-pov-hltv-fill measure <hltv.dem>... --maps <folder> [--recorders 2]
//       The error and the faults of the fill on HLTV demos: one player's POV is made from each, filled, and
//       compared with the demo itself.
//   cs16-pov-hltv-fill maps
//       The maps that have routes, shipped or your own.
// The map: --maps <folder> takes <folder>/<map of the demo>.bsp (your cstrike/maps folder); --bsp <file> names it.
// The routes: --routes <file>, else a file of the level in --routes-dir <folder>, else one that ships with the
// tool. A map with no routes stops the fill; --no-routes fills it with the plain ways.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliCompressSync } from 'node:zlib';
import {
  ESTIMATE, NOTICE, add, buildTimeline, checkPair, fillLevelFromBsp, fillTimeline, joinTimelines, levelFit, line, measureRun, newStats, packRoutes,
  readRoutes, recordersOf, report, routesOf, shrinkRoutes, writeFilledDemo,
} from './cs16-pov-hltv-fill-lib.js';
import { findRoutes, listRoutes, routesName } from './lib/fill-routes.js';

const USAGE = `Usage:
  cs16-pov-hltv-fill fill <pov.dem> [<second half.dem>...] --maps <folder> [--out <timeline.json|.json.br>] [--dem <folder>]
  cs16-pov-hltv-fill routes <hltv.dem>... --maps <folder> --out <folder>
  cs16-pov-hltv-fill check <pov.dem> <hltv.dem> --maps <folder>
  cs16-pov-hltv-fill measure <hltv.dem>... --maps <folder> [--recorders 2]
  cs16-pov-hltv-fill maps

The map:    --maps <folder>  takes <folder>/<map of the demo>.bsp (for example your cstrike/maps folder)
            --bsp <file>     names the .bsp itself
The routes: --routes <file>  one routes file
            --routes-dir <folder>  your own routes (made with "routes"); read before the ones that ship
            --no-routes      fill a map that has no routes with the plain ways
The demo:   --dem <folder>   a copy of each demo with the estimated players in it, as <name>.filled.dem`;
const { values: opts, positionals: [command, ...files] } = parseArgs({
  allowPositionals: true,
  options: {
    bsp: { type: 'string' }, maps: { type: 'string' }, routes: { type: 'string' }, 'routes-dir': { type: 'string' },
    'no-routes': { type: 'boolean' }, out: { type: 'string' }, dem: { type: 'string' }, recorders: { type: 'string', default: '2' },
  },
});
const stop = (text) => {
  console.error(text);
  process.exit(1);
};
// The share of a POV demo's players that must lie in the set of its recorder on the given .bsp.
const FITS = 0.95;
// The routes that ship with the tool lie beside its code; your own folder comes first.
const SHIPPED = fileURLToPath(new URL('../routes', import.meta.url));
const routeDirs = [...(opts['routes-dir'] ? [opts['routes-dir']] : []), SHIPPED];

if (command === 'maps') {
  const rows = listRoutes(routeDirs);
  if (!rows.length) console.log('No routes: neither shipped nor in --routes-dir.');
  for (const { map, id, file } of rows) console.log(`${map.padEnd(16)} level ${id}  ${file}`);
  process.exit(0);
}
if (!['fill', 'routes', 'check', 'measure'].includes(command) || !files.length || (!opts.bsp && !opts.maps)) stop(USAGE);

/** The timeline of a demo. A filled copy (--dem) is refused: its estimates would read as real samples. */
const timelineOf = (file, frameTimes = null) => {
  const demo = readFileSync(file);
  if (demo.includes(NOTICE, 0, 'latin1')) stop(`${file} is a filled copy of a demo: its hidden players are estimates. Use the original demo.`);
  return buildTimeline(demo, { file: basename(file), frameTimes });
};

/** The bytes of the .bsp of a map: --bsp, or the file of that name in --maps (in any case of letters). */
function bspOf(map) {
  if (opts.bsp) return readFileSync(opts.bsp);
  const name = readdirSync(opts.maps).find((f) => f.toLowerCase() === `${map}.bsp`);
  if (!name) stop(`${opts.maps} has no ${map}.bsp. The demo was played on ${map}: put its .bsp there, or name it with --bsp.`);
  return readFileSync(join(opts.maps, name));
}

/** The level of a timeline with its routes; stops where the map has none and --no-routes is not given. */
function levelOf(timeline) {
  const level = fillLevelFromBsp(bspOf(timeline.map), timeline.map);
  // CS 1.5 and CS 1.6 have maps of one name with other walls. On the right build, about 98% of the players that
  // a POV demo holds lie in what its recorder could see.
  const fit = levelFit(timeline, level);
  if (fit < FITS) {
    stop(`This .bsp is another build of ${timeline.map} than the one of the demo: only ${Math.round(fit * 100)}% of the demo's players lie where its recorder could see them (about 98% on the right build).
Use the ${timeline.map}.bsp of the game version that the demo was played on (CS 1.5 and CS 1.6 differ on some maps).`);
  }
  if (opts['no-routes']) return level;
  const file = opts.routes ?? findRoutes(routeDirs, timeline.map, level.id);
  if (file) {
    level.routes = readRoutes(readFileSync(file));
    if (level.routes.level && level.routes.level !== level.id) stop(`${file} is for another build of ${timeline.map} (level ${level.routes.level}, yours is ${level.id}).`);
    console.log(`routes: ${file} (${level.routes.n} routes of real players)`);
    return level;
  }
  const others = listRoutes(routeDirs).filter((r) => r.map === timeline.map);
  stop(`No routes for ${timeline.map} (level ${level.id}).
${others.length ? `There are routes for another build of ${timeline.map} (level ${others.map((r) => r.id).join(', ')}): your .bsp has other walls.\n` : ''}Routes are the ways of real players on a map. With them a hidden enemy follows a way that a real player took.
Make your own from HLTV demos of ${timeline.map} (the more the better, 10 and up):
  cs16-pov-hltv-fill routes <hltv demos of ${timeline.map}> --maps ${opts.maps ?? '<folder>'} --out my-routes
  cs16-pov-hltv-fill fill ${basename(files[0])} --maps ${opts.maps ?? '<folder>'} --routes-dir my-routes
Or fill without routes (--no-routes): right in what the demo knows, simple in what it does not.`);
}

if (command === 'fill') {
  // Several demos are the parts of one match (one demo for each half), in their order.
  const frameTimes = files.map(() => []);
  const parts = files.map((file, i) => timelineOf(file, frameTimes[i]));
  if (parts.some((tl) => tl.source.kind !== 'pov')) stop(`${files[parts.findIndex((tl) => tl.source.kind !== 'pov')]} is an HLTV demo: it hides nobody.`);
  const timeline = parts.length > 1 ? joinTimelines(parts) : parts[0];
  const filled = fillTimeline(timeline, levelOf(timeline));
  let estimated = 0;
  let all = 0;
  for (const row of filled.samples) {
    for (let i = 1; i < row.length; i += 6) {
      all++;
      if (row[i + 5] & ESTIMATE) estimated++;
    }
  }
  console.log(`${timeline.map}, ${Math.round(timeline.duration)} s: ${filled.estimates.length} hidden spans filled, ${estimated} of ${all} samples are estimates`);
  console.log(`ways: ${filled.fill.ways}, with a real player's route: ${filled.fill.guided}, faster than a run: ${filled.fill.relaxed}, straight lines: ${filled.fill.straight}`);
  if (opts.out) {
    const json = Buffer.from(JSON.stringify(filled));
    writeFileSync(opts.out, opts.out.endsWith('.br') ? brotliCompressSync(json) : json);
    console.log(`written: ${opts.out}`);
  }
  if (opts.dem) {
    // Each part keeps its own clock: it starts at its recorder's row of the joined timeline.
    const starts = timeline.recorders ? timeline.recorders.map(([t]) => t) : [0];
    const outs = files.map((file) => resolve(opts.dem, `${basename(file).replace(/\.dem$/i, '')}.filled.dem`));
    const clash = outs.find((out) => files.some((file) => resolve(file) === out));
    if (clash) stop(`${clash} is one of the demos: the fill never writes over a demo. Give --dem another folder.`);
    mkdirSync(opts.dem, { recursive: true });
    files.forEach((file, i) => {
      const { demo, frames, added } = writeFilledDemo(readFileSync(file), filled, { frameTimes: frameTimes[i], offset: starts[i] });
      writeFileSync(outs[i], demo);
      console.log(`written: ${outs[i]} (${added} estimated player states in ${frames} frames)`);
    });
    console.log(`The console of the game prints at the start of each copy: ${NOTICE.trim()}`);
  }
} else if (command === 'routes') {
  if (!opts.out) stop('routes needs --out <folder>.');
  // One file for each map of the demos: its name holds the id of the level, so the fill finds it by the .bsp.
  const maps = new Map();
  for (const file of files) {
    const timeline = timelineOf(file);
    if (timeline.source.kind !== 'hltv') {
      console.log(`${file}: a POV demo, left out (routes come from HLTV demos: they hold every player)`);
      continue;
    }
    if (!maps.has(timeline.map)) maps.set(timeline.map, { sources: [], lists: [] });
    maps.get(timeline.map).sources.push(basename(file));
    maps.get(timeline.map).lists.push(routesOf(timeline));
    console.log(`${file}: ${timeline.map}, ${maps.get(timeline.map).lists.at(-1).length} routes`);
  }
  mkdirSync(opts.out, { recursive: true });
  for (const [map, { sources, lists }] of maps) {
    const id = fillLevelFromBsp(bspOf(map), map).id;
    const to = join(opts.out, routesName(map, id));
    writeFileSync(to, shrinkRoutes(packRoutes(sources, lists, { map, level: id }), { names: true }));
    console.log(`written: ${to} (${sources.length} demos, ${lists.reduce((n, l) => n + l.length, 0)} routes)`);
  }
} else if (command === 'measure') {
  const total = newStats();
  for (const file of files) {
    const truth = timelineOf(file);
    if (truth.source.kind !== 'hltv') {
      console.log(`${file}: a POV demo, left out (the measure needs the truth of an HLTV demo)`);
      continue;
    }
    const level = levelOf(truth);
    for (const recorder of recordersOf(truth, Number(opts.recorders))) {
      const stats = measureRun(truth, recorder, level);
      add(total, stats);
      console.log(`${basename(file)} ${truth.map}, the POV of player ${recorder}: ${line(stats)}`);
    }
  }
  console.log(`\nALL: ${line(total)}`);
  console.log(JSON.stringify(report(total), null, 1));
} else {
  if (files.length < 2) stop('check needs a POV demo and an HLTV demo.');
  const pov = timelineOf(files[0]);
  checkPair(pov, timelineOf(files[1]), levelOf(pov));
}
