import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESTIMATE, withoutEstimates } from '../src/shared/estimates.js';

test('a timeline without its estimates holds the samples of the demo only', () => {
  const real = [1, 10, 20, 30, 900, 4];
  const estimate = [2, 50, 60, 70, 0, ESTIMATE | (900 << 4)];
  const tl = { fill: { version: 1 }, estimates: [{ entity: 2, t0: 0, t1: 1, kind: 'hint' }], samples: [[0, ...real, ...estimate], [0.1, ...real], [0.2, ...estimate, ...real]] };
  const out = withoutEstimates(tl);
  assert.deepEqual(out.samples, [[0, ...real], [0.1, ...real], [0.2, ...real]]);
  assert.equal(out.fill, undefined);
  assert.equal(out.estimates, undefined);
});

test('a timeline that was never filled comes back untouched', () => {
  const tl = { samples: [[0, 1, 10, 20, 30, 900, ESTIMATE]] };
  assert.equal(withoutEstimates(tl), tl);
  assert.equal(tl.samples[0].length, 7);
});
