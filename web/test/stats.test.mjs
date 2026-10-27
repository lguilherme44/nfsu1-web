// web/tools/stats.mjs, the percentiles bench.mjs reports.
//   node --test web/test/stats.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pct, dist } from '../tools/stats.mjs';

test('median of an even count is the mean of the two middle values', () => {
  assert.equal(pct([83.49, 79.71], 0.5), (83.49 + 79.71) / 2);   // the perf review's 2-run "median" was 83.49, the maximum
  assert.equal(pct([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(pct([5, 1, 3], 0.5), 3);
  assert.equal(pct([7], 0.5), 7);
  assert.ok(Number.isNaN(pct([], 0.5)));
});

test('other quantiles interpolate between ranks; the input is not reordered', () => {
  const a = [10, 0, 30, 20, 40];
  assert.equal(pct(a, 0), 0);
  assert.equal(pct(a, 1), 40);
  assert.equal(pct(a, 0.95), 38);
  assert.equal(pct(a, 0.25), 10);
  assert.deepEqual(a, [10, 0, 30, 20, 40]);
  const d = dist([1, 2, 3, 4]);
  assert.deepEqual([d.n, d.mean, d.p50, d.max], [4, 2.5, 2.5, 4]);
  assert.deepEqual(dist([]), { n: 0 });
});
