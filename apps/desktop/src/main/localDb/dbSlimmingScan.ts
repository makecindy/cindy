import { createIpcError } from '../../shared/ipc-errors';
import {
  resolveBetterSqliteModuleEntry,
  resolveBetterSqliteNativeBinding,
} from './betterSqliteFactory';
import type { DbSlimmingProcessMessage } from './dbSlimmingProcessProtocol';
import type { ScanAggregateRow } from './dbSlimmingScanQuery';
import {
  DB_SLIMMING_WORKER_READY_TIMEOUT_MS,
  DB_SLIMMING_WORKER_TERMINATION_TIMEOUT_MS,
  forkDbSlimmingUtilityProcess,
  type DbSlimmingUtilityProcessLike,
} from './dbSlimmingWorkerClient';

export interface DbSlimmingScanOptions {
  dbFilePath: string;
  archivedBeforeMs: number;
  includeActiveTasks: boolean;
  onDatabaseError?(error: Error): void;
  signal?: AbortSignal;
  isOwnerCurrent(): boolean;
}

export const DB_SLIMMING_SCAN_TIMEOUT_MS = 5 * 60_000;
// A failed kill must not let repeated clicks accumulate native queries/read locks.
let scanProcessActive = false;

/** One read-only snapshot in the existing OS-killable maintenance process, off the DB RPC queue. */
export async function scanDbSlimmingPreview(
  options: DbSlimmingScanOptions,
  fork: () => DbSlimmingUtilityProcessLike = forkDbSlimmingUtilityProcess,
): Promise<ScanAggregateRow> {
  if (scanProcessActive)
    throw createIpcError('PRECONDITION_FAILED', 'database scan is still stopping');
  if (!options.isOwnerCurrent())
    throw createIpcError('PRECONDITION_FAILED', 'database owner changed before scan');
  const moduleEntry = resolveBetterSqliteModuleEntry();
  if (!moduleEntry) throw new Error('database scan SQLite module is unavailable');
  const child = fork();
  scanProcessActive = true;
  return new Promise<ScanAggregateRow>((resolve, reject) => {
    let ready = false;
    let stopping = false;
    let settled = false;
    let row: ScanAggregateRow | undefined;
    let failure: unknown;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (unconfirmed = false): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', cancel);
      clearTimeout(deadline);
      clearTimeout(terminationTimer);
      clearInterval(ownerCheck);
      if (unconfirmed) reject(new Error('database scan process termination was not confirmed'));
      else if (failure) reject(failure);
      else if (row) resolve(row);
      else reject(new Error('database scan process exited without statistics'));
    };
    const stop = (error?: unknown): void => {
      if (stopping) return;
      stopping = true;
      failure = error;
      clearTimeout(deadline);
      clearInterval(ownerCheck);
      terminationTimer = setTimeout(() => finish(true), DB_SLIMMING_WORKER_TERMINATION_TIMEOUT_MS);
      try {
        child.kill();
      } catch (killError) {
        failure = killError;
      }
    };
    const cancel = () => stop(createIpcError('PRECONDITION_FAILED', 'database scan cancelled'));
    let deadline = setTimeout(
      () => stop(new Error('database scan process did not become ready')),
      DB_SLIMMING_WORKER_READY_TIMEOUT_MS,
    );
    const ownerCheck = setInterval(() => {
      if (!options.isOwnerCurrent())
        stop(createIpcError('PRECONDITION_FAILED', 'database owner changed during scan'));
    }, 1000);
    options.signal?.addEventListener('abort', cancel, { once: true });
    child.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      const event = message as DbSlimmingProcessMessage;
      if (event.type === 'error') {
        const error = Object.assign(new Error(event.error.message), { code: event.error.code });
        options.onDatabaseError?.(error);
        stop(error);
        return;
      }
      if (stopping) return;
      if (event.type === 'ready' && !ready) {
        ready = true;
        if (!options.isOwnerCurrent()) {
          stop(createIpcError('PRECONDITION_FAILED', 'database owner changed before scan'));
          return;
        }
        clearTimeout(deadline);
        deadline = setTimeout(
          () => stop(createIpcError('DB_SCAN_TIMEOUT', 'database scan timed out after 5 minutes')),
          DB_SLIMMING_SCAN_TIMEOUT_MS,
        );
        try {
          child.postMessage({
            type: 'scan',
            input: {
              dbFilePath: options.dbFilePath,
              archivedBeforeMs: options.archivedBeforeMs,
              includeActiveTasks: options.includeActiveTasks,
              moduleEntry,
              nativeBinding: resolveBetterSqliteNativeBinding(),
            },
          });
        } catch (error) {
          stop(error);
        }
      } else if (event.type === 'scan-result' && ready) {
        row = event.row;
        stop();
      }
    });
    child.on('error', (...errors) =>
      stop(new Error(`database scan process error: ${errors.map(String).join(' ')}`)),
    );
    child.on('exit', () => {
      // Only actual exit releases admission, including after an unconfirmed-termination error.
      scanProcessActive = false;
      finish();
    });
  });
}
