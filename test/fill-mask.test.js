import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskAsPov, placeAt } from '../src/fill/mask.js';
import { readVis } from '../src/fill/vis.js';
import { twoRoomBsp } from './fill-world.js';

const CT = 4;
const DEAD = 1;
const sample = (entity, x, y, flags = 0) => [entity, x, y, 0, 900, flags];
const has = (row, entity) => {
  for (let i = 1; i < row.length; i += 6) if (row[i] === entity) return true;
  return false;
};

/** An HLTV timeline of 4 s: 1 and 2 are CT in the room of x under 144, 3 is a T that walks from the other room into it. */
function hltv({ recorderDies = false } = {}) {
  const samples = [];
  for (let k = 0; k <= 40; k++) {
    const t = k / 10;
    samples.push([t, ...sample(1, 0, 0, CT | (recorderDies && t >= 2 ? DEAD : 0)), ...sample(2, 100 - k * 5, 64, CT), ...sample(3, 400 - k * 10, 0)]);
  }
  return {
    version: 8, source: { kind: 'hltv' }, map: 'test', duration: 4, recorder: null, samples,
    sides: [[0, 1, 'CT'], [0, 2, 'CT'], [0, 3, 'T']],
    soundNames: ['player/pl_step1.wav', 'ambience/wind.wav'],
    sounds: [[1, 0, 3, 390, 0, 0, 255, 80, 4], [1, 1, 0, 390, 0, 0, 255, 80, 0], [3.5, 0, 3, 50, 0, 0, 255, 80, 4]],
    shots: [[1, 3, 'ak47', 0, null, null, 0, 0], [3.5, 3, 'ak47', 0, null, null, 0, 0]],
  };
}

test('the mask hides a player in a room that the recorder does not see', () => {
  const tl = hltv();
  const pov = maskAsPov(tl, 1, readVis(twoRoomBsp(144, false)));
  assert.equal(pov.source.kind, 'pov');
  assert.equal(pov.recorder, 1);
  // Player 3 is at 400 - 100 t: its box reaches the recorder's room at x 160.
  for (const row of pov.samples) assert.equal(has(row, 3), 400 - row[0] * 100 <= 160, `at ${row[0]}`);
  assert.ok(pov.samples.every((row) => has(row, 1) && has(row, 2)));
  assert.equal(tl.samples[0].length, 19, 'the input keeps its rows');
});

test('the eye of the mask is the recorder, then the teammate that a dead recorder watches', () => {
  const vis = readVis(twoRoomBsp(144, false));
  assert.deepEqual(maskAsPov(hltv(), 1, vis).eyes, [[0, 0, 0, 17]]);
  const eyes = maskAsPov(hltv({ recorderDies: true }), 1, vis).eyes;
  assert.deepEqual(eyes[0], [0, 0, 0, 17]);
  assert.deepEqual(eyes[1], [2, 0, 64, 17], 'player 2 at the death');
});

test('the radar gives a teammate that moved, once a second, to a living recorder', () => {
  const vis = readVis(twoRoomBsp(144, false));
  // Player 2 moves 50 units a second: under the 64 units of a check, so no radar.
  assert.deepEqual(maskAsPov(hltv(), 1, vis).radar, []);
  const fast = hltv();
  for (const row of fast.samples) row[8] = 100 - row[0] * 100;
  assert.deepEqual(maskAsPov(fast, 1, vis).radar.map((r) => r.slice(0, 3)), [[1, 2, 0], [2, 2, -100], [3, 2, -200], [4, 2, -300]]);
});

test('the sounds and the shots of a hidden player stay only where the recorder hears them', () => {
  const shut = maskAsPov(hltv(), 1, readVis(twoRoomBsp(144, false)));
  assert.deepEqual(shut.sounds.map((s) => s[0]), [1, 3.5], 'the wind stays, the far step goes');
  assert.deepEqual(shut.sounds[0][1], 1);
  assert.deepEqual(shut.shots.map((s) => s[0]), [3.5]);
  assert.deepEqual(shut.fires, []);
  // The far room sees the recorder's room, not the other way round: the player stays hidden, and its step and
  // its shot come through, the shot with its place.
  const far = hltv();
  for (const row of far.samples) row[14] = 5000;
  const vis = readVis(twoRoomBsp(144, false));
  const heard = maskAsPov(far, 1, { ...vis, pvs: new Map([[2, new Uint8Array([2])], [1, new Uint8Array([3])]]) });
  assert.equal(heard.sounds.length, 3);
  assert.deepEqual(heard.fires.map((f) => f.slice(0, 5)), [[1, 3, 5000, 0, 0], [3.5, 3, 5000, 0, 0]]);
});

test('the place of a player comes from the row nearest a time', () => {
  assert.deepEqual(placeAt(hltv(), 3, 1.04), [300, 0, 0, 900]);
  assert.equal(placeAt(hltv(), 9, 1), null);
});
