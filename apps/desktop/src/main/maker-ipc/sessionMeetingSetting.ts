import type { SessionMeetingPeerCapture } from '../device-link/sessionMeetingDispatch.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** One native setting transaction. Revocation fences admission, not its rollback. */
export function createSessionMeetingSettingGuard(
  meeting: SessionMeetingPeerCapture | undefined,
  sessionId: string,
  transaction: { admitted: boolean },
) {
  const assertCurrent = () => {
    if (!transaction.admitted && meeting && (meeting.author.sessionId !== sessionId ||
        !meeting.isCurrent() || !meeting.authorize('agent.configure'))) {
      throwIpcError('PERMISSION_DENIED', 'Meeting task access denied');
    }
  };
  return Object.assign(assertCurrent, {
    admit() { assertCurrent(); transaction.admitted = true; },
  });
}
