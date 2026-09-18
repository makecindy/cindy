import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- Keep physical filesystem semantics isolated from Electron main.
import { Worker } from 'node:worker_threads';
import type { RecoveryArchiveResult, RecoveryArchiveTask } from './recoveryArchiveTask';

// Recovery includes ignored build dependencies, so allow large local archives while
// still bounding an operation that never replies. This is not a retry budget.
export const RECOVERY_ARCHIVE_TIMEOUT_MS = 30 * 60_000;

export function runRecoveryArchiveTask<T extends RecoveryArchiveTask>(task: T): Promise<RecoveryArchiveResult<T>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'recoveryArchiveWorker.js'), { workerData: task });
    let finishing = false;
    const finish = (error?: Error, result?: RecoveryArchiveResult<T>) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      // Do not release the caller's resource lock while the worker can still write.
      // Keep the error listener until termination to absorb a racing worker error.
      void worker.terminate().then(() => {
        worker.removeAllListeners();
        if (error) reject(error);
        else resolve(result as RecoveryArchiveResult<T>);
      }, (terminationError: unknown) => {
        reject(terminationError);
      });
    };
    const timer = setTimeout(() => {
      finish(new Error(`worktree recovery ${task.operation} timed out after ${RECOVERY_ARCHIVE_TIMEOUT_MS}ms`));
    }, RECOVERY_ARCHIVE_TIMEOUT_MS);
    worker.once('message', (message: { ok: boolean; result: RecoveryArchiveResult<T>; error?: string }) => {
      finish(message.ok ? undefined : new Error(message.error ?? 'worktree recovery worker failed'), message.result);
    });
    worker.on('error', (error) => finish(error));
    worker.once('exit', (code) => {
      finish(new Error(`worktree recovery worker exited before replying (${code})`));
    });
    // Attaching message listeners refs the port; unref only after installing them.
    worker.unref();
    timer.unref();
  });
}
