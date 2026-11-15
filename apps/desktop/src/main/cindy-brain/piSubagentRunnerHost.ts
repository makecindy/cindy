import { EventEmitter } from 'node:events';
import path from 'node:path';
import { utilityProcess } from 'electron';

import type {
  PiSubagentRunnerLaunchRequest,
  PiSubagentRunnerProcess,
} from '@cindy/maker-core';

import { killPiSubagentRunnerPid, resolvePiSubagentRunnerLaunchPaths } from './piSubagentRunnerLaunchCore.js';

/** Launch a durable PI Subagent runner through Electron's supported Node service. */
export function spawnPiSubagentRunner(
  request: PiSubagentRunnerLaunchRequest,
  fork: typeof utilityProcess.fork = utilityProcess.fork,
): PiSubagentRunnerProcess {
  const { requestedRunnerFile, requestedConfigFile } = resolvePiSubagentRunnerLaunchPaths(request);

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
      if (killPiSubagentRunnerPid(pid, signal)) return true;
      return child.kill();
    },
  };
  return adapter;
}
