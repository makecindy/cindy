import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- Isolate the blocking OS process launch from Electron Main.
import { Worker } from 'node:worker_threads';
import type { ClaudeCliStatusRequest } from './claudeCliStatusWorker';

export function readClaudeCliStatusInWorker(request: ClaudeCliStatusRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'claudeCliStatusWorker.js'), { workerData: request });
    // execFileSync owns the child timeout and reaps it before the worker exits.
    // Do not terminate a worker while it is still responsible for that child.
    worker.once('message', (result: { stdout?: unknown; failed?: boolean }) => {
      if (typeof result?.stdout === 'string' && !result.failed) resolve(result.stdout);
      else reject(new Error('claude auth status worker failed'));
    });
    worker.once('error', () => reject(new Error('claude auth status worker failed')));
    worker.once('exit', () => reject(new Error('claude auth status worker exited before response')));
  });
}
