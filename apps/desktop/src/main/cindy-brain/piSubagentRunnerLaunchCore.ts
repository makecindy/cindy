import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { PiSubagentRunnerLaunchRequest } from '@cindy/maker-core';

/**
 * The parts of the PI Subagent runner launcher that do not depend on the process type: the launch
 * path checks and stopping a runner by its pid. Moved verbatim from piSubagentRunnerHost.ts, which
 * forks through Electron's utilityProcess; the Node Host forks through child_process
 * (apps/host/src/agent/pi-subagent-runner.ts).
 */
function resolveLaunchPath(file: string): string {
  const resolved = path.resolve(file);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isContainedRunnerLayout(
  runId: string,
  runDir: string,
  runnerFile: string,
  configFile: string,
): boolean {
  return path.basename(runnerFile) === 'runner.cjs'
    && path.basename(configFile) === 'config.json'
    && path.dirname(runnerFile) === runDir
    && path.dirname(configFile) === runDir
    && path.basename(runDir) === runId;
}

/** Validate a launch request's layout; returns the requested (not realpath-resolved) runner and config paths. */
export function resolvePiSubagentRunnerLaunchPaths(
  request: PiSubagentRunnerLaunchRequest,
): { requestedRunnerFile: string; requestedConfigFile: string } {
  const requestedRunDir = path.resolve(request.runDir);
  const requestedRunnerFile = path.resolve(request.runnerFile);
  const requestedConfigFile = path.resolve(request.configFile);
  const runDir = resolveLaunchPath(request.runDir);
  const runnerFile = resolveLaunchPath(request.runnerFile);
  const configFile = resolveLaunchPath(request.configFile);
  if (
    !isContainedRunnerLayout(request.runId, requestedRunDir, requestedRunnerFile, requestedConfigFile)
    || !isContainedRunnerLayout(request.runId, runDir, runnerFile, configFile)
  ) {
    throw new Error('PI Subagent runner paths are invalid');
  }
  return { requestedRunnerFile, requestedConfigFile };
}

/** Stop a runner by its recorded pid (on Windows its process tree); false when neither path applied. */
export function killPiSubagentRunnerPid(pid: number | undefined, signal?: NodeJS.Signals): boolean {
  if (pid !== undefined && process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    const tree = spawnSync('taskkill', args, {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5_000,
    });
    if (!tree.error && tree.status === 0) return true;
  }
  if (pid !== undefined) {
    try {
      process.kill(pid, signal ?? 'SIGTERM');
      return true;
    } catch {
      // The process may already be gone or the platform may not support the signal.
    }
  }
  return false;
}
