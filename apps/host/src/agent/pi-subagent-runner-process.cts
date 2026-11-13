import { createRequire } from 'node:module';
import path from 'node:path';

// The desktop entry (desktop cindy-brain/piSubagentRunnerProcess.ts) for a Node child_process.fork:
// Node's IPC channel replaces Electron's parentPort. The same single ready frame is sent, and the
// channel is closed (the desktop entry clears parentPort) before the runner loads.
const send = process.send?.bind(process);
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

  process.argv = [process.argv[0], runnerFile, configFile];
  createRequire(__filename)(runnerFile);
});
