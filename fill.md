# 14 POV fill

A POV demo holds only what the server sent to one player. A player outside that set is not in the demo, so the
page showed it only while the recorder saw it. The fill (`src/fill`) gives each hidden player an estimated place
at every moment, so a POV demo plays with all ten players, as an HLTV demo does.

The fill is a pass of its own: it takes a POV timeline and a level and returns a timeline. The archived `.dem`
never changes. Every estimated sample has a flag, and every filled span is listed in the timeline. A better fill
is a rebuild of the timeline, nothing more.

## 1. Rules

- **An estimate is never the demo's own record.** Each estimated sample has `ESTIMATE` (bit 15 of the sample
  flags). `timeline.estimates` lists the spans (`{entity, t0, t1, kind}`), `timeline.fill` the version and the
  counts. The page says "POV · skriveni igrači: procjena" in its info line.
- **A reader that judges a person never reads an estimate.** The aim statistics, the cheat tools, the profiles of
  the bots, the play page (`/igraj`) and the room server read a timeline through `withoutEstimates()`
  (`src/shared/estimates.js`).
- **The fill never moves a real sample.** It adds entries to rows that do not hold the player.
- **A known place is exact.** An estimated way starts and ends at the places that the demo holds, at their times.

## 2. What a POV demo knows of a hidden player

The server sends a player to a client only when the player's box touches a leaf of the client's set (section 3).
The demo still holds these facts of a player outside that set:

| Fact | Source | In the timeline |
|------|--------|-----------------|
| Its place while seen | packet entities | `samples` |
| Its place once a second, for a teammate that moves | the `Radar` message (CBasePlayer::UpdateClientData: each second, to each living teammate, when the player moved 64 units) | `radar`: `[t, entity, x, y, z]` |
| Its place and aim at each shot | `svc_event` of a weapon: the event of a player outside the packet carries origin and angles; the server sends it to the audible set | `fires`: `[t, entity, x, y, z, yaw, pitch]` |
| Its place at each step, hit, reload, pickup | `svc_sound` with its entity and origin, sent to the audible set | `sounds` |
| Where it died | `ClCorpse`, sent to every client | `corpses` |
| Where it sprayed its logo | `TE_PLAYERDECAL` with the entity of the player, sent to every client; the player is within 128 units of the logo | `sprays`: `[t, entity, x, y, z]` |
| Which spawn point it got | the order in which the game gives the points out (section 6a) | the players that the demo shows on their points |
| That it lives, its side, its kills | DeathMsg, TeamInfo, ScoreAttrib | `kills`, `sides`, `attribs` |
| That the recorder did not get it | the recorder's eye and the level's visibility data | `eyes`: `[t, x, y, z]` |
| That it did not run near | no step sound in the recorder's audible set | `sounds`, `eyes` |
| That a teammate did not move | no `Radar` row while the recorder lives | `radar` |

`eyes`, `radar` and `fires` are in POV timelines only (`src/timeline.js`). `serverEye()` is the point of the
recorder's set: the origin and the view offset of its clientdata, 18 units lower while it ducks (SetupVisibility
of the game). An observer has the origin of the player that it watches.

CS 1.5 sends `ClCorpse` without the player: the body goes to the oldest open death of its side with its model.

## 3. The server's set (`vis.js`)

`readVis()` reads the visibility data of a BSP (version 30). The rules are the engine's:

- `fatPvs(eye)`: the PVS of every leaf within 8 units of the eye (SV_FatPVS).
- `playerLeafs(origin)`: the leaves that the player's box touches, one unit larger on each side
  (SV_LinkEdict, SV_FindTouchedLeafs). `playerSeen()` is true when one of them is in the set (PF_checkvisibility).
- `pasOf(leaf)`: the leaves that hear a leaf, the union of the PVS of every leaf of its PVS (CM_CalcPAS).

On a POV demo of 2003, 98.4% of the players in the packets are inside the computed set; the others are there for
0.2 s at most (the edge of the set). On a real POV and HLTV pair of one match, the computed set and the real demo
agree on 96.8% of the samples.

## 4. The fill (`fill.js`)

