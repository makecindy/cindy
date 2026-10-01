import type { SharedTaskPeerCapture } from '../device-link/sharedTaskDispatch.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** One native setting transaction. Revocation fences admission, not its rollback. */
export function createSharedTaskSettingGuard(
  sharedTask: SharedTaskPeerCapture | undefined,
  sessionId: string,
  transaction: { admitted: boolean },
) {
  const assertCurrent = () => {
    if (!transaction.admitted && sharedTask && (sharedTask.author.sessionId !== sessionId ||
        !sharedTask.isCurrent() || !sharedTask.authorize('agent.configure'))) {
      throwIpcError('PERMISSION_DENIED', 'SharedTask task access denied');
    }
  };
  return Object.assign(assertCurrent, {
    admit() { assertCurrent(); transaction.admitted = true; },
  });
}
