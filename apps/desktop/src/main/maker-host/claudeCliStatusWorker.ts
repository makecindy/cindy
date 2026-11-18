import { readClaudeCliLoginStatusBySpawn } from '@cindy/maker-core/claude-cli-login-status';
// eslint-disable-next-line no-restricted-imports -- CLI startup can block Electron Main on Windows.
import { parentPort, workerData } from 'node:worker_threads';

export interface ClaudeCliStatusRequest {
  binary: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

// Only the bundled CLI's read-only status query runs here. Login cancellation
// and interactive login continue to use their existing process lifecycle.
if (parentPort) {
  const port = parentPort;
  const request = workerData as ClaudeCliStatusRequest;
  void readClaudeCliLoginStatusBySpawn(request)
    .then(status => port.postMessage({ status }))
    // Never forward CLI output or environment through error diagnostics.
    .catch(() => port.postMessage({ failed: true }))
    .finally(() => port.close());
}
