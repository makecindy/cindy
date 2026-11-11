import { createIpcError, isIpcError } from '../../shared/ipc-errors';

/** Safe at every caller boundary, including non-chat IPC and remote export status. */
export function createSourceFileAccessError() {
  return createIpcError('DEVICE_LINK_MEDIA_ACCESS_DENIED',
    'Cannot read the source attachment. Save a copy to an accessible folder, remove the original attachment, and add the copy again.');
}

/** Only a local source read denial warrants file-access recovery guidance.
 * Transport permissions and failures writing another file must keep their own semantics.
 */
export function isSourceFileAccessError(error: unknown, source: string | Buffer): boolean {
  if (isIpcError(error) && error.code === 'DEVICE_LINK_MEDIA_ACCESS_DENIED') return true;
  if (typeof source !== 'string' || !error || typeof error !== 'object') return false;
  const { code, syscall, path } = error as NodeJS.ErrnoException;
  return (code === 'EPERM' || code === 'EACCES')
    && path === source
    && (syscall === 'open' || syscall === 'stat' || syscall === 'fstat' || syscall === 'read');
}

/** Only for a known source read operation/stream; never use on a network or output error. */
export function sourceFileReadError(error: Error, source: string | Buffer): Error {
  const { code, syscall, path } = error as NodeJS.ErrnoException;
  if (isSourceFileAccessError(error, source)
    || (typeof source === 'string' && path === undefined
      && (code === 'EPERM' || code === 'EACCES')
      && (syscall === 'fstat' || syscall === 'read'))) {
    // Do not retain path or cause: callers can serialize either, not just message.
    return createSourceFileAccessError();
  }
  return error;
}

/** Use only around this source's stat/read operations, never around transport work. */
export async function withSourceFileHandleContext<T>(
  source: string | Buffer,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw error instanceof Error ? sourceFileReadError(error, source) : error;
  }
}
