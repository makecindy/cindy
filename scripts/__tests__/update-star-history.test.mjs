import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observe, renderChart, curve } from '../update-star-history.mjs';

// New README automation: no existing star-history coverage. Unit tier, no I/O.
// Minimal risks: an unstar, a same-day rerun, a corrupt API count, and a turn in
// the curve. These exercise the generator's public inputs and rendered outputs.
const seed = { repository: 'makecindy/cindy', reconstructedThrough: '2026-10-24', points: [['2026-10-24', 100], ['2026-10-25', 120]] };

test('daily observations preserve prior days and actual decreases; same-day reruns replace only today', () => {
  const next = observe(observe(seed, '2026-10-26', 130), '2026-10-26', 115);
  assert.deepEqual(next.points, [...seed.points, ['2026-10-26', 115]]);
  assert.equal(seed.points.length, 2);
  assert.match(renderChart(next), /Cindy · 115 GitHub stars/);
});

test('invalid API counts and stale dates fail without changing history', () => {
  for (const [day, count] of [['2026-10-26', null], ['2026-10-26', -1], ['2026-10-24', 140], ['2026-02-30', 140]]) {
    assert.throws(() => observe(seed, day, count));
  }
  assert.deepEqual(seed.points, [['2026-10-24', 100], ['2026-10-25', 120]]);
});

test('rounded segments stay between observations across rises, plateaus and declines', () => {
  const points = [[0, 0], [1, 4], [2, 4], [3, 1], [4, 8]];
  const segments = curve(points).split(' C').slice(1);
  segments.forEach((segment, i) => {
    const [a, b, c] = segment.split(' ').map(pair => pair.split(',').map(Number));
    const y0 = points[i][1], y1 = points[i + 1][1];
    for (let j = 0; j <= 20; j++) {
      const t = j / 20, u = 1 - t;
      const value = u ** 3 * y0 + 3 * u ** 2 * t * a[1] + 3 * u * t ** 2 * b[1] + t ** 3 * c[1];
      assert.ok(value >= Math.min(y0, y1) - 0.001 && value <= Math.max(y0, y1) + 0.001);
    }
  });
});

test('single zero observation renders finite accessible SVG in all four layouts', () => {
  const history = { ...seed, points: [['2026-10-24', 0]] };
  for (const dark of [false, true]) for (const mobile of [false, true]) {
    const svg = renderChart(history, { dark, mobile });
    assert.doesNotMatch(svg, /NaN|Infinity/);
    assert.match(svg, /Cindy · 0 GitHub stars/);
    assert.match(svg, /Zero-based linear axes/);
  }
});