1. **Windows** (`rounds.js`). A round is a window from its restart to the next one. A POV demo gets the round's
   clock again when its recorder's HUD starts again, so a clock is a restart only after a round end, where a
   seen player leaps, or where a dead player lives again while the clock starts anew (a restart by the admin:
   ScoreAttrib goes to every client, and the game gives a dead player its life back only at a restart; the clock
   of a recorder that joins late goes on from the running one).
2. **Lives.** A player lives in a window from its start (on a spawn, when the window is a round) to its death, a
   side change or the window's end.
   A slot with a side is a player only where the demo proves that it plays: a seen sample, a kill, a shot, or
   more than one radar row, in that part of the match (each demo of a join is a part, and a slot can hold
   another player in each). A referee or a spectator that sits on a side, and a slot that its player left, have
   none of these in a whole half and get no life. Fill version 5 has this rule; 22 of the 219 filled matches
   held such a slot and are built again, the others keep version 4 with the same samples.
3. **Known places.** The seen samples, then the hints of section 2 between them (a spray gives the floor nearest
   to the logo). A hint that no run reaches from
   the known place before it is another's and goes. A seen sample that no run joins to the places before it is a
   leap of the game (a respawn before the round's own clock): no way leads into it.
4. **Spans.** Each time of more than 0.3 s between two known places is a span. A shorter time between a hint
   and the next known place gets the straight line, so the player is never gone for a moment. A life with no
   known place at its start or at its end has an open span there: from its spawn point (section 6a; a free spawn
   of the side where that point is not sure), or to wherever the way goes.
5. **A way for each span** (`way.js`, section 5), then its corners rounded where the box still fits, its times
   paced so that no part is faster than a run where the whole time allows it (`pace()`), and its yaw set. Ways
   that meet at a hint are paced as one way: the time of a hint is not as exact as its place, so a part faster
   than 290 units a second takes its time from the parts beside it.
6. **Rows.** Each row inside a way that does not hold the player gets an entry: the place on the way at the
   row's time, the yaw, the side and bomb flags, a level pitch and `ESTIMATE`.
7. **Weapons** (`handsOf()`). A demo shows a new weapon of a hidden player only when it shows the player again.
   The change moves into the hidden time: to the spawn for a player that the round shows late, else to the middle
   of the hidden time or before its first hidden shot with that weapon. A hidden shot with another weapon than
   the one in hand puts that weapon into the hand.
8. **Animations** (`posesOf()`). The legs run, walk or stand as the way goes. The body keeps the pose of the
   player's nearest real row that is no death; a player from a spawn takes the pose that the demo first shows.

## 5. A way (`way.js`, `graph.js`)

The level's walk graph (`src/shared/game/nav.js`: a floor every 32 units, walks, drops, jumps, ladders) carries
the seconds of each edge at the speed of a run. A way is the cheapest walk on that graph in steps of 0.4 s: at
each step the player stays or goes to a floor that a run reaches in that time. The costs:

- a second of travel costs 1, so among equal ways the shortest wins;
- a step in a place that the recorder would have got from the server costs 500 (not in the first and the last
  0.4 s of a span beside a seen sample: there the player is on the edge of the set); the floors between two steps
  count too. Where the demo holds no player at all for a second or more (the start of a recording, before the
  first full update), nothing says that the server did not send a player: no place costs there;
- a step that runs where the recorder would have heard it costs 6, in a span of a second or more with no step
  sound of the player;
- a second 100 units from the guide costs 1 (section 6).

A hint inside the recorder's set says that the set hides nothing of this player now: the span beside it has no
cost for a seen place. Else a way left the set between two such hints and came back.

Nobody moves in the freeze of a round. When no way fits the time at the speed of a run, the search tries 1.3 and
2 times that speed. Such a span is a way that the graph does not have (a jump over a gap or onto a box): where
nothing stands between its two known places, the way is the straight line.

## 6. The routes of real players (`routes.js`)

`cs16-pov-hltv-fill routes` reads demos and writes, for each level, the route of each life of a player: its
place and yaw twice a second, on the clock of its round. The shipped files in `routes/` come from HLTV demos
and hold no name and no match: a source is a number.

- An HLTV timeline gives every player.
- A POV timeline gives the players whose whole way it holds (`knownLives()`): its recorder, and each teammate
  while the recorder lives (the radar of section 2: between two rows the teammate goes the straight way, with no
  row it stands, and it looks where it goes). An enemy has no whole way in a POV demo. The timeline is read
  without its estimates. A map with no HLTV demo gets its routes this way (de_dust: 964 routes from 17 matches).

A span of 2.5 s or more takes guides from the routes: real players of the same side that fit the known ends.

- Both ends known: a real player that went from the first place to the second in about the same time.
- Only the end known (a player from its spawn): a real player that came from its spawn to that place at about
  that time of the round, and that passes the next known places of the 8 s after it too. A later player waited
  longer before it left.
- Only the start known: a real player that was there at about that time, going the same way. The hidden player
  goes on as it did for 5 s and then stays.
- Nothing known: the whole round of a real player of the side, from a real round that its team follows already
  where one is free (the players with a known place get their ways first), only in a round with a kill. In a
  pause the player stays on its spawn.

A span with a known end asks for 48 such real players (40 whole rounds for a player with nothing known). First
the guides that the demo contradicts go (`leastFaults()`): a real player that was where the recorder would have
got it from the server, or that ran where the recorder would have heard its steps, did what the hidden player did
not do. The seconds of both faults are counted along each guide, and the guides with the fewest stay. On the
masked demos the truth has such a second in 1.4% of the spans, a candidate in 15% (heard) and 4% (seen). Then the
span takes the most typical ones first: the guide that lies nearest to the others (`typical()`, the mean distance
at 9 moments of the span, at most 1000 units a pair).
The best fit of the ends is one person's choice of that round; most players that fit the ends went another way.
The first 3 of that order give a way each (section 5); the cheapest stays. Near its guide the player looks where the real player
looked. Two hidden players of a round never follow the same route or take the same spawn. A teammate of a living
recorder with no radar row did not move: its span takes no guide. A player that starts on a sure spawn point
(section 6a) prefers the real players that started near that point (0.3 of the score for each unit, up to 600).

**Where a hidden player looks.** Along its way it looks where it goes, and near its guide where the real player
looked. A player that stands looks where the real players of its side look at that place (`lookAt()`: the mean
direction of the standing points of the routes in a cell of 96 units, from 6 points up). A known end keeps the
yaw that the demo holds.

A level with no routes still fills: the hidden players take the shortest ways between their known places.

## 6a. The spawn points (`spawns.js`)

The game gives the spawn points of a side out in turn (`EntSelectSpawnPoint` of the game: the next free point
after the one that it gave last). At a restart the players get their points in the order of their entities, so
the players of a side stand on points that follow each other in the level's list, and the next restart goes on
after the last of them. On 24 HLTV demos the players of a side stand in turn in 93% of the rounds
(1,700 checks); the rest are restarts where a point was not free. A POV demo of an online match of 2005 shows
the same on the recorder's own team, round after round.

So the point of the first player of a side at a restart is one number, and the restarts of a match are a chain
of such numbers. `spawnPlan()` finds the most likely chain for each side (forward and backward over the
restarts) from these clues:

- **A player on its point.** The recorder itself, or two players of a side that agree: the demo shows the state.
  A side that the demo shows at two restarts in a row also counts the restarts between them for the other side:
  none (the demo holds one restart as two round windows, because the clock of a round comes twice), one, or more
  (three restarts in a row before a match have no window each).
- **A logo sprayed in the freeze.** Nobody moves in the freeze, so the point is within 150 units of the logo.
- **The first known place of a hidden player** in the first 30 s of the round: the share of the real players from
  each point (the routes of section 6) that pass within 120 units of that place within 0.5 s of that time. The
  time is the strong part: a run from another point comes a moment sooner or later.
- **The step from one restart to the next:** the count of the players of the side that took points, with a point
  left out at 7% of the restarts and two at 2%. Between two parts of a joined match the count of the restarts is
  not known, but each one gave every player a new point: on a level with 20 points and 5 players 4 states are left.

Only a slot that takes a point counts: it has a name (the side of a player that left stays in the demo) and it
plays (a referee on a side does not spawn; section 4, the lives). A hidden player starts on its point when the
chosen state has a chance of 0.5 or more. It stands there through the freeze, on the point itself.

## 7. The measure

Two tools, two kinds of numbers.

- `tools/measure-fill.js` makes the POV timeline that one player of an HLTV timeline would have recorded
  (`mask.js`: the server's set for the players, the audible set for the sounds and the shots, the radar), fills
  it and compares the estimate with the true places. The match under measure, with its other demos, stays out of
  the routes. It also counts the faults that need no truth, on the estimates and on the real samples: a step
  faster than 320 units a second, a step faster than 700 (a jump of the place), a place in a wall, a place in the
  recorder's set, a leap where an estimate meets a real sample.
- `tools/check-fill-pair.js <pov.dem> <hltv.dem>` checks the fill on a match that exists as both. It lines the
  two up by each kill (a POV demo can stop and go on) and by the players that both show.
- `tools/audit-fill.js` counts the faults that need no truth on each filled POV timeline of `out/`, with a limit
  for each: jumps of the place, places in a wall (against the demo's own samples), places in the recorder's set,
  the share of the demo's players inside the computed set (the right build of the level), and a weapon that
  changes at the moment the demo shows the player again.

Results of 2026-11-18 (the measure and the pairs with fill version 3, the audit with version 4):

**The error against the truth.** 24 HLTV demos (6 each of de_dust2, de_inferno, de_nuke and de_train), two
recorders each, the match under measure out of the routes. A player's box is 32 units wide; a run is 250 units a
second.

| | Hidden time | Estimated | Median | p75 | p90 | Within 150 | Within 400 | Standing still: median, p90 |
|-|-------------|-----------|--------|-----|-----|------------|------------|------------------------------|
| Teammates | 23.6 h | 98.9% | 17 | 40 | 91 | 92.5% | 95.7% | 637, 1764 |
| Enemies | 74.7 h | 97.4% | 99 | 276 | 551 | 59.8% | 84.1% | 1522, 3133 |

"Standing still" leaves each hidden player where the demo last showed it. The enemies' median by map (the middle
of 12 runs): de_nuke 68, de_inferno 93, de_dust2 96, de_train 171.

The enemies' error by what the span had to go by:

| Span | Share of the hidden time | Median | p90 |
|------|--------------------------|--------|-----|
| A hint at one end or both, under 2 s | 13% | 11 | 50 |
| The straight line, under 2 s | 8% | 5 | 26 |
| A hint, 2 to 6 s | 7% | 39 | 124 |
| A hint, 6 to 15 s | 9% | 86 | 342 |
| A hint, 15 s and more | 13% | 244 | 930 |
| From a spawn to the first known place, 6 to 15 s | 10% | 134 | 330 |
| From a spawn to the first known place, 15 s and more | 28% | 215 | 692 |
| Nothing known in the whole round, 15 s and more | 2% | 352 | 1793 |
| After the last known place, 15 s and more | 1% | 630 | 1917 |

**The faults that need no truth**, on the same runs, against the same count on the real samples of the demos:

| Fault | Estimates | Real samples |
|-------|-----------|--------------|
| A step faster than 320 units a second | 0.11% of the steps | 0.22% |
| A step faster than 700 units a second (a jump of the place) | 0.001% (45 in 6 million) | 0.027% |
| A place where a standing player does not fit | 1.7% | 5.5% |
| A leap of more than 100 units where an estimate meets a real sample | 20 of 39,175 | - |
| A place in the recorder's set, 0.5 s and more from the ends of a span | 0.5% | - |

The real samples have their own faults: a fall, a ladder, a ducked player, a lagged packet. The set of the last
line is itself a model: on a real POV demo 1.6% of the players that the server did send lie outside it for a
moment.

**Real pairs.** Three matches that exist as a POV demo of one player and as an HLTV demo (`check-fill-pair.js`):

| Match | Mask and real demo agree | Teammates: median, p75, p90 | Enemies: median, p75, p90 | The mask of the same half: enemies |
|-------|--------------------------|-----------------------------|---------------------------|-------------------------------------|
| de_inferno, online, 2004 (one half) | 96.8% | 26, 49, 83 | 40, 157, 335 | 37, 136, 312 |
| de_dust2, LAN, 2006 | 90.6% | 13, 28, 51 | 36, 136, 317 | 36, 136, 319 |
| de_nuke, LAN, 2006 | 92.9% | 13, 33, 67 | 52, 174, 371 | 55, 181, 394 |

"Agree" is the share of the samples in which the real POV demo and the mask of the HLTV demo both show or both
hide a player. The fill of a real POV demo is as good as the fill of its mask, so the measure on masked HLTV
demos is a fair copy of real POV demos.

On 2026-11-19 (fill version 5) the check ran on 31 matches of one player's archive that also exist as an HLTV
demo: 63 runs of a POV part against an HLTV part with at least 60% of the POV kills in both, the HLTV match out
of the routes (`--without`: 38 of 41 such HLTV matches are in our routes). The mask and the real demo agree on
94.2% of the samples.

| | Hidden time | Estimated | Median | p75 | p90 | Within 150 | Within 400 | The mask: median, p90 |
|-|-------------|-----------|--------|-----|-----|------------|------------|------------------------|
| Teammates | 20.5 h | 98.9% | 22 | 45 | 91 | 93.7% | 97.0% | 18, 96 |
| Enemies | 60.5 h | 98.5% | 110 | 306 | 655 | 57.5% | 81.3% | 102, 657 |

The enemies' median by map: de_nuke 62, de_clan1_mill 86, de_dust2 96, de_inferno 104, de_aztec 133, de_cpl_mill
146, de_train 166, de_tuscan 174, de_prodigy 354 (few routes). Two kinds of span hold 73% of the enemies' error
(error times time) while the recorder lives: from a spawn to the first known place, over 8 s (34% of the
estimated time, median 202, 44% of the error), and a hint at one end, over 8 s (22%, median 196, 29%). A span
that ends with no known place after it (the round ends first) is short in time but far off (median 575 to 866).

**Version 6 (2026-11-19).** Three changes, each measured on the 24 HLTV demos (two recorders each) and then all
on the 63 runs of real pairs above:

- A restart by the admin while the recorder is dead (section 4, the windows).
- A span takes the most typical of 12 guides (section 6). With the perfect choice among 12 guides the enemies'
  median would be 52 units against 96 on 8 demos: the choice of the guide is where most of the error is.
- Routes from POV timelines (section 6): no gain on the maps with many HLTV routes, 2 to 3% on the weak ones, and
  the first routes of de_dust. On de_dust2 with no HLTV routes at all, the routes of 80 POV timelines give about
  70% of the gain of the routes of 152 HLTV timelines (enemies' p90: 601 with no routes, 494, 452).

| Enemies | Median | p75 | p90 | Within 150 | Within 400 |
|---------|--------|-----|-----|------------|------------|
| 24 HLTV demos, masked: version 5 | 99 | 276 | 551 | 59.8% | 84.1% |
| 24 HLTV demos, masked: version 6 | 93 | 240 | 487 | 62.8% | 86.6% |
| 63 runs of real pairs: version 5 | 110 | 306 | 655 | 57.5% | 81.3% |
| 63 runs of real pairs: version 6 | 99 | 271 | 602 | 60.2% | 83.3% |

The teammates and the faults that need no truth stay as they were (teammates on the real pairs: median 22, p90
91 to 90). The fill takes 11% longer. The enemies' median by map on the real pairs: de_nuke 57, de_clan1_mill
83, de_dust2 96, de_inferno 97, de_aztec 126, de_cpl_mill 129, de_tuscan 151, de_train 156, de_prodigy 329.

**The yaw** (8 HLTV demos, two recorders each; degrees between the estimate and the truth; a random yaw gives a
median of 90 and 17% within 30 degrees):

| | Median | p75 | p90 | Within 30 degrees |
|-|--------|-----|-----|-------------------|
| Enemies, before `lookAt()` | 28 | 72 | 124 | 52% |
| Enemies | 27 | 66 | 117 | 53% |
| Teammates, before `lookAt()` | 43 | 89 | 138 | 41% |
| Teammates | 29 | 67 | 114 | 51% |
| Teammates that stand, before `lookAt()` | 58 | 109 | 157 | 33% |
| Teammates that stand | 20 | 54 | 111 | 62% |

A moving enemy that looked along its true way would have a median of 27: the yaw of a moving estimate is at
that limit. A standing enemy at its true place would have 16 with `lookAt()`; its estimate has 30, because the
place is off. `tools/measure-fill.js` prints the yaw of each run since then.

**Version 7 (2026-11-20).** Three changes (sections 6 and 6a): a span drops the guides that the demo contradicts,
among 48; a spray logo is a hint; a hidden player starts on the spawn point that the game gave it.

| Enemies | Median | p75 | p90 | Within 150 | Within 400 |
|---------|--------|-----|-----|------------|------------|
| 24 HLTV demos, masked: version 6 | 93 | 240 | 487 | 62.8% | 86.6% |
| 24 HLTV demos, masked: version 7 | 29 | 136 | 403 | 76.6% | 89.9% |
| 63 runs of real pairs: version 6 | 99 | 271 | 602 | 60.2% | 83.3% |
| 63 runs of real pairs: version 7 | 48 | 205 | 549 | 69.9% | 85.6% |

The teammates stay as they were on the masked demos (median 17, p90 89 to 86), and so do the faults that need no
truth (42 to 39 jumps of the place, 0.6% to 0.5% in the recorder's set). The enemies' median by map: de_nuke 59 to
15, de_dust2 82 to 29, de_inferno 77 to 36, de_train 150 to 40. The yaw of an enemy is 21 degrees off in the
middle (27 before), because a player on its spawn point looks as the real players there do. The fill takes 3 to
13% longer (two measures under other loads of the machine).

The parts, on 8 HLTV demos with two recorders each, each half as a demo of its own (as the two files of a match):

| Enemies | Median | p75 | p90 |
|---------|--------|-----|-----|
| Version 6 | 96 | 239 | 514 |
| With the guides that the demo contradicts least, among 48 | 96 | 224 | 461 |
| With the spawn points and the sprays too (version 7) | 28 | 138 | 412 |
| With the true spawn point of every hidden player, and no spray | 25 | 128 | 412 |

The spawn point is the largest part: an enemy stands on it through the freeze of every round, and a POV demo
never shows it there. With the true point of every hidden player (the limit of section 6a) the enemies' median on
the 8 demos is 25 units. The plan finds the exact point of a hidden enemy in 88% of the cases on those demos
when each half is a demo of its own (as the two files of a match are), and in 94% where it is sure by 0.8 or more.

On real POV demos nothing shows the true point, but a logo sprayed in the freeze is a check when the plan does
not read the sprays: on 24 matches of the archive (859 rounds) the planned point is within reach of 96% of the
605 such logos (23% by chance).

On the real pairs the teammates stay as they were (median 22, p90 89), and 98.6% of the enemies' hidden time has
an estimate (98.5% before). The enemies' median by map: de_nuke 57 to 27, de_inferno 97 to 40, de_dust2 96 to 53,
de_train 156 to 54, de_clan1_mill 83 to 76, de_aztec 126 to 86, de_cpl_mill 129 to 97, de_tuscan 151 to 155,
de_prodigy 329 to 280. The gain is smaller than on the masked demos: the freeze of an online match is shorter
than the freeze of the matches that the HLTV demos hold. The span from a spawn to the first known place (a third
of the estimated time) has a median of 32 units now. The largest part of the error that is left (35%) is the
span of over 8 s with a hint at an end (median 162).

Tried and dropped, with the measure of each:

- A player that nothing shows again stays, or goes on for longer, by its side: staying lowers the median and
  going on lowers the p90, and no setting wins on both (the rule of 5 s stays).
- The sightings of the same player in the other rounds of the demo, at the same time of the round: the nearest
  of them is 500 to 700 units from the truth, the estimate 174. A demo sees an enemy where its recorder looks.
- The victim of a kill by the hidden player (the way must see the body): 190 of 4,265 long spans hold such a
  kill, and the choice of the guide does not get better.
- A guide of the same real round as the guides of the teammates: the best guide has no more such teammates than
  the others (0.12 against 0.11).
- The scoreboard as the name of the defuser: a step of 3 frags lies at 4 of 52 defuses.
- Among whole rounds for a player with nothing known, the routes that last the whole span first: no change.
- A guide whose real round has its team, or the other team, where the known players of the hidden round are (the
  layout of the round): the rank of that fit says nothing of the error of the guide (correlation 0.02 and 0.03;
  the "most typical" order has 0.47).
- A guide near the planted bomb at the time of the plant, and one whose real round had the same count of living
  players: no change.
- A guide that is in the sight of a living player of the other side for some seconds with no kill between them:
  the truth is so in 2.5% of the spans and a candidate in 5%; the gain is under 1%.
- A guide that stands, or moves, as the hidden player does at its known end: no change.
- 96 guides and not 48: 2% better on the log of the candidates, for twice the reading.
- A wider window of time in the spawn clue where the narrow one holds too few real players: no change.
- The bomb carrier as a hint. The demo names the carrier of both sides (`ScoreAttrib` goes to every client), so
  the player whose flag ends at a plant stood at the bomb for the 3 s of the plant, and the last living CT at a
  defuse stood there too. On 25 matches of the archive the planter is named at all 374 plants and is a hidden
  enemy at 70 of them: too few to move the measure (p90 412 to 410).
- A free spawn in place of the planned point where the way from that point is faster than a run: the median goes
  from 28 to 42. The plan is right more often than the walk graph is exact.
- The weight of the spawn point in the score of a guide (0, 0.3 and 1 for each unit) and the chance from which a
  planned point counts (0.3, 0.5): the same within 1%.

**The audit of an import.** `tools/audit-fill.js` on the 325 filled matches of one player's archive (2003 to
2011, online play): 176 million estimated steps hold 32 jumps of the
place (4 at most in one match). In a wall: 1.3% of the estimates in the middle match and 8.6% at most, against
6.3% of the demo's own samples in the middle match. The players of every demo lie in the set of its level (98.4%
in the middle match, 95.6% at least), so each match has the right build of its map. 3 weapon rows lie at the
moment the demo shows a player again, all in one gap of the packets during a buy time.

The places in the recorder's set are no fault on a real demo, and the audit sets no limit for them. A real demo
holds hints of a player inside the recorder's set while its packets do not hold the player (the cause is not
known; the demos name no missed delta). The fill trusts the hint: a span with such a hint at an end has no cost
for a seen place (section 5). The masked measure holds that fault, with the exact rules of the server.

The gate for "passes as real" is the fault table: an estimate must not be too fast, leap or stand in a wall
more often than the real samples of a demo do, and must not leap where it meets a real sample. Version 3 passes
those lines on the masked demos. The gate counts places: nobody measured the pitch or the legs (the yaw: see version 6). The last line has no real value to compare with (a real player is never in the set and not sent);
0.5% is under the 1.6% by which the model of the set itself misses the real demo. The error against the truth
is the target of the work on the fill, not a gate.

## 8. The import

`tools/import-demos.js` fills a POV timeline after the join of its parts and before the cut of the dead air (the
fill reads the real clock; the cut does not count an estimate as play). `--no-fill` leaves the estimates out.
`timeline.estimates` holds records with `t0` and `t1`, so a cut moves their times with the rest.

A map can have two builds with one name (CS 1.5 and CS 1.6). `fillLevelOf()` takes the one in which the players
of the demo lie in the recorder's set (`levelFit()`, about 0.98 on the right build): the net protocol does not
say it, a demo of 2003 with protocol 46 was played on the newer de_inferno. With no build over 0.95, and for a
level with no files, the timeline stays as it is ("no fill" in the log).

Two kinds of POV demo get no fill by rule (`noFillRule()` of the import, owner 2026-11-19), and the page plays
them as recorded (spec 05, section 2b):

- A demo of a map with too few routes for a good fill. The list holds de_prodigy (4 HLTV demos, 2 of bad quality).
- A recording of a spectator: its recorder has no side in the match. The fill runs on it, but the measure has no
  mask that follows several players, so nobody knows how good the result is.

A map can also have two names with one set of walls. The player has no files of de_clan1_mill, so a POV demo of
it takes the level of de_cpl_mill (`levelMapOf()`), and `levelFit()` judges that choice like any other (0.98 to
0.99 on four matches). Its routes are the routes of de_cpl_mill.

The roster of the index (`src/shared/roster.js`) skips the estimates: the teams, the score and the result of a
match come from the demo alone. With the estimates, 3 of 58 checked matches had another result or score.

A change of the fill needs `--rebuild` of the POV demos. The routes are built before an import
(`tools/build-fill-corpus.js --also <folders of POV timelines that are not live> --hltv-to .cache/fill/corpus-hltv`):
a new POV match adds its own routes only with the next build.

## 9. The library

`cs16-pov-hltv-fill` is the fill as a tool of its own: it needs a `.dem`, the `.bsp` of its map and Node.

- `tools/cs16-pov-hltv-fill-lib.js` is the entry: the timeline builder, the join, the fill, the routes, the mask,
  the pair check and the measure.
- `fillLevelFromBsp()` computes the hulls, the walk graph, the spawns and the visibility from the BSP alone. The
  result is the same as the level files of the player (the same code builds both). `levelIdOf()` names the shape
  of a level: a hash of its planes, nodes, clip nodes, leaves and models.
- `tools/cs16-pov-hltv-fill.js` is the command line: `fill` (one demo, or the parts of a match in their order),
  `routes`, `check`, `measure`, `maps`. `--maps <folder>` takes the `.bsp` of the demo's map from a folder.
- `routes` takes HLTV demos and POV demos (section 6). The routes that ship come from the HLTV timelines only
  (`.cache/fill/corpus-hltv`): a POV demo is one person's archive.
- **Routes on disk** (`tools/lib/fill-routes.js`): one file for each build of a map, `<map>.<level id>.routes`, in
  the small form of `shrinkRoutes()` (places on a grid of 4 units, yaws of 8 degrees, each value as its step from
  the point before in one byte, Brotli: a fifth of the size, the same result in the measure and on the real
  pairs). With every second point a file is half as large again, and the enemies' median error on the three real
  pairs rises by 1, 5 and 11 units: every point stays. The fill takes the file of the level from
  `--routes-dir`, then from the routes that ship. A map with no routes stops the fill with the two ways on
  (`routes`, or `--no-routes`). A `.bsp` that does not fit the demo (`levelFit()` under 0.95) stops it too.
- `tools/pack-fill-lib.js` packs the modules, the tests of the fill, `docs/cs16-pov-hltv-fill/README.md`, this
  spec and spec 02 as a package of its own. It ships the routes of each level with 10 HLTV timelines or more in
  the corpus of the player (the owner's decision of 2026-11-18): places and yaws of real players, with no name
  and no id of a match. The package holds no demo and no game file. The licence and the publish step are the
  owner's.

**The same result.** For one match of two halves, the standalone tool (level from the BSP, shipped routes) and
the code path of the import (level files, the same routes) give the same samples, spans, weapons and animations.
The import itself reads the full routes of its cache: 94.5% of its estimated samples are at the same place as
the standalone output and 97% within 50 units. The standalone tool does not cut the dead air and the tail of a
timeline; that is the player's own step after the fill.

## 10. Open

- **The thrower of a grenade.** A grenade in the recorder's set names its thrower (the `owner` of the entity).
  Its flight, read back along its arc to the floor, gives the place of a hidden thrower: median error 39 units,
  but only for a flight of 0.2 to 1 s before the set at a throw speed of 650 units a second or more (88% within
  100 units, about 9 such grenades in a match). `mask.js` hides no grenade yet, so the masked measure would
  read flights that a POV demo does not hold: the mask comes first.
- **The spawn point of a side that the demo never shows**, in a half with few early clues, stays open: the plan
  is under 0.5 there and the player starts on a free spawn as before.

- **An HLTV `.dem` file.** `src/dem` writes a filled copy of a POV demo (`fill --dem`): the packet entities of each
  frame again, with the estimated players, a new place for an event that names its entity by its place in the
  packet, and a notice in the console. The copy stays a POV demo, so the game shows it from the recorder's eyes.
  A demo with a free camera needs the HLTV messages and the spectator state too. Nobody has played a copy in the
  game yet.
- **The health** of a hidden player is not estimated.
- **A death with no body** (a demo before `ClCorpse` carried the place, a kill far from the recorder): the way
  ends where the guide ends, not where the killer aimed.
- **Jumps that the walk graph does not have** give a straight line or a way that is too fast (section 5).
- **Levels with no HLTV demos** have no routes: a hidden player with no hint waits on its spawn. The standalone
  tool stops there unless `--no-routes` is given.
- **The older live POV demos** were built before the fill: they need a rebuild from their archived files.
