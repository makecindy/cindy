/** Synthetic before/after comparison of history projection; no app/profile access.
 * Run at repo root: node apps/desktop/scripts/benchmark-history-projection.mjs [baseline-ref]
 * Timing belongs here rather than in unit tests. Report medians, not pass/fail thresholds.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(repo, 'package.json'));
const { build } = require('esbuild');
const baseline = process.argv[2] ?? 'HEAD';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-read-paths-'));
const files = ['packages/maker-shared/src/historyViewProjection.ts'];

async function bundle(label) {
  const outfile = path.join(temporary, `${label}.cjs`);
  await build({
    stdin: { contents: files.map((file) => `export * from './${file}';`).join('\n'), resolveDir: repo, loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: label === 'before' ? [{ name: 'baseline', setup(builder) {
      builder.onLoad({ filter: /historyViewProjection\.ts$/ }, ({ path: filename }) => ({
        contents: execFileSync('git', ['show', `${baseline}:${path.relative(repo, filename).split(path.sep).join('/')}`],
          { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }),
        resolveDir: path.dirname(filename), loader: 'ts',
      }));
    } }] : [],
  });
  return require(outfile);
}

async function compare(name, before, after) {
  assert.deepEqual(await before(), await after(), `${name}: output differs`);
  // Alternate order to reduce warmup/order effects. These are diagnostic timings.
  const samples = { before: [], after: [] };
  for (let round = 0; round < 9; round++) {
    for (const label of round % 2 ? ['after', 'before'] : ['before', 'after']) {
      const start = performance.now();
      await (label === 'before' ? before() : after());
      samples[label].push(performance.now() - start);
    }
  }
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log(JSON.stringify({ name, beforeMs: median(samples.before), afterMs: median(samples.after), equal: true }));
}

try {
  const modules = { before: await bundle('before'), after: await bundle('after') };
  const rows = [{ id: 'user', clientId: 'user', role: 'user', content: 'Work', createdAt: '2026-01-01T00:00:00Z' }];
  for (let index = 0; index < 500; index++) {
    const id = `tool-${index}`;
    const common = { createdAt: '2026-01-01T00:00:01Z', historyContentStamp: `fixture-${index}` };
    rows.push({ ...common, id, clientId: id, role: 'tool_use',
      content: { toolName: 'mcp__cindy__ghost_call', toolUseId: id, input: { command: 'inspect' } } });
    rows.push({ ...common, id: `${id}-result`, clientId: `${id}-result`, role: 'tool_result',
      toolUseId: id, content: 'ordinary output '.repeat(1024) });
  }
  rows.push({ id: 'answer', clientId: 'answer', role: 'assistant', content: 'Done.',
    createdAt: '2026-01-01T00:00:02Z', agentMeta: { turnCompleted: true } });
  for (const lazy of [false, true]) {
    await compare(`history-1002-rows-lazy-${lazy}`,
      () => modules.before.projectHistoryView(rows, false, lazy),
      () => modules.after.projectHistoryView(rows, false, lazy));
  }
  await compare('history-small-plain',
    () => modules.before.projectHistoryView([rows[0], rows.at(-1)], false, true),
    () => modules.after.projectHistoryView([rows[0], rows.at(-1)], false, true));

} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
