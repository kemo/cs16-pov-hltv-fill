# cs16-pov-hltv-fill

**Fills a Counter-Strike 1.6 (or 1.5) POV demo with the players that its recorder could not see, so it plays
with all ten players, as an HLTV demo does.**

A demo that a player recorded with `record` (a POV demo) holds only what the server sent to that player. An enemy
behind a wall is not in the file. This tool estimates where each hidden player was at every moment, from what
the demo still holds of that player and from the map.

What it is:

- a reader of GoldSrc `.dem` files (net protocols 45 to 48: CS 1.3 to 1.6), POV and HLTV;
- a model of what the game server sends to a client, built from the `.bsp` of the map (the same visibility data
  that the server used);
- a walk graph of the map, built from the same `.bsp`: where a player can walk, drop, jump and climb, and how
  long each way takes;
- the fill itself: a way for each hidden player between the places that the demo knows;
- a writer of a filled copy of the demo: the same `.dem` with the estimated players in its packets, for the game
  (not yet tested in the game);
- a measure: it hides players from an HLTV demo as a POV demo would, fills them, and compares with the truth.

What it is not:

- It does not change your demo. The fill gives a timeline (JSON) and, with `--dem`, a copy of each demo with a
  new name.
- It does not make an HLTV demo. The copy stays a POV demo: the game shows it from the recorder's eyes, so most
  added players are behind walls. You see them with a free camera (for example HLAE) or a viewer of the timeline.
- It does not know what happened. An estimate is a guess that fits everything the demo knows. Each estimated
  sample is marked.
- It holds no game file and no demo. You bring the `.dem` and the `.bsp`.

It needs Node 22 or later and no other package. `npm test` runs its tests.

## Install

```sh
git clone https://github.com/kemo/cs16-pov-hltv-fill.git && cd cs16-pov-hltv-fill
npm test                 # optional: its own tests
npm link                 # optional: the command cs16-pov-hltv-fill on your path
```

Without `npm link`, write `node tools/cs16-pov-hltv-fill.js` where the examples say `cs16-pov-hltv-fill`.

## Use

```sh
# A match of two halves (one demo for each half), with the maps of your own game folder.
cs16-pov-hltv-fill fill first-half.dem second-half.dem --maps "/path/to/Half-Life/cstrike/maps" --out match.json.br
```

That is all for de_dust2, de_inferno, de_nuke, de_train, de_cbble and de_tuscan: their routes ship with the tool.

### A filled copy of the demo

```sh
# A copy of each half with the estimated players in it: filled/first-half.filled.dem, filled/second-half.filled.dem
cs16-pov-hltv-fill fill first-half.dem second-half.dem --maps "/path/to/Half-Life/cstrike/maps" --dem filled
```

- Nobody has played a copy in the game yet. On real demos, a copy with no estimate is the same as the demo, byte
  for byte, in every frame but the few full packets. A filled copy decodes to the places of the fill.
- The copy is the same demo, frame for frame. Only the packet entities change: each player that the fill
  estimated is in every frame where the demo does not hold it. A player that the demo holds keeps its real state.
- Your demo stays as it is. The tool never writes over a demo.
- At the start of its playback, the copy prints in the console: "This demo holds estimated players
  (cs16-pov-hltv-fill)". The `.dem` format has no other place to mark an estimate.
- Each command of the tool refuses a filled copy as its input, so an estimate never becomes a real sample.
- Do not give a filled copy to a tool that judges players (aim, reaction, cheats): it cannot tell an estimate
  from a record.

### Your own maps

**Any map works.** The tool reads the `.bsp` and builds what it needs from it in under a second: where a player
can walk, drop, jump and climb, where the spawns are, and what the server sends to whom. There are no prepared
map files.

- `--maps <folder>` takes `<folder>/<map of the demo>.bsp`. Give it your own `cstrike/maps` folder, or any folder
  that holds your `.bsp` files.
- `--bsp <file>` names one `.bsp` itself.
- Use the `.bsp` of the game version of the demo. CS 1.5 and CS 1.6 have maps of one name with other walls
  (de_inferno, de_nuke, de_cbble, de_aztec). The tool checks this: on the wrong build it stops and says so.

### Routes: the ways of real players

A hidden enemy that the demo knows little of follows a real player: one that was at the same place at the same
second of a round. These ways come from other demos of the map and are called routes.

- **Shipped:** routes for the maps above, from public HLTV demos (14 to 152 demos a map). They hold places and
  view directions only, no name and no match. `cs16-pov-hltv-fill maps` lists them.
