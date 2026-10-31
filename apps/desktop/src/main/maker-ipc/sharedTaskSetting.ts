import type { SharedTaskPeerCapture } from '../device-link/sharedTaskDispatch.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** One native setting transaction. Revocation fences admission, not its rollback. */
export function createSharedTaskSettingGuard(
  sharedTask: SharedTaskPeerCapture | undefined,
  sessionId: string,
  transaction: { admitted: boolean },
) {
  return createSharedTaskOperationGuard(sharedTask, sessionId, transaction, 'agent.configure');
}

/** Only for applying an existing host-owned choice, never a guest's setting payload. */
export function createSharedTaskPendingSelectionGuard(
  sharedTask: SharedTaskPeerCapture,
  sessionId: string,
) {
  return createSharedTaskOperationGuard(sharedTask, sessionId, { admitted: false }, 'input.send');
}

function createSharedTaskOperationGuard(
  sharedTask: SharedTaskPeerCapture | undefined,
  sessionId: string,
  transaction: { admitted: boolean },
  operation: 'agent.configure' | 'input.send',
) {
  const assertCurrent = () => {
    if (!transaction.admitted && sharedTask && (sharedTask.author.sessionId !== sessionId ||
        !sharedTask.isCurrent() || !sharedTask.authorize(operation))) {
      throwIpcError('PERMISSION_DENIED', 'SharedTask task access denied');
    }
  };
  return Object.assign(assertCurrent, {
    admit() { assertCurrent(); transaction.admitted = true; },
  });
}
