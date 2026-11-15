import { createRequire } from 'node:module';
import path from 'node:path';

import { startParentWatchdog } from './pi-subagent-parent-watchdog.cjs';

// The desktop entry (desktop cindy-brain/piSubagentRunnerProcess.ts) for a Node child_process.fork:
// Node's IPC channel replaces Electron's parentPort. The same single ready frame is sent, and the
// channel is closed (the desktop entry clears parentPort) before the runner loads.
const send = process.send?.bind(process);
const hostPid = process.ppid;
const runnerFile = process.argv[2];
const configFile = process.argv[3];

if (!send) throw new Error('PI Subagent runner process is missing its IPC channel');
if (
  typeof runnerFile !== 'string'
  || !path.isAbsolute(runnerFile)
  || path.basename(runnerFile) !== 'runner.cjs'
  || typeof configFile !== 'string'
  || !path.isAbsolute(configFile)
  || path.basename(configFile) !== 'config.json'
  || path.dirname(runnerFile) !== path.dirname(configFile)
) {
  throw new Error('PI Subagent runner process arguments are invalid');
}

send({ type: 'ready' }, (error: Error | null) => {
  if (error) throw error;
  process.disconnect?.();
  // Not in the desktop entry: a utilityProcess ends with Electron's main process, a Node fork does not.
  // When the Host is gone, stop through the runner's own SIGTERM cleanup (it also ends its Pi
  // children); force the exit if that cleanup does not finish within 5 seconds.
  startParentWatchdog({
    parentPid: hostPid,
    onParentGone: () => {
      setTimeout(() => process.exit(1), 5_000);
      process.kill(process.pid, 'SIGTERM');
    },
  });

  process.argv = [process.argv[0], runnerFile, configFile];
  createRequire(__filename)(runnerFile);
});
