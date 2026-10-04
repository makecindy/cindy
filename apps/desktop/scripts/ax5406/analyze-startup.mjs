// Analyze only the fixture renderer's main thread before its first contentful paint.
// Buckets are disjoint wall-time intervals, not additive inclusive trace durations.
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('Expected trace run directory');
const { traceEvents: events } = JSON.parse(await fs.readFile(path.join(root, 'startup-trace.json'), 'utf8'));
const nav = events.find(e => e.name === 'navigationStart' && e.args?.data?.documentLoaderURL?.includes('component.html'));
if (!nav) throw new Error('Fixture navigation missing');
const paint = events.find(e => e.name === 'firstContentfulPaint' && e.pid === nav.pid &&
  e.args?.data?.navigationId === nav.args.data.navigationId);
if (!paint) throw new Error('Matching first contentful paint missing');
const main = events.filter(e => e.pid === nav.pid && e.tid === nav.tid && e.ph === 'X' &&
  e.ts < paint.ts && e.ts + e.dur > nav.ts);
function category(e) {
  if (['MinorGC', 'MajorGC'].includes(e.name)) return 'gc';
  if (['Layout', 'UpdateLayoutTree', 'ParseAuthorStyleSheet'].includes(e.name)) return 'style-layout';
  if (['PrePaint', 'Paint', 'Layerize', 'Commit'].includes(e.name)) return 'paint';
  if (['FunctionCall', 'EvaluateScript', 'v8.evaluateModule', 'v8.compile', 'v8.compileModule',
    'RunMicrotasks', 'FireAnimationFrame', 'TimerFire'].includes(e.name)) return 'js';
  if (e.name === 'RunTask') return 'other-main';
  return null;
}
const priority = ['gc', 'style-layout', 'paint', 'js', 'other-main'];
const tagged = main.map(e => ({ start: Math.max(e.ts, nav.ts), end: Math.min(e.ts + e.dur, paint.ts),
  category: category(e) })).filter(e => e.category);
const points = [...new Set([nav.ts, paint.ts, ...tagged.flatMap(e => [e.start, e.end])])].sort((a, b) => a - b);
const buckets = {};
for (let i = 0; i < points.length - 1; i++) {
  const start = points[i], end = points[i + 1];
  const active = new Set(tagged.filter(e => e.start <= start && e.end >= end).map(e => e.category));
  const key = priority.find(c => active.has(c)) || 'outside-main-tasks';
  buckets[key] = (buckets[key] || 0) + (end - start) / 1000;
}
const result = { trace: path.join(root, 'startup-trace.json'), firstContentfulPaintMs: (paint.ts - nav.ts) / 1000,
  bucketsMs: buckets,
  // Inclusive hotspots explain causality; they overlap the buckets and must NOT be added to them.
  inclusiveHotspots: main.filter(e => ['FunctionCall', 'Layout', 'UpdateLayoutTree', 'v8.evaluateModule'].includes(e.name))
    .sort((a, b) => b.dur - a.dur).slice(0, 12).map(e => ({ name: e.name, startMs: (e.ts - nav.ts) / 1000,
      durationMs: e.dur / 1000, args: e.args })),
  caveats: ['Tracing adds overhead; not a decomposition of earlier untraced median.',
    'Outside-main-tasks includes loading, background work and scheduling; it is not all disk or font I/O.',
    'Paint bucket covers renderer main thread only, not all GPU/raster CPU time.'] };
await fs.writeFile(path.join(root, 'startup-analysis.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ root, firstContentfulPaintMs: result.firstContentfulPaintMs, bucketsMs: buckets }));
