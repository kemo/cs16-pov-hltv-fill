# 02 Timeline

Code: `src/timeline.js`, `src/world.js`, `tools/build.js`, `tools/split-timelines.js`. Tests:
`test/timeline.test.js`, `test/world.test.js`, `test/sounds.test.js`, `test/demos.test.js`,
`test/sample-parts.test.js`.

## 1. Purpose

`tools/build.js demos/*.dem` turns each demo into `out/<name>.json`, the only input of the player. A 21-minute
HLTV demo builds in under a second into about 3 MB of JSON (0.75 MB gzipped on the wire). The format has a
version (`TIMELINE_VERSION`, now 8); a change of a field raises it. The page reads the older versions too: a
timeline of 7 and before has coarser angles and no punch on its shots (section 3).

## 2. Clock

- `t` is seconds of the demo's playback section (frame type 1), rounded to 0.01. `duration` is the last `t` of a
  row plus 1 s (section 3b).
- Rows of the form `[t, entity, ...]` are sorted by `t`. The page searches them by time.
- A message (a kill, a sound, a round, a shot) is at the time of the frame that brought it. What the frame's
  entity state holds (`samples`, `anims`, `kits`, and the world's grenades, bodies and drops) is at the time of
  its snapshot: the server time (svc_time) plus the median of (frame time - server time) over the last 101
  frames (`src/snapshot-clock.js`). The proxy writes frames in bunches, so on the frame clock positions jump and
  then wait: on ripy-2, 2.1 % of the steps ran faster than 1000 units a second, and 0.18 % do on this clock.
  A snapshot whose server time is ahead of its frame by more than 0.1 s is a glitch and gets no row.

## 3. Fields

| Field | Shape | Source |
|-------|-------|--------|
| `version`, `source` | file, bytes, sha256, netProtocol, kind `hltv` or `pov`, clock, deltaMisses, cut (spec 01, section 2), builder | header, `svc_hltv` |
| `map`, `server` | strings | `svc_serverinfo` |
| `recorder` | entity of a POV recorder, null for HLTV | `svc_serverinfo` |
| `recorders` | `[t, entity]`: the recorder of each part of a joined POV timeline, from the part's start | `src/join.js` |
| `players` | `{entity, name}` | `svc_updateuserinfo` |
| `samples` | `[t, (entity, x, y, z, yaw x 10, flags) x n]`, one row per playback frame (version 8) | entity state |
| `sprays` | `[t, entity, x, y, z]`: a player's spray logo (version 7) | TE_PLAYERDECAL |
| `corpses` | `[t, entity, x, y, z, yaw, sequence, model, side]`: the body the client draws once a dead player's entity is gone (version 7). CS 1.5 sends no player: the body is the oldest open death of its side with its model | ClCorpse |
| `kills` | `{t, killer, victim, headshot, weapon, killerTeam, victimTeam, killerName, victimName}` | DeathMsg |
| `rounds` | `{t, kind: start, seconds}` and `{t, kind: end, reason, winner}` | RoundTime, TextMsg |
| `bombs` | `{t, kind: planted, defused, exploded}` | TextMsg, SendAudio |
| `scores` | `{t, team, score}` | TeamScore |
| `cues` | `[t, primary, secondary, flags]` | `svc_director` DRC_CMD_EVENT |
| `views` | `[t, x, y, yaw]` of a POV recorder | frame demo info |
| `eyes` | `[t, x, y, z]`: the point of the recorder's set, at each change (POV only) | `svc_clientdata`, `serverEye()` |
| `radar` | `[t, entity, x, y, z]` of a teammate (POV only) | Radar |
| `fires` | `[t, entity, x, y, z, yaw, pitch]` of a shot by a player outside the packet (POV only) | `svc_event` of a weapon |
| `estimates` | `{entity, t0, t1, kind}`: the spans of the fill (a filled POV timeline, spec 14) | `src/fill/fill.js` |
| `fill` | `{version, ways, guided, relaxed, straight, seen, lag}` (a filled POV timeline) | `src/fill/fill.js` |
| `chat` | `{t, entity, team, name, text, dead, spectator, teamOnly}` | SayText |
| `board` | `[t, entity, frags, deaths]` | ScoreInfo |
| `pings` | `[t, entity, ms]`, at most one per player in 5 s | `svc_pings` |
| `sides` | `[t, entity, T or CT or null]` | TeamInfo, ScoreInfo |
| `names` | `[t, entity, name or null]`; null is a disconnect | `svc_updateuserinfo` |
| `attribs` | `[t, entity, flags]`: 1 dead, 2 bomb | ScoreAttrib |
| `loadouts` | `[t, entity, weapon key]` | `weaponmodel` of the entity state |
| `purchases` | `{t, entity, item, kind: buy or pickup, price, x, y}` | `world.js` (section 5) |
| `decals` | `[t, x, y, z, index]`: TE_WORLDDECAL and TE_DECAL (+256 for the HIGH ones); blood and scorch | `timeline.js` |
| `kits` | `[t, entity, 1 or 0]`: the defuse kit on a CT's model (body 1) | `timeline.js` |
| `grenades` | `{kind: he, flash or smoke, owner, t0, burst, t1, x, y, z, path: [[t, x, y, z]]}` | `world.js` |
| `bombSpots` | `{kind: planted or dropped, t0, t1, x, y, z}` | `w_c4`, `w_backpack` entities |
| `ground` | `{item, t0, t1, x, y}` | `w_*` weapon entities |
| `skins` | `[t, entity, model name]` | `\model\` of userinfo |
| `anims` | `[t, entity, sequence, gaitsequence]` | entity state |
| `soundNames`, `sounds` | names; `[t, name index, entity, x, y, z, volume, attenuation x 100]` | `svc_sound` |
| `shots` | `[t, entity, weapon, bparam1, punch x, punch y, spread x, spread y]` (version 8) | `svc_event` of `events/<weapon>.sc` |
| `radio` | `[t, sender, code]` such as `%!MRAD_BOMBPL` | SendAudio |
| `effects` | `[t, kind, x, y, z, sprite, a, b]` | `svc_temp_entity`, `createsmoke` events |

**The POV recorder's own row.** The game leaves the local player's origin out of the packet entities
(`Player_Encode`), so that entity stays at its baseline. The row of the recorder takes the origin of
`svc_clientdata` instead (`withOwnOrigin()`). An observer (`iuser1` not 0) has the origin of the player that it
watches in its clientdata: its row stays as it is. The two local POV demos (vs69, vs69-2) are such observers, with
no side, so they have no row of the recorder.

**Sample flags (version 8):** bit 0 dead, bit 1 bomb carrier, bit 2 CT, bit 3 ducking (`usehull` 1), and from
bit 4 eleven bits of the view pitch in tenths of a degree + 900 (down positive). Version 7 and before held the
yaw in whole degrees, the pitch in eight bits from bit 3 and ducking at bit 11; `stateAt()` of
`src/shared/director.js` reads both, and a page with a timeline before 7 takes the ducking from the legs'
sequence. Whole degrees were worth a median of 0.38 degrees of error a frame, which the first-person camera
wobbles by; the entity's own angle comes in 16 bits of a turn, so tenths lose nothing of it. The entity state
keeps a third of the view pitch, negated; `viewPitch()` restores it, in tenths.
Bit 15 marks an estimate of the fill (`ESTIMATE`, spec 14): a sample that the demo does not hold. Its pitch is
level.

**One row per playback frame (version 8).** An HLTV demo sends 10 to 30 frames a second and each one is a
position the demo really holds; a sampling period of its own threw every second frame of a 29 Hz demo away.
Two frames inside one hundredth of a second fall on one row, which is as fine as the clock gets. It is the
greater part of a timeline's bytes: 3807-de-inferno (104 minutes, 29 frames a second) goes from 77,614 samples
and 2.98 MB of Brotli to 148,106 and 5.47 MB, while the two demos that already sent 10 and 17 frames a second
grow by a fifth (1.22 to 1.44 MB, 2.47 to 2.95 MB), mostly from the finer angles and the shots' punch.

**Stale samples.** Code: `src/shared/stale-samples.js`. Test: `test/stale-samples.test.js`. On some demos the
server did not run a player for a snapshot: the row repeats that player's place and angles exactly, and the next
row carries the late step. The player alternates a stop and a double step, and the picture stutters. On rtvspit-1,
12.9 % of the steps of a running player stall (77 % for the worst two players). On inferno1, 0 % do. The page moves
these samples when they load, onto the line between the samples around them by time, so the timelines stay as
they are. A run of 1 to 3 repeats counts as stale only under these conditions:

- The player moves at 40 units a second or more before the run.
- The step after the run is 150 units a second or more. A player who stood cannot reach this in one snapshot.
- The step into each repeat is at most 0.2 s.
- The way across the run is at most 600 units a second.

A filled sample is therefore a place on the way, and not a place that the demo holds.

Only the TV page fills. The play page and the tools keep the raw rows, because `tools/replay-play.js` replays a
played match from them, and the bots on the rails must read the same places.

**A shot's row.** Its time includes the event's own delay inside its packet. `bparam1` is the silencer of the
M4A1; on the USP, the Deagle and the Glock the engine writes the empty-clip flag in that same place, so only
the M4A1's counts (`silencedOf()` of `src/shared/shots.js`). The punch angle is what the engine fired that shot
along, before the shot's own kick, in hundredths of a degree the engine's way (x down, y right), and the spread
is the shot's own draw along the right and the up of that aim (`FireBullets3`), in hundredths. The punch is
`null` where the weapon's event carries none: the AWP and the shotguns pass zeros, the FAMAS and the Galil a
sentinel, and a weapon writing a plausible punch on fewer than a fifth of its shots keeps none at all
(`withPunchKept()`). Shots the demo lost come back on the page, not in the file (`src/shared/shots.js`).

**Effects kinds:** `explosion` (a scale, b frame rate; TE_EXPLOSION), `smoke` (scale, frame rate; TE_SMOKE),
`sprite` (scale, brightness; TE_SPRITE), `sparks` (TE_SPARKS: a grenade's own sparks, not a bullet's: 96 to
99% of them lie within 400 units and 2 s of a burst, and a bullet's spark is the client's own work), `puff` (one second of a smoke grenade:
sprite field `first` on the first one, a and b the client's random drift). Temp entity coordinates are shorts
of 1/8 unit.

## 3a. Parts

Code: `src/shared/sample-parts.js`, `src/timelines-store.js` (`writeParts()`), `tools/split-timelines.js`,
`web/sample-loader.js`. Test: `test/sample-parts.test.js`.

`samples` is about 80 % of a timeline: 34 of the 42 MB of the largest match (91 minutes, 8.5 MB of Brotli).
The page must not wait for all of it, so `tools/split-timelines.js` writes the split of each timeline:

- `out/<id>/samples-<n>.json.br`: the rows with `floor(t / 120) = n`. The parts of a run join without a gap or
  an overlap; a part with no rows stays, as an empty list. About 85 KB of Brotli each.
- `out/<id>/head.json.br`: every field but `samples`, and `parts: {seconds, files}`. `files[n]` is the address
  of part n relative to the head's own address (`<id>/samples-<n>.json`; the static build gives hashed names).
  The head of the largest match is 1.8 MB.
- `out/<id>.json.br` stays the source of every tool. A split older than its timeline is stale: the server sends
  the whole timeline until the next split (`partsFile()`).

The page (`load()` of `web/tv.js`) waits only for the head and the part of its first second. The other parts
load behind it, two at a time, and they do not show on the loader: the next part, the one before (the bodies,
the bullet holes and the replay of a round read seconds back), then forward to the end, then back to the start. A seek starts that order again from the new second. `timeline.samples` holds every part that is
in, in order, and `timeline.samplesSpans` the seconds that they hold. `stateAt()` gives no position at a second
outside the spans, so nothing glides across a part that is not in. When the part of the second shown is not
in, the loader shows and that part loads first. Once every part is in, `samplesSpans` goes, and the timeline is
as one that came whole.

The plans that read the samples (the director's shots, the health, the defuses, the blood and the bullet
holes) are made again as parts come in, at most every 5 s and once when the last part is in: they take about
0.2 s for the largest match on a laptop. A map without a built floor (`out/maps/<map>.json`) draws its floor
from all the samples, so its demos wait for every part. A head without `parts` plays as before.

A channel loads the head and the first part of its next demo in the last 60 s of a demo, into the browser's
cache.

**The builder stamp.** `source.builder` is a short hash of the source of `src/timeline.js`, `src/dead-air.js`,
`src/join.js` and every module that they import (`builderStamp()` of `tools/lib/demos.js`). The tools compute it
at build time and pass it in; the browser never does. A timeline with another stamp, or with none (all 559
built before 2026-11-16), was built by older code: compare the stamp to find the timelines that a fix needs to
rebuild. The Warcraft III timelines carry `builder` of `src/w3g/timeline.js` the same way. A cut of built
timelines (`tools/cut-dead-air.js`) keeps the stamp that they have. `TIMELINE_VERSION` stays 8: the page reads
none of these fields.

## 3b. Dead air and the tail

Code: `src/dead-air.js`, `tools/import-demos.js`, `tools/cut-dead-air.js`. Test: `test/dead-air.test.js`.

- `duration` is the time of the last row plus 1 s (`MARGIN`), not the last frame: a proxy can write frames with
  no data for minutes after a server hung.
- The import cuts the tail (`cutTail()`): the timeline ends `TAIL` (15) seconds after the end of the play. The
  play ends with the round of the last kill, bomb or fight (a shot while 4 players fire within 30 s), or with
  such a time in the 5 s after that round's end. An idle round has a winner too (`Target_Saved`), so a won round
  alone is no play, and nor is one player who shoots at a wall after the match. Without a kill, or when the demo stops
  inside the round of its last kill, only the rows after the last row plus `MARGIN` go.
- Then the dead air (`cutDeadAir()`): a still world of more than 30 s between two times of play plays as 2 s. The
  squeeze keeps one row of `samples` and `views` for each time.
- `cuts` holds `[t, seconds removed]` for each cut, the tail too; `movedTime()` moves a time of the old clock
  onto the new one. `tools/cut-dead-air.js --to <folder>` runs both cuts over built timelines into another
  folder; its `--report` gives only the cuts of that run, on the clock that the timelines had before it.

## 4. Rules on archived text

- Every nickname and chat line goes through `maskText()`: an e-mail address becomes `[e-mail]`.
- A password typed into the chat (`rcon_password`, `sv_password`, `password` with a value) becomes `***`. An
  empty value (`""`) stays.
- The demos are never committed (`.gitignore`): they are other people's matches.

## 5. The world tracker (`world.js`)

- **Weapon in hand:** the `p_` model of `weaponmodel`, through `weaponKey()` (`p_mp5navy` is `mp5`).
- **Buy or pickup:** a weapon that shows in a hand for the first time since a spawn. A spawn is the first sight
  of a living player after death, or a jump of more than 300 units between samples.
  - A buy: within 45 s of the spawn and within 900 units of the spawn point. The price is the CS 1.5 price
    (`src/shared/weapons.js`).
  - A grenade counts only in the freeze time (before the round's RoundTime, or within 3 s of it): one drawn
    later was bought earlier.
  - The first sight of a player buys nothing: the recording does not know what they had.
  - Knife, Glock, USP and C4 are free and never a buy.
- **Thrown grenades:** a `w_hegrenade`, `w_flashbang` or `w_smokegrenade` entity with movetype 10 (bounce).
  The path keeps every sample where it moved more than 2 units. An HE or a flash goes off as it vanishes; a
  smoke starts when it stops moving and lasts until it vanishes. The page sets these right at load by the demo's
  own sounds (`src/shared/grenades.js`, `withFixedGrenades()`): an HE and a flash go off at their sound
  (`weapons/debris*`, `weapons/flashbang-*`, a sample sooner); a smoke goes off on its fuse at `sg_explode`
  (about 1.8 s after the throw, still rolling: median 150-200 units before where it rests), `from` where it was
  then, and it smokes 21.1 s and no further than the next round's start (one smoke's entity outlived its
  smoke by 943 s). The 21.1 s are the server's (SG_Smoke: 21 createsmoke events a second apart from 0.1 s after
  the burst, then the grenade goes; the demos show 21 events over 20 s). The cloud lives longer in the client:
  spec 06. A path that leaps 400 units is two throws of one entity slot. Out of a POV recorder's sight a
  grenade vanishes without going off there: with no sound of its own it is `lost` (no explosion, blinds
  nobody), and a bang with no grenade comes in ownerless with a one-point path. Matched to their sounds on the
  HLTV demos: 97-100% of the smokes, all but 0-4 of the HEs and flashbangs.
- **The bomb:** `w_c4` on the ground is planted, `w_backpack` is dropped.

## 6. Sides and names over time

Sides come from TeamInfo; ScoreInfo fills the side of a player whose TeamInfo came before the recording. A
slot's name comes from userinfo; a userinfo without a name is a disconnect. The scoreboard reads both at the
second shown, so a reconnect or a team switch shows correctly.
