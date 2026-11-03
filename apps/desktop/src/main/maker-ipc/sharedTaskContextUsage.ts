import type { SharedTaskPeerCapture } from '../device-link/sharedTaskDispatch.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** A context query can lazily start an Agent; its configuration is host-owned. */
export function createSharedTaskContextUsageGuard(
  sharedTask: SharedTaskPeerCapture | undefined,
  sessionId: string,
) {
  const assertCurrent = () => {
    if (sharedTask && (sharedTask.author.sessionId !== sessionId || !sharedTask.isCurrent() ||
        !sharedTask.authorize('history.read'))) {
      throwIpcError('PERMISSION_DENIED', 'SharedTask task access denied');
    }
  };
  return {
    assertCurrent,
    async resolveCreateOpts<T>(wireOptions: unknown, readHostOptions: () => Promise<T>): Promise<unknown> {
      assertCurrent();
      if (!sharedTask) return wireOptions;
      // Do not inspect or spread even one field of a guest's bootstrap options.
      const hostOptions = await readHostOptions();
      assertCurrent();
      return hostOptions;
    },
  };
}
