import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { createSourceFileAccessError, isSourceFileAccessError } from './sourceFileError';

interface SourceFileAccessRecovery {
  /** A native single-file picker; the selected path stays inside Main. */
  selectFile(source: string): Promise<string | null>;
  assertCurrent(): void;
  signal?: AbortSignal;
}
const recoveryContext = new AsyncLocalStorage<SourceFileAccessRecovery & { attempted: Set<string>; discard: Set<() => void> }>();

/** Only the trusted foreground chat adapter installs this scope. Exports/background jobs do not prompt. */
export function withSourceFileAccessRecovery<T>(recovery: SourceFileAccessRecovery, operation: () => Promise<T>): Promise<T> {
  const discard = new Set<() => void>();
  const discardUploads = () => {
    for (const cleanup of discard) cleanup();
    discard.clear();
  };
  recovery.signal?.addEventListener('abort', discardUploads, { once: true });
  return recoveryContext.run({ ...recovery, attempted: new Set(), discard }, async () => {
    try {
      return await operation();
    } catch (error) {
      discardUploads();
      recovery.assertCurrent();
      throw error;
    } finally {
      recovery.signal?.removeEventListener('abort', discardUploads);
      discard.clear();
    }
  });
}

/** Captured by each transfer, so its asynchronous checkpoints retain the initiating scope. */
export function sourceFileAccessTransferOptions(): { assertCurrent?: () => void; signal?: AbortSignal } {
  const scope = recoveryContext.getStore();
  return scope ? { assertCurrent: scope.assertCurrent, signal: scope.signal } : {};
}

/** A multi-attachment send owns every new object until its final dispatch starts. */
export function onSourceFileAccessDiscard(cleanup: () => void): void {
  const scope = recoveryContext.getStore();
  if (!scope) return;
  if (scope.signal?.aborted) cleanup();
  else scope.discard.add(cleanup);
}

/** Once dispatch starts its outcome may be uncertain; accepted messages still need these bytes. */
export function releaseSourceFileAccessUploads(): void {
  recoveryContext.getStore()?.discard.clear();
}

async function isSelectedSource(source: string, selected: string): Promise<boolean> {
  if (selected === source) return true;
  if (process.platform !== 'win32'
    || path.win32.normalize(selected).toLowerCase() !== path.win32.normalize(source).toLowerCase()) return false;
  // Folding alone would accept a different file in a case-sensitive Windows directory.
  // Compare filesystem identity instead; a missing/unsupported identity fails closed.
  try {
    const [original, confirmed] = await Promise.all([stat(source, { bigint: true }), stat(selected, { bigint: true })]);
    return original.isFile() && confirmed.isFile() && original.ino !== 0n
      && original.dev === confirmed.dev && original.ino === confirmed.ino;
  } catch {
    return false;
  }
}

export async function readWithSourceFileAccessRecovery<T>(source: string, read: () => Promise<T>): Promise<T> {
  const scope = recoveryContext.getStore();
  scope?.assertCurrent();
  try {
    const result = await read();
    scope?.assertCurrent();
    return result;
  } catch (error) {
    if (!scope || !isSourceFileAccessError(error, source)
      || !(process.platform === 'win32' ? path.win32 : path).isAbsolute(source) || scope.attempted.has(source)) throw error;
    scope.assertCurrent();
    scope.attempted.add(source);
    const selected = await scope.selectFile(source);
    scope.assertCurrent();
    // Confirm only this original. A different file must never silently replace a draft attachment.
    if (!selected || !await isSelectedSource(source, selected)) throw createSourceFileAccessError();
    scope.assertCurrent();
    // No recursive retry: a second denial returns the normal error and restores the draft.
    const result = await read();
    scope.assertCurrent();
    return result;
  }
}
