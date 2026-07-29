import { isIpcError } from '../../shared/ipc-errors.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const log = createLogger('ghost-appearance-ipc');

/**
 * Keeps renderer-facing appearance mutations on the structured IPC error
 * protocol while retaining unexpected storage details only in main logs.
 */
export async function invokeGhostAppearanceIpc<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isIpcError(error)) throw error;
    log.warn('appearance IPC mutation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throwIpcError('INTERNAL', 'Appearance operation failed');
  }
}
