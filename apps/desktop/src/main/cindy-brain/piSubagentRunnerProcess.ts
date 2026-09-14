import { createRequire } from 'node:module';
import path from 'node:path';

interface ParentPortLike {
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
const runnerFile = process.argv[2];
const configFile = process.argv[3];

if (!parentPort) throw new Error('PI Subagent runner process is missing parentPort');
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

parentPort.postMessage({ type: 'ready' });
try {
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: undefined,
  });
} catch {
  // The host accepts only the fixed ready frame; leaving an inaccessible port is harmless.
}

process.argv = [process.argv[0], runnerFile, configFile];
createRequire(__filename)(runnerFile);
