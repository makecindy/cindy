import assert from 'node:assert/strict';
import test from 'node:test';

import {
  desktopUnitBenchmarkPnpmArgs,
  median,
  parseDesktopWorkerBenchmarkOptions,
  percentile,
  removeBenchmarkOutputFile,
  summarizeDesktopWorkerSamples,
} from '../desktop-worker-benchmark.mjs';

test('desktop worker benchmark parses bounded worker and output options', () => {
  assert.deepEqual(
    parseDesktopWorkerBenchmarkOptions([
      '--',
      '--workers=4, 1,4',
      '--runs',
      '2',
      '--top=5',
      '--output',
      'result.json',
    ]),
    {
      workers: [4, 1],
      runs: 2,
      top: 5,
      output: process.platform === 'win32'
        ? `${process.cwd()}\\result.json`
        : `${process.cwd()}/result.json`,
      help: false,
    },
  );
});

test('desktop worker benchmark rejects invalid numeric options', () => {
  for (const args of [
    ['--workers=0'],
    ['--workers=1,nope'],
    ['--runs=1.5'],
    ['--top', '-1'],
  ]) {
    assert.throws(
      () => parseDesktopWorkerBenchmarkOptions(args),
      /requires (a positive integer|a value)/,
    );
  }
});

test('desktop worker benchmark reuses the unit tier exclusions', () => {
  const args = desktopUnitBenchmarkPnpmArgs(2, 'report.json');
  assert.ok(args.includes('--maxWorkers=2'));
  assert.ok(args.includes('--reporter=json'));
  assert.ok(args.includes('--outputFile=report.json'));
  assert.ok(args.includes('src/main/localDb/**'));
  assert.ok(args.includes('**/*.bench.ts'));
});

test('percentile uses the nearest-rank value', () => {
  assert.equal(percentile([], 0.95), 0);
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
});

test('median averages the two middle values for even-sized samples', () => {
  assert.equal(median([]), 0);
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([40, 10, 30, 20]), 25);
});

test('desktop worker benchmark summarizes median wall time and speedup', () => {
  assert.deepEqual(
    summarizeDesktopWorkerSamples([
      { workers: 1, wallMs: 100 },
      { workers: 1, wallMs: 120 },
      { workers: 2, wallMs: 60 },
      { workers: 2, wallMs: 70 },
    ]),
    [
      {
        workers: 1,
        runs: 2,
        passed: 2,
        failed: 0,
        medianWallMs: 110,
        minWallMs: 100,
        maxWallMs: 120,
        speedupVsOneWorker: 1,
      },
      {
        workers: 2,
        runs: 2,
        passed: 2,
        failed: 0,
        medianWallMs: 65,
        minWallMs: 60,
        maxWallMs: 70,
        speedupVsOneWorker: 110 / 65,
      },
    ],
  );
});

test('desktop worker benchmark keeps failed configurations in the summary', () => {
  assert.deepEqual(
    summarizeDesktopWorkerSamples([
      { workers: 2, success: false, wallMs: 100 },
      { workers: 4, success: true, wallMs: 80 },
    ]),
    [
      {
        workers: 2,
        runs: 1,
        passed: 0,
        failed: 1,
        medianWallMs: null,
        minWallMs: null,
        maxWallMs: null,
        speedupVsOneWorker: null,
      },
      {
        workers: 4,
        runs: 1,
        passed: 1,
        failed: 0,
        medianWallMs: 80,
        minWallMs: 80,
        maxWallMs: 80,
        speedupVsOneWorker: null,
      },
    ],
  );
});

test('benchmark cleanup never masks the benchmark result', () => {
  const warnings = [];
  assert.equal(
    removeBenchmarkOutputFile('locked-report.json', {
      remove: () => {
        throw Object.assign(new Error('file is busy'), { code: 'EBUSY' });
      },
      warn: (message) => warnings.push(message),
    }),
    false,
  );
  assert.deepEqual(warnings, [
    'Warning: could not remove benchmark report locked-report.json: file is busy',
  ]);
});
