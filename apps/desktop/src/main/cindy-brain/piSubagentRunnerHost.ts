import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { utilityProcess } from 'electron';

import type {
  PiSubagentRunnerLaunchRequest,
  PiSubagentRunnerProcess,
} from '@cindy/maker-core';

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

/** Launch a durable PI Subagent runner through Electron's supported Node service. */
export function spawnPiSubagentRunner(
  request: PiSubagentRunnerLaunchRequest,
  fork: typeof utilityProcess.fork = utilityProcess.fork,
): PiSubagentRunnerProcess {
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

  const hostEntry = path.join(__dirname, 'piSubagentRunnerProcess.js');
  const child = fork(hostEntry, [requestedRunnerFile, requestedConfigFile], {
    cwd: request.cwd,
    env: request.env,
    stdio: 'ignore',
    serviceName: `cindy-pi-subagent:${request.runId}`,
    ...(process.platform === 'darwin' ? { disclaim: true } : {}),
  });
  const events = new EventEmitter();
  let ready = false;
  let killed = false;

  child.on('message', (message) => {
    if (
      !ready
      && message
      && typeof message === 'object'
      && !Array.isArray(message)
      && (message as Record<string, unknown>).type === 'ready'
    ) {
      ready = true;
      events.emit('spawn');
    }
  });
  child.on('exit', (code) => {
    killed = true;
    events.emit('exit', code, null);
    events.emit('close', code, null);
  });
  child.on('error', (type, location) => {
    events.emit('error', new Error(`PI Subagent utility process ${type} at ${location}`));
  });

  const adapter: PiSubagentRunnerProcess = {
    get pid() {
      return child.pid;
    },
    get killed() {
      return killed;
    },
    once(event, listener) {
      events.once(event, listener);
      return adapter;
    },
    kill(signal): boolean {
      killed = true;
      const pid = child.pid;
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
      return child.kill();
    },
  };
  return adapter;
}
