import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- Keep physical filesystem semantics isolated from Electron main.
import { Worker } from 'node:worker_threads';
import type { RecoveryArchiveResult, RecoveryArchiveTask } from './recoveryArchiveTask';

export function runRecoveryArchiveTask<T extends RecoveryArchiveTask>(task: T): Promise<RecoveryArchiveResult<T>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'recoveryArchiveWorker.js'), { workerData: task });
    let replied = false;
    worker.once('message', (message: { ok: boolean; result: RecoveryArchiveResult<T>; error?: string }) => {
      replied = true;
      if (message.ok) resolve(message.result);
      else reject(new Error(message.error ?? 'worktree recovery worker failed'));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!replied) reject(new Error(`worktree recovery worker exited before replying (${code})`));
    });
  });
}
