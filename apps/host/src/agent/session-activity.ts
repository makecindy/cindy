import { writeSessionListActivity } from '../../../desktop/src/main/localDb/sessionActivityWrite.js';
import { isEndedWriteSuppressed } from '../../../desktop/src/main/localDb/sessionActiveTurn.js';
import type { CurrentDbClientSnapshot } from '../../../desktop/src/main/localDb/client/current.js';
import { createLogger } from '../../../desktop/src/main/logger.js';

const log = createLogger('localDb/sessions');

/**
 * The task list's activity time, as the desktop's touchSessionActivityInDb (localDb/ipc/sessions.ts): the
 * same write (localDb/sessionActivityWrite.ts, only forward), skipped while ended writes are suppressed,
 * owned by the account that started it, and the same patch to the clients ({ lastActivityAt, updatedAt },
 * as broadcastSessionPatched sends it). A failure is logged and swallowed, as there.
 */
export function createHostSessionActivity(deps: {
  getOwner: () => CurrentDbClientSnapshot | null;
  publish: (event: { type: 'session_changed'; sessionId: string; patch: Record<string, string> }) => void;
}): (sessionId: string, atMs?: number, skipActiveGoal?: boolean) => Promise<void> {
  return async (id, atMs = Date.now(), skipActiveGoal = false) => {
    if (isEndedWriteSuppressed()) return;
    const owner = deps.getOwner();
    if (!owner) return;
    try {
      const updated = await writeSessionListActivity(owner.client, id, atMs, skipActiveGoal);
      if (updated[0]?.lastActivityAt != null && deps.getOwner() === owner) {
        deps.publish({ type: 'session_changed', sessionId: id, patch: {
          lastActivityAt: new Date(updated[0].lastActivityAt).toISOString(),
          updatedAt: new Date(updated[0].updatedAt).toISOString(),
        } });
      }
    } catch (error) {
      log.warn('Failed to persist session list activity', { sessionId: id, error: String(error) });
    }
  };
}
