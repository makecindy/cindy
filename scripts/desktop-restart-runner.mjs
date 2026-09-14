#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertSharedDevMigrationPolicy } from './dev-migration-policy.mjs';
import {
  buildDesktopDevVerdictFromFailure,
  desktopRestartArgvConflictMessage,
  normalizeDesktopRestartArgv,
  printDesktopDevVerdict,
  restartContextFromArgv,
} from './desktop-dev-verdict.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Build the restart pipeline without a shell chain so user-supplied options reach
 * the coordinator as a whole. In particular, --preserve-running must skip the
 * initial kill stage instead of arriving only at the final command.
 */
export function buildDesktopRestartSteps(argv, root = rootDir) {
  if (argv.includes('--kill-only')) {
    throw new Error('--kill-only is internal to the desktop restart pipeline');
  }

  const local = argv.includes('--local');
  const preserveRunning = argv.includes('--preserve-running');
  const forwarded = argv.filter(
    (arg) => arg !== '--' && arg !== '--local' && arg !== '--wait-ready',
  );
  const restartScript = path.join(root, 'scripts', 'restart-desktop-remote.mjs');
  const modeArgs = local ? ['--local'] : [];

  return [
    ...(preserveRunning ? [] : [{
      label: 'stop existing desktop dev processes',
      command: process.execPath,
      // 用户参数(尤其 --isolated)必须跟进 kill 阶段:userData 冲突门要在
      // 杀任何进程之前就按目标沙箱判定,不能等到最终启动阶段才发现冲突。
      args: [restartScript, ...modeArgs, ...forwarded, '--kill-only'],
    }]),
    {
      label: 'verify desktop dependencies',
      command: process.execPath,
      args: [path.join(root, 'scripts', 'ensure-deps.mjs')],
    },
    {
      label: 'verify desktop runtime assets',
      command: process.execPath,
      args: [path.join(root, 'scripts', 'ensure-dev-runtime-assets.mjs')],
    },
    {
      label: 'start desktop and wait for readiness',
      command: process.execPath,
      args: [restartScript, ...modeArgs, ...forwarded, '--wait-ready'],
    },
  ];
}

export class DesktopRestartStepError extends Error {
  constructor(message, { alreadyHasVerdict = false, exitCode = 1 } = {}) {
    super(message);
    this.name = 'DesktopRestartStepError';
    this.alreadyHasVerdict = alreadyHasVerdict;
    this.exitCode = exitCode;
  }
}

export function assertDesktopRestartStepSucceeded(step, result) {
  if (result?.error) throw result.error;
  if (result?.signal) {
    throw new DesktopRestartStepError(`${step.label} terminated by ${result.signal}`);
  }
  if ((result?.status ?? 0) !== 0) {
    throw new DesktopRestartStepError(
      `${step.label} failed with exit ${result.status ?? 1}`,
      {
        alreadyHasVerdict: Array.isArray(step.args)
          && (step.args.includes('--wait-ready') || step.args.includes('--kill-only')),
        exitCode: result.status ?? 1,
      },
    );
  }
}

function runStep(step) {
  const result = spawnSync(step.command, step.args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });
  assertDesktopRestartStepSucceeded(step, result);
}

export function runDesktopRestart(argv, root = rootDir, stepRunner = runStep) {
  const normalizedArgv = normalizeDesktopRestartArgv(argv);
  const conflict = desktopRestartArgvConflictMessage(normalizedArgv);
  if (conflict) throw new Error(conflict);
  assertSharedDevMigrationPolicy(root, normalizedArgv);
  for (const step of buildDesktopRestartSteps(normalizedArgv, root)) stepRunner(step);
}

function main() {
  const argv = normalizeDesktopRestartArgv(process.argv.slice(2));
  try {
    runDesktopRestart(argv);
  } catch (error) {
    if (!error?.alreadyHasVerdict) {
      printDesktopDevVerdict(buildDesktopDevVerdictFromFailure(error, {
        rootDir,
        ...restartContextFromArgv(argv),
      }));
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error?.exitCode ?? 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
