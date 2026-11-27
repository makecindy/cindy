import { eq } from 'drizzle-orm';
import { sessions } from '../../../desktop/src/main/localDb/schema.ts';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { noteSessionsRestoring, setSessionRestoreObserver } from '../../../desktop/src/main/localDb/sessionRestoreRetention.ts';
import { recordTaskArchiveRestores } from '../../../desktop/src/main/task-management/restoreObserver.ts';
import { restoreArchivedTaskForSend } from '../../../desktop/src/main/localDb/archivedTaskRestore.ts';

type Publish = (event: Record<string, unknown>) => void;

/**
 * Making an archived task active again, on the Host. The desktop restores through the active branch
 * of `patchSessionMetaInDb` (localDb/ipc/sessions.ts); the Host keeps its three steps that decide
 * the result:
 * 1. `noteSessionsRestoring`: the shared retention observer records when the task came back
 *    (bindTaskRestoreRetention, installed by main.ts as the desktop's task management does);
 * 2. the database transaction `sessions.setStatus` to active, which refuses a deleted task and a
 *    teammate's own lane and detaches a group lane, as on the desktop;
 * 3. the change is published to clients.
 * Agent Island and the native thread archive sync are not on the Host.
 *
 * Both Host routes to an active task use it: sending to an archived task (the send transaction's
 * `restoreArchivedSessionForSend`) and the task list's restore (`/sessions/update`).
 */
/**
 * The restore observer the desktop's task management installs (task-management/service.ts): before a
 * task is made active, record when, in the owner's task management file the desktop reads. The Host runs
 * no idle archiving; the desktop does when it opens this profile itself, and keeps a task restored here
 * for its retention days instead of archiving it again. Returns the uninstall.
 */
export function bindTaskRestoreRetention(): () => void {
  setSessionRestoreObserver(recordTaskArchiveRestores);
  return () => setSessionRestoreObserver(null);
}

export function createHostTaskRestore(deps: { getOwner(): unknown; publish: Publish; isHeldForDesktop?(): boolean }) {
  async function restoreTaskToActive(
    sessionId: string,
    options: { signal?: AbortSignal; publish?: boolean } = {},
  ): Promise<void> {
    const owner = deps.getOwner();
    const database = getDbClient();
    const assertCurrent = () => {
      if (deps.getOwner() !== owner || getDbClient() !== database) {
        throw Object.assign(new Error('Task owner changed'), { code: 'PRECONDITION_FAILED' });
      }
      if (options.signal?.aborted) {
        throw Object.assign(new Error('Session send aborted'), { code: 'PRECONDITION_FAILED' });
      }
    };
    await noteSessionsRestoring([sessionId], database.drizzle);
    assertCurrent();
    await database.tx('sessions.setStatus', { sessionIds: [sessionId], status: 'active' });
    if (options.publish !== false && deps.getOwner() === owner) {
      deps.publish({ type: 'session_changed', action: 'update', sessionId,
        patch: { status: 'active', snoozedUntil: null, snoozedAt: null, archivedAt: null }, status: 'active' });
    }
  }

  function requireActiveDuringHold(id: string): boolean {
    if (!deps.isHeldForDesktop?.()) return false;
    const row = getDbClient().drizzle.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, id)).get();
    if (row?.status !== 'active') {
      throwIpcError('PRECONDITION_FAILED', 'The interrupted turn cannot resume while its task is inactive and the profile is held');
    }
    return true;
  }

  return {
    restoreTaskToActive,
    /**
     * The send transaction's port, as the desktop passes it: the restore takes the task's route lock
     * (the Host installs the send lock as that bridge in main.ts, as the desktop's registerAll does),
     * re-entrantly when the send already holds it; context recovery's replay does not hold it.
     */
    async restoreArchivedSessionForSend(sessionId: string) {
      if (requireActiveDuringHold(sessionId)) return;
      await restoreArchivedTaskForSend(sessionId, {}, {
        async patchSessionMetaInDb(id, _patch, options) {
          if (!requireActiveDuringHold(id)) await restoreTaskToActive(id, { signal: options.signal });
        },
        captureOwnerScope: () => deps.getOwner(),
        isOwnerScopeCurrent: owner => owner === deps.getOwner(),
      });
    },
  };
}
