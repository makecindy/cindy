import { isIpcError } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Convert settings persist failures to a stable IPC error that cannot leak filesystem paths. */
export function rethrowChatEmbeddingPersistError(error: unknown, message: string): never {
  if (isIpcError(error)) throw error;
  throwIpcError('INTERNAL', message);
}
