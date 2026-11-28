/** Run from repo root: node apps/desktop/scripts/benchmark-path-search.mjs <baseline-ref>
 * Actual production modules, real temporary files, separate processes per case.
 * Includes misses and partial hits; no app/profile access or strict timing gate.
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
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const cases = { full: ['foo.ts', 'bar.ts'], miss: ['missing.ts'], partial: ['foo.ts', 'missing.ts'] };

if (process.argv[2] === 'worker') {
  const { bfsFindManyBySuffix } = require(process.argv[3]);
  const name = process.argv[4];
  const root = process.argv[5];
  for (let n = 0; n < 5; n++) await bfsFindManyBySuffix(root, cases[name]);
  const samples = [];
  let answer;
  for (let n = 0; n < 15; n++) {
    const start = performance.now();
    answer = await bfsFindManyBySuffix(root, cases[name]);
    samples.push(performance.now() - start);
  }
  console.log(JSON.stringify({ ms: median(samples),
    answer: [...answer].map(([href, files]) => [href, files.map((file) => path.relative(root, file))]) }));
} else {
  const baseline = process.argv[2] ?? 'HEAD';
  const { build } = require('esbuild');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-path-search-'));
  const root = path.join(temporary, 'workspace');
  const source = path.join(repo, 'apps/desktop/src/main/pathResolver.ts');
  try {
    for (let n = 0; n < 10; n++) {
      const directory = path.join(root, `package-${n}`);
      fs.mkdirSync(directory, { recursive: true });
      for (const file of ['foo.ts', 'bar.ts']) fs.writeFileSync(path.join(directory, file), '');
      if (n === 9) {
        for (let index = 0; index < 5000; index++) fs.writeFileSync(path.join(directory, `zz-other-${index}.ts`), '');
      }
    }
    const modules = {};
    for (const label of ['before', 'after']) {
      modules[label] = path.join(temporary, `${label}.cjs`);
      const contents = label === 'before'
        ? execFileSync('git', ['show', `${baseline}:apps/desktop/src/main/pathResolver.ts`], { cwd: repo, encoding: 'utf8' })
        : fs.readFileSync(source, 'utf8');
      await build({ stdin: { contents, loader: 'ts', resolveDir: path.dirname(source) },
        outfile: modules[label], bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' });
    }
    const batches = [];
    for (let round = 0; round < 6; round++) {
      const batch = { before: {}, after: {} };
      for (const label of round % 2 ? ['after', 'before'] : ['before', 'after']) {
        for (const name of Object.keys(cases)) {
          batch[label][name] = JSON.parse(execFileSync(process.execPath,
            [fileURLToPath(import.meta.url), 'worker', modules[label], name, root], { encoding: 'utf8' }));
        }
      }
      for (const name of Object.keys(cases)) assert.deepEqual(batch.before[name].answer, batch.after[name].answer);
      batches.push(batch);
      console.log(JSON.stringify({ round, ms: Object.fromEntries(Object.entries(batch).map(([label, results]) =>
        [label, Object.fromEntries(Object.entries(results).map(([name, result]) => [name, result.ms]))])) }));
    }
    for (const name of Object.keys(cases)) console.log(JSON.stringify({ name, equal: true,
      beforeMs: median(batches.map((batch) => batch.before[name].ms)),
      afterMs: median(batches.map((batch) => batch.after[name].ms)),
      pairedRatio: median(batches.map((batch) => batch.after[name].ms / batch.before[name].ms)) }));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
