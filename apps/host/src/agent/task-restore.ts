import { getDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { noteSessionsRestoring } from '../../../desktop/src/main/localDb/sessionRestoreRetention.ts';
import { restoreArchivedTaskForSend } from '../../../desktop/src/main/localDb/archivedTaskRestore.ts';

type Publish = (event: Record<string, unknown>) => void;

/**
 * Making an archived task active again, on the Host. The desktop restores through the active branch
 * of `patchSessionMetaInDb` (localDb/ipc/sessions.ts); the Host keeps its three steps that decide
 * the result:
 * 1. `noteSessionsRestoring` (the shared retention observer; the desktop's task management installs
 *    it, the Host installs none);
 * 2. the database transaction `sessions.setStatus` to active, which refuses a deleted task and a
 *    teammate's own lane and detaches a group lane, as on the desktop;
 * 3. the change is published to clients.
 * Agent Island and the native thread archive sync are not on the Host.
 *
 * Both Host routes to an active task use it: sending to an archived task (the send transaction's
 * `restoreArchivedSessionForSend`) and the task list's restore (`/sessions/update`).
 */
export function createHostTaskRestore(deps: { getOwner(): unknown; publish: Publish }) {
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
      deps.publish({ type: 'session_changed', action: 'update', sessionId, patch: { status: 'active' }, status: 'active' });
    }
  }

  return {
    restoreTaskToActive,
    /**
     * The send transaction's port, as the desktop passes it: the restore takes the task's route lock
     * (the Host installs the send lock as that bridge in main.ts, as the desktop's registerAll does),
     * re-entrantly when the send already holds it; context recovery's replay does not hold it.
     */
    restoreArchivedSessionForSend: (sessionId: string) => restoreArchivedTaskForSend(sessionId, {}, {
      patchSessionMetaInDb: (id, _patch, options) => restoreTaskToActive(id, { signal: options.signal }),
      captureOwnerScope: () => deps.getOwner(),
      isOwnerScopeCurrent: owner => owner === deps.getOwner(),
    }),
  };
}