- **A map with no routes:** the fill stops and tells you. You then have two choices.
- **Make your own, for any map**, from your own demos of it:

  ```sh
  cs16-pov-hltv-fill routes demo1.dem demo2.dem demo3.dem --maps "/path/to/cstrike/maps" --out my-routes
  cs16-pov-hltv-fill fill match.dem --maps "/path/to/cstrike/maps" --routes-dir my-routes
  ```

  An HLTV demo gives the way of every player (10 demos and more give good ways). A POV demo gives the way of its
  recorder and, from the radar, of the recorder's teammates. So a folder of POV demos of other matches makes
  routes too: on de_dust2, routes from 80 POV demos alone gave about 70% of the gain of the routes from 152 HLTV
  demos (9 of 10 estimates of an enemy lie nearer than: 601 units with no routes, 494 with the POV routes, 452 with the
  HLTV routes).

  The demos can be of several maps: each map gets one file. A file's name holds the map and an id of the level's
  shape, so the fill finds the right file by the `.bsp`. Your folder is read before the shipped routes.
- **Or fill without routes:** `--no-routes`. The fill is then right in what the demo knows (a step, a shot, the
  radar) and simple in what it does not: a hidden player takes the shortest way and waits.

### How good is it on your demos?

```sh
# A match that you have as a POV demo and as an HLTV demo: the error of the fill against the HLTV demo.
cs16-pov-hltv-fill check match-pov.dem match-hltv.dem --maps "/path/to/cstrike/maps"

# Any HLTV demo: one player's POV is made from it, filled, and compared with the demo itself.
cs16-pov-hltv-fill measure hltv1.dem hltv2.dem --maps "/path/to/cstrike/maps"
```

### As a library

```js
import { readFileSync } from 'node:fs';
import { ESTIMATE, buildTimeline, fillLevelFromBsp, fillTimeline, joinTimelines, readRoutes } from 'cs16-pov-hltv-fill';

const halves = ['first-half.dem', 'second-half.dem'].map((file) => buildTimeline(readFileSync(file), { file }));
const timeline = halves.length > 1 ? joinTimelines(halves) : halves[0];
const level = fillLevelFromBsp(readFileSync('de_dust2.bsp'), timeline.map);
level.routes = readRoutes(readFileSync('routes/de_dust2.d46f3de29beed18b.routes'));   // optional
const filled = fillTimeline(timeline, level);
for (const row of filled.samples) {
  // row: [time, then six numbers for each player: entity, x, y, z, yaw (tenths of a degree), flags]
  for (let i = 1; i < row.length; i += 6) {
    const estimated = (row[i + 5] & ESTIMATE) !== 0;
  }
}
```

A filled copy of a demo needs the time of each of its frames, which `buildTimeline()` gives in `frameTimes`:

```js
import { writeFileSync } from 'node:fs';
import { writeFilledDemo } from 'cs16-pov-hltv-fill';

const files = ['first-half.dem', 'second-half.dem'];
const frameTimes = files.map(() => []);
const halves = files.map((file, i) => buildTimeline(readFileSync(file), { file, frameTimes: frameTimes[i] }));
// ... join and fill as above ...
const starts = filled.recorders ? filled.recorders.map(([t]) => t) : [0];   // each half on the joined clock
files.forEach((file, i) => {
  const { demo } = writeFilledDemo(readFileSync(file), filled, { frameTimes: frameTimes[i], offset: starts[i] });
  writeFileSync(file.replace(/\.dem$/, '.filled.dem'), demo);
});
```

## What comes out

A timeline: one JSON object for the demo (`timeline.md` gives every field). The fill adds:

- an entry in each row of `samples` for each living player that the row did not hold, with the flag `ESTIMATE`
  (bit 15 of the flags);
- `estimates`: the filled spans, `{entity, t0, t1, kind}`. `kind` says what the span had to go by: `between` (two
  seen samples), `hint` (a radar row, a sound, a shot or a body at one end or both), `start` (from a spawn to the
  first known place), `end` (after the last known place), `both` (nothing known in the whole round), `straight`
  (no way on the walk graph);
- weapon changes and animations for the hidden time;
- `fill`: the version of the fill and its counts.

`withoutEstimates(timeline)` gives the timeline of the demo alone.

With `--dem`, a copy of each demo comes out too (see "A filled copy of the demo").

## How it works

A hidden player is not gone from the demo. The file still holds:

- its place once a second, when it is a teammate that moves (the radar);
- its place at each of its steps, hits and reloads that the recorder could hear;
- its place and aim at each of its shots that the recorder could hear;
- where its body lay after it died;
- where it sprayed its logo: the server sends a logo to every client, with its player;
- which spawn point it got. The game gives the spawn points of a side out in turn, in the order of the players'
  entities, so the players that the demo shows on their points, a logo sprayed in the freeze, and the time at
  which a hidden player first shows give the point of each hidden player;
- that the server did not send it: so it was in no place that the recorder's client would have got. The BSP
  holds the same visibility data that the server used;
