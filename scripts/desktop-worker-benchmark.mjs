#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import manifest from './test-workspaces.config.mjs';
import { resolvePnpmInvocation } from './shared/pnpm-invocation.mjs';
import {
  buildPnpmArgs,
  normalizeRelPath,
  runCommand,
} from './test-workspaces.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_WORKERS = [1, 2, 4, 8];

function positiveInteger(value, option) {
  if (!/^[1-9]\d*$/.test(String(value))) {
    throw new Error(`${option} requires a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${option} requires a positive integer`);
  }
  return parsed;
}

function readOptionValue(args, index, option) {
  const arg = args[index];
  const prefix = `${option}=`;
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), consumed: 0 };
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return { value, consumed: 1 };
}

export function parseDesktopWorkerBenchmarkOptions(args) {
  const options = {
    workers: DEFAULT_WORKERS,
    runs: 1,
    top: 10,
    output: undefined,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--workers' || arg.startsWith('--workers=')) {
      const { value, consumed } = readOptionValue(args, index, '--workers');
      const workers = value
        .split(',')
        .map((item) => positiveInteger(item.trim(), '--workers'));
      if (workers.length === 0) throw new Error('--workers requires at least one value');
      options.workers = [...new Set(workers)];
      index += consumed;
      continue;
    }
    if (arg === '--runs' || arg.startsWith('--runs=')) {
      const { value, consumed } = readOptionValue(args, index, '--runs');
      options.runs = positiveInteger(value, '--runs');
      index += consumed;
      continue;
    }
    if (arg === '--top' || arg.startsWith('--top=')) {
      const { value, consumed } = readOptionValue(args, index, '--top');
      options.top = positiveInteger(value, '--top');
      index += consumed;
      continue;
    }
    if (arg === '--output' || arg.startsWith('--output=')) {
      const { value, consumed } = readOptionValue(args, index, '--output');
      options.output = path.resolve(value);
      index += consumed;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function summarizeDesktopWorkerSamples(samples) {
  const successfulSamples = samples.filter((sample) => sample.success !== false);
  const baseline = successfulSamples.find((sample) => sample.workers === 1);
  return [...new Set(samples.map((sample) => sample.workers))].map((workers) => {
    const workerSamples = samples.filter((sample) => sample.workers === workers);
    const successful = workerSamples.filter((sample) => sample.success !== false);
    const wallValues = successful.map((sample) => sample.wallMs);
    const medianWallMs = wallValues.length > 0 ? median(wallValues) : null;
    return {
      workers,
      runs: workerSamples.length,
      passed: successful.length,
      failed: workerSamples.length - successful.length,
      medianWallMs,
      minWallMs: wallValues.length > 0 ? Math.min(...wallValues) : null,
      maxWallMs: wallValues.length > 0 ? Math.max(...wallValues) : null,
      speedupVsOneWorker:
        baseline && medianWallMs !== null && medianWallMs > 0
          ? median(
              successfulSamples
                .filter((sample) => sample.workers === 1)
                .map((sample) => sample.wallMs),
            ) / medianWallMs
          : null,
    };
  });
}

export function desktopUnitBenchmarkPnpmArgs(workers, outputFile) {
  const workspace = manifest.workspaces.find(({ cwd }) => cwd === 'apps/desktop');
  const unit = workspace?.tiers?.unit;
  const command = unit?.command;
  if (!workspace || command?.type !== 'packageBin') {
    throw new Error('Desktop unit tier must use a packageBin command');
  }
  const args = buildPnpmArgs(ROOT, workspace, command, unit, []).filter(
    (arg) =>
      !arg.startsWith('--maxWorkers=') &&
      !arg.startsWith('--reporter=') &&
      !arg.startsWith('--outputFile='),
  );
  args.push(
    `--maxWorkers=${workers}`,
    '--reporter=json',
    `--outputFile=${outputFile}`,
  );
  return args;
}

function desktopUnitCommand(workers, outputFile) {
  return {
    cwd: path.join(ROOT, 'apps/desktop'),
    pnpmArgs: desktopUnitBenchmarkPnpmArgs(workers, outputFile),
  };
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

export function removeBenchmarkOutputFile(
  outputFile,
  { remove = fs.rmSync, warn = console.warn } = {},
) {
  try {
    remove(outputFile, { force: true });
    return true;
  } catch (error) {
    warn(
      `Warning: could not remove benchmark report ${outputFile}: ` +
        `${error?.message ?? String(error)}`,
    );
    return false;
  }
}

async function runSample({ workers, iteration, top }) {
  const outputFile = path.join(
    os.tmpdir(),
    `cindy-desktop-worker-benchmark-${process.pid}-${workers}-${iteration}.json`,
  );
  const { cwd, pnpmArgs } = desktopUnitCommand(workers, outputFile);
  const invocation = resolvePnpmInvocation(pnpmArgs);
  const startedAt = performance.now();
  try {
    const result = await runCommand(invocation.command, invocation.args, {
      cwd,
      env: invocation.env ? { ...process.env, ...invocation.env } : undefined,
      shell: invocation.shell,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdout: null,
      stderr: null,
    });
    const wallMs = performance.now() - startedAt;
    const report = fs.existsSync(outputFile)
      ? JSON.parse(fs.readFileSync(outputFile, 'utf8'))
      : null;
    if (result.exitCode !== 0 || !report?.success) {
      process.stderr.write(result.output);
      const failedFiles = [];
      for (const file of report?.testResults ?? []) {
        if (file.status !== 'failed') continue;
        const relativeFile = normalizeRelPath(path.relative(ROOT, file.name));
        failedFiles.push(relativeFile);
        process.stderr.write(`\nFAILED ${relativeFile}\n`);
        for (const assertion of file.assertionResults ?? []) {
          for (const message of assertion.failureMessages ?? []) {
            process.stderr.write(`${message}\n`);
          }
        }
      }
      return {
        workers,
        iteration,
        success: false,
        exitCode: result.exitCode,
        wallMs: roundMs(wallMs),
        files: report?.testResults?.length ?? 0,
        tests: report?.numTotalTests ?? 0,
        failedFiles,
        error: result.output.includes('ERR_IPC_CHANNEL_CLOSED')
          ? 'ERR_IPC_CHANNEL_CLOSED'
          : 'TEST_RUN_FAILED',
      };
    }
    const files = report.testResults.map((file) => ({
      file: normalizeRelPath(path.relative(ROOT, file.name)),
      durationMs: roundMs(Math.max(0, file.endTime - file.startTime)),
    }));
    const fileDurations = files.map((file) => file.durationMs);
    return {
      workers,
      iteration,
      success: true,
      exitCode: 0,
      wallMs: roundMs(wallMs),
      files: files.length,
      tests: report.numTotalTests,
      fileDurationMs: {
        sum: roundMs(fileDurations.reduce((sum, value) => sum + value, 0)),
        p50: roundMs(percentile(fileDurations, 0.5)),
        p95: roundMs(percentile(fileDurations, 0.95)),
        p99: roundMs(percentile(fileDurations, 0.99)),
        max: roundMs(Math.max(...fileDurations)),
      },
      slowestFiles: files
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, top),
    };
  } finally {
    removeBenchmarkOutputFile(outputFile);
  }
}

function printUsage() {
  console.log(`Desktop unit worker benchmark

Usage:
  pnpm benchmark:desktop-workers -- [options]

Options:
  --workers <list>  Comma-separated worker counts. Default: 1,2,4,8
  --runs <n>        Repetitions per worker count. Default: 1
  --top <n>         Slowest files kept per sample. Default: 10
  --output <path>   Write the complete JSON report
`);
}

function printSummary(report) {
  console.log('\nDesktop unit worker benchmark\n');
  console.log(
    `Host: ${report.machine.platform}-${report.machine.arch}, Node ${report.machine.node}, ` +
      `${report.machine.availableParallelism} available CPUs, ${report.machine.memoryGiB} GiB RAM`,
  );
  console.log('\nworkers  pass/run  median wall  min       max       speedup vs 1');
  for (const row of report.summary) {
    const speedup =
      row.speedupVsOneWorker === null ? '-' : `${row.speedupVsOneWorker.toFixed(2)}x`;
    const formatSeconds = (value) =>
      value === null ? '-'.padEnd(10) : (value / 1_000).toFixed(1).padEnd(10);
    console.log(
      `${String(row.workers).padEnd(9)}` +
        `${`${row.passed}/${row.runs}`.padEnd(10)}` +
        `${formatSeconds(row.medianWallMs).padEnd(13)}` +
        `${formatSeconds(row.minWallMs)}` +
        `${formatSeconds(row.maxWallMs)}` +
        speedup,
    );
  }
}

async function main() {
  const options = parseDesktopWorkerBenchmarkOptions(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const samples = [];
  for (const workers of options.workers) {
    for (let iteration = 1; iteration <= options.runs; iteration += 1) {
      console.log(`START workers=${workers} run=${iteration}/${options.runs}`);
      const sample = await runSample({ workers, iteration, top: options.top });
      samples.push(sample);
      if (sample.success) {
        console.log(
          `PASS  workers=${workers} run=${iteration}/${options.runs} ` +
            `wall=${(sample.wallMs / 1_000).toFixed(1)}s`,
        );
      } else {
        console.log(
          `FAIL  workers=${workers} run=${iteration}/${options.runs} ` +
            `wall=${(sample.wallMs / 1_000).toFixed(1)}s error=${sample.error}`,
        );
      }
    }
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    machine: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      availableParallelism: os.availableParallelism(),
      memoryGiB: roundMs(os.totalmem() / 1024 ** 3),
      cpu: os.cpus()[0]?.model ?? 'unknown',
    },
    options: {
      workers: options.workers,
      runs: options.runs,
      top: options.top,
    },
    samples,
    summary: summarizeDesktopWorkerSamples(samples),
  };
  printSummary(report);
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nJSON report: ${options.output}`);
  }
  if (samples.some((sample) => !sample.success)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
