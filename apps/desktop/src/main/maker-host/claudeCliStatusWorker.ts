import { execFileSync } from 'node:child_process';
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
  const request = workerData as ClaudeCliStatusRequest;
  try {
    const stdout = execFileSync(request.binary, ['auth', 'status', '--json'], {
      env: request.env,
      timeout: request.timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    parentPort.postMessage({ stdout });
  } catch (error) {
    // Some CLI versions return logged-out JSON with a non-zero exit status.
    // Never forward stderr/environment through diagnostics.
    const result = error as { status?: number | null; stdout?: string; signal?: string };
    if (typeof result.status === 'number' && typeof result.stdout === 'string') {
      parentPort.postMessage({ stdout: result.stdout });
    } else {
      parentPort.postMessage({ failed: true });
    }
  } finally {
    parentPort.close();
  }
}
