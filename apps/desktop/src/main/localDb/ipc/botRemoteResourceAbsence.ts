import { isIpcError } from '../../../shared/ipc-errors.js';

/**
 * One companion deleted between the id scan and its read is an ordinary absence.
 * It must not fail the whole roster as INTERNAL for every other device.
 * Any other error still fails the roster.
 */
export async function collectPresentBotRemoteResourceSources<T>(
  ids: readonly string[],
  read: (id: string) => Promise<T>,
  beforeEach?: () => void,
): Promise<T[]> {
  const sources: T[] = [];
  for (const id of ids) {
    beforeEach?.();
    try {
      sources.push(await read(id));
    } catch (error) {
      if (!isIpcError(error) || error.code !== 'NOT_FOUND') throw error;
    }
  }
  return sources;
}
