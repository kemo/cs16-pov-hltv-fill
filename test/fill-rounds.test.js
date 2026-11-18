import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsOf } from '../src/fill/rounds.js';

const rows = (place) => Array.from({ length: 601 }, (_, k) => [k / 10, 1, ...place(k / 10), 0, 0, 0]);
const still = { samples: rows(() => [0, 0]), duration: 60 };
const start = (t, seconds) => ({ t, kind: 'start', seconds });
const end = (t) => ({ t, kind: 'end', winner: 'T' });

test('a round is a window from its restart, and goes live at its second clock', () => {
  const tl = { ...still, rounds: [start(5, 6), start(11, 120), end(40), start(45, 6), start(51, 120)] };
  assert.deepEqual(windowsOf(tl), [
    { t0: 0, t1: 5, round: false, goAt: 0 },
    { t0: 5, t1: 45, round: true, goAt: 11 },
    { t0: 45, t1: 60, round: true, goAt: 51 },
  ]);
});

test('a clock inside a round is no restart: a POV demo gets the time again when its recorder watches another player', () => {
  const tl = { ...still, rounds: [start(5, 6), start(11, 120), start(30, 101), start(33, 98), end(40), start(45, 6), start(51, 120)] };
  assert.deepEqual(windowsOf(tl).map((w) => w.t0), [0, 5, 45]);
});

test('a clock with no round end before it is a restart where a seen player leaps', () => {
  // The admin starts the match again at 30 s: the player goes from one end of the map to its spawn.
  const tl = { samples: rows((t) => (t < 30 ? [3000, 0] : [0, 0])), duration: 60, rounds: [start(5, 6), start(11, 120), start(30, 6), start(36, 120)] };
  assert.deepEqual(windowsOf(tl).map((w) => [w.t0, w.goAt]), [[0, 0], [5, 11], [30, 36]]);
});

test('without the second clock a round goes live when the first seen player leaves its place', () => {
  const tl = { samples: rows((t) => [Math.max(0, t - 8) * 100, 0]), duration: 60, rounds: [start(5, 120)] };
  assert.equal(windowsOf(tl)[1].goAt, 8.3);
});
