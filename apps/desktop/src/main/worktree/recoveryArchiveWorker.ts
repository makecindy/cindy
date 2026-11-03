// eslint-disable-next-line no-restricted-imports -- Physical archive I/O must not change Electron main's ASAR semantics.
import { parentPort, workerData } from 'node:worker_threads';
import { executeRecoveryArchiveTask } from './recoveryArchiveTask';
import type { RecoveryArchiveTask } from './recoveryArchiveTask';

// Imports must finish while this worker can still load its own bundle from app.asar.
// process.noAsar is isolate-local: main and other workers retain virtual ASAR access.
process.noAsar = true;
void executeRecoveryArchiveTask(workerData as RecoveryArchiveTask).then(
  (result) => parentPort!.postMessage({ ok: true, result }),
  (error: unknown) => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
);