- that it made no step sound: so it did not run near the recorder.

Between two known places the player takes a way on a walk graph of the level (a floor every 32 units, built from
the BSP). The way fits the time between the two places at the speed of a run, stays out of the recorder's sight
and does not run where the recorder would have heard it.

Where the demo knows little (an enemy on the other side of the map at the start of a round), the way follows a
real player: one that was at the same place at the same second of a round in an HLTV demo of the same map. This
is what the routes file is for. Among the real players that fit, those that the demo contradicts go first (one
that the recorder would have seen or heard), and the most typical of the rest leads the way. Without routes the
hidden player takes the shortest way and waits.

`fill.md` describes each rule and its source in the game's code.

## How good it is

Measured on 24 HLTV demos of four maps. One player's POV was made from each (the same rules that the server
uses), the fill estimated the hidden players, and the HLTV demo gave the truth. The match under measure never
gave routes to itself. A player's box is 32 units wide; a run is 250 units a second.

| | Hidden time | Median error | p75 | p90 | Within 150 units | Standing still (median) |
|-|-------------|--------------|-----|-----|------------------|--------------------------|
| Teammates | 23.6 h | 17 | 39 | 86 | 93.1% | 637 |
| Enemies | 74.7 h | 29 | 136 | 403 | 76.6% | 1524 |

"Standing still" leaves each hidden player where the demo last showed it: what a viewer shows without a fill.

On 31 matches that exist as a real POV demo and as an HLTV demo (63 runs of a POV part against an HLTV part),
the enemies' median error is 48 units (p75 205, p90 549) and the teammates' 22. Routes matter: with the first
version of the fill, the enemies' median on one such match went from 40 to 121 without them.

Does it look real? The same faults were counted on the estimates and on the real samples of the demos:

| Fault | Estimates | Real samples |
|-------|-----------|--------------|
| A step faster than 320 units a second | 0.11% | 0.22% |
| A jump of the place (faster than 700 units a second) | 0.001% | 0.027% |
| A place where a standing player does not fit | 1.7% | 5.5% |
| A leap where an estimate meets a real sample | 20 of 39,175 | - |

The error grows with what the demo does not know. An enemy with a step or a shot every few seconds is within a
step or two. An enemy that the recorder neither saw nor heard for half a round is somewhere on a likely way.

An estimate is a guess that fits everything the demo knows. It is not what happened. A viewer that shows a filled
demo must say so, and nothing that judges a player (aim, reaction, cheats) may read an estimate.

## Related work

We found no other tool that fills a GoldSrc POV demo (search of November 2026). What is near:

- **GoldSrc demo readers:** [khanghugo/dem](https://github.com/khanghugo/dem) (Rust, reads and writes),
  [YaLTeR/hldemo-rs](https://github.com/yalter/hldemo-rs) (Rust),
  [talent-parser-goldsrc](https://www.npmjs.com/package/@cgdangelo/talent-parser-goldsrc) (TypeScript),
  [goldsource-parser](https://github.com/nquinquenel/goldsource-parser) (Java),
  [coldemoplayer](https://github.com/jpcy/coldemoplayer) (plays old demos in the current game). They read what a
  demo holds; none adds what it does not hold.
- **The other way round, for CS:GO:** a POV view made from a server demo
  ([csknow](https://davidbdurst.com/blog/csknow_gotv_to_pov.html), HLAE `mirv_pov`).
- **Research:** Hladky and Bulitko (2008) predicted the places of hidden opponents in Counter-Strike: Source with
  hidden semi-Markov models and particle filters, as a bot's knowledge during a match. Later work infers
  positions from first-person video ([X-Ego-CS, 2025](https://arxiv.org/abs/2510.19150)) or lifts the fog of war
  in StarCraft ([Synnaeve et al., 2018](https://arxiv.org/abs/1812.00054)). This tool works after the match, on
  the whole demo, so it can also go back in time from where a player shows up again.

## Limits

- GoldSrc only: Counter-Strike 1.3 to 1.6, net protocols 45 to 48.
- A hidden player's health is not estimated.
- A jump that the walk graph does not have (over a gap, onto a box) becomes a straight line.
- A map with no routes needs your own demos of it (HLTV, or POV of other matches), or `--no-routes`.
- The shipped routes fit one build of each map. Another build of the map (other walls) needs its own routes.
- A filled copy: the tests and a real match show that it decodes to the right entities. Nobody has played one
  in the game yet.
- In a filled copy an estimated player keeps the upper-body frame and the look of the last state that the demo
  held of it. Its pitch is level, and the game's legs follow its way.

## Licence

MIT. See `LICENSE`. The routes in `routes/` are places and view directions of players in public HLTV demos, with
no name and no match.
