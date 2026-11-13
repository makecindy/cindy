import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type {
  PiSubagentRunnerLaunchRequest,
  PiSubagentRunnerProcess,
} from '@cindy/maker-core';

import {
  killPiSubagentRunnerPid,
  resolvePiSubagentRunnerLaunchPaths,
} from '../../../desktop/src/main/cindy-brain/piSubagentRunnerLaunchCore.js';
import { hostRuntimeLayout } from '../runtime-layout.mjs';

/**
 * Launch a durable PI Subagent runner from the Host, as the desktop does (cindy-brain/
 * piSubagentRunnerHost.ts) with one difference: the Host has no Electron, so it forks a Node child
 * process instead of a utilityProcess. The same path checks and pid-based stop come from the shared
 * core; the entry (pi-subagent-runner-process.cts) sends the same ready frame and then closes the
 * IPC channel before loading runner.cjs. The child receives only the request's environment.
 */
export function spawnHostPiSubagentRunner(
  request: PiSubagentRunnerLaunchRequest,
  forkImpl: typeof fork = fork,
): PiSubagentRunnerProcess {
  const { requestedRunnerFile, requestedConfigFile } = resolvePiSubagentRunnerLaunchPaths(request);

  const layout = hostRuntimeLayout();
  const child = forkImpl(layout.piSubagentRunner, [requestedRunnerFile, requestedConfigFile], {
    cwd: request.cwd,
    env: request.env,
    // A source run loads the TypeScript entry through tsx; a release runs the built entry.
    execArgv: layout.packaged ? [] : ['--import', import.meta.resolve('tsx')],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
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
  child.on('exit', (code, signal) => {
    killed = true;
    events.emit('exit', code, signal);
    events.emit('close', code, signal);
  });
  child.on('error', (error) => {
    events.emit('error', new Error(`PI Subagent runner process failed: ${error.message}`));
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
      if (killPiSubagentRunnerPid(pid, signal)) return true;
      return child.kill();
    },
  };
  return adapter;
}
