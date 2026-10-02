import { localSessionHost } from './localHost.js';
import { openSession, type OpenedSessionRow } from '../localDb/sessionOpening.js';
import { createSessionController, sessionOperation } from './controller.js';
import { requireSessionCaller } from './callerContext.js';

/** Record creation keeps the existing atomic companion/plugin persistence callback.
 * Runtime creation is deliberately not implied by this operation.
 */
export function createSessionRecord<T = void>(
  input: Parameters<typeof openSession>[0],
  commit?: (row: OpenedSessionRow, assertCurrent: () => void) => Promise<T>,
): Promise<{ row: OpenedSessionRow; value: T }> {
  const controller = createSessionController(localSessionHost, {
    createRecord: sessionOperation({
      operation: 'createRecord', targets: () => [],
      execute: () => openSession(input, commit),
    }),
  });
  return controller.invoke(controller.issueCaller(requireSessionCaller()), 'createRecord');
}
