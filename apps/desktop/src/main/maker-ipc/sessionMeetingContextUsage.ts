import type { SessionMeetingPeerCapture } from '../device-link/sessionMeetingDispatch.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** A context query can lazily start an Agent; its configuration is host-owned. */
export function createSessionMeetingContextUsageGuard(
  meeting: SessionMeetingPeerCapture | undefined,
  sessionId: string,
) {
  const assertCurrent = () => {
    if (meeting && (meeting.author.sessionId !== sessionId || !meeting.isCurrent() ||
        !meeting.authorize('history.read'))) {
      throwIpcError('PERMISSION_DENIED', 'Meeting task access denied');
    }
  };
  return {
    assertCurrent,
    async resolveCreateOpts<T>(wireOptions: unknown, readHostOptions: () => Promise<T>): Promise<unknown> {
      assertCurrent();
      if (!meeting) return wireOptions;
      // Do not inspect or spread even one field of a guest's bootstrap options.
      const hostOptions = await readHostOptions();
      assertCurrent();
      return hostOptions;
    },
  };
}
