import { eq } from 'drizzle-orm';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { sessions as sessionTable } from '../../../desktop/src/main/localDb/schema.ts';
import { sessionToCamel } from '../../../desktop/src/main/localDb/mapper.ts';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';

/** The fields this entry writes; anything else is INVALID_PARAMS, naming the fields. */
const UPDATABLE_FIELDS = new Set(['title', 'status', 'pinnedAt', 'notificationsMuted', 'model', 'providerId']);
/**
 * Runtime settings with their own entry, which runs the desktop's handler (runtime-selection.ts). This
 * entry refuses them, as the desktop's updateSessionInDb refuses directory grants (UNSUPPORTED_CAPABILITY
 * naming the entry): a second path here would be a second implementation of the same setting (release
 * table, section 2).
 */
const DEDICATED_ENTRIES: Record<string, string> = {
  effort: '/api/sessions/set-effort (maker:set-effort)',
  fastMode: '/api/sessions/set-fast-mode (maker:set-fast-mode)',
  permissionMode: '/api/sessions/set-permission-mode (maker:set-permission-mode)',
  planModeEnabled: '/api/sessions/set-plan-mode (maker:set-plan-mode)',
};

/**
 * The Host's /sessions/update (main.ts wraps it in the task's route lock). The patch is checked before
 * anything is read or changed, and refused whole: a field this entry does not write is INVALID_PARAMS,
 * a runtime setting with its own entry is UNSUPPORTED_CAPABILITY naming that entry. A model or provider
 * change is the desktop's set-model (runtime-selection.ts, handleSetModel): a user's pick is an intent
 * until the next send, so the task row and the running Agent keep their route here, and the answer
 * carries the selection's result. The other fields are written here.
 */
export function createHostSessionUpdate(deps: {
  readSessionForRun(sessionId: string): Promise<{ model?: string | null }>;
  publish(event: Record<string, unknown>): void;
  /** Making the task active again (task-restore.ts), the one Host route for it; it also serves sends. */
  restoreTaskToActive(sessionId: string, options?: { publish?: boolean }): Promise<void>;
  /** A model or provider change: the desktop's set-model, with the desktop IPC's arguments. */
  setModel(sessionId: string, model: unknown, providerId: unknown, revision: unknown, selection: unknown): Promise<unknown>;
}) {
  return async (sessionId: string, patch: Record<string, unknown>) => {
    const fields = Object.keys(patch);
    const unknown = fields.filter(key => !UPDATABLE_FIELDS.has(key) && !Object.hasOwn(DEDICATED_ENTRIES, key));
    if (unknown.length > 0) throwIpcError('INVALID_PARAMS', `unsupported session field: ${unknown.join(', ')}`);
    const dedicated = fields.filter(key => Object.hasOwn(DEDICATED_ENTRIES, key));
    if (dedicated.length > 0) {
      throwIpcError('UNSUPPORTED_CAPABILITY', dedicated
        .map(key => `${key} must be changed through ${DEDICATED_ENTRIES[key]}`).join('; '));
    }
    // A model or provider change: the desktop's set-model. The row keeps its route; the selection
    // lands at the next send.
    let runtimeSelection: unknown;
    const routeChange = typeof patch.model === 'string' || Object.hasOwn(patch, 'providerId');
    if (routeChange) {
      const [before] = await getDbClient().drizzle.select({ model: sessionTable.model }).from(sessionTable)
        .where(eq(sessionTable.id, sessionId)).limit(1);
      if (!before) throw new Error('session not found');
      runtimeSelection = await deps.setModel(sessionId, typeof patch.model === 'string' ? patch.model : before.model,
        Object.hasOwn(patch, 'providerId') ? patch.providerId : undefined, undefined, undefined);
      patch = { ...patch };
      delete patch.model;
      delete patch.providerId;
    }
    const update: Record<string, unknown> = { updatedAt: Date.now() };
    if (typeof patch.title === 'string') update.title = patch.title;
    // Restoring goes through the shared transaction below; archiving still writes the column (release
    // table: the desktop's archive also checks lanes, recycles the worktree and notifies plugins).
    if (patch.status === 'archived') update.status = patch.status;
    if (patch.pinnedAt === null) update.pinnedAt = null;
    else if (typeof patch.pinnedAt === 'string') update.pinnedAt = Date.parse(patch.pinnedAt) || null;
    if (typeof patch.notificationsMuted === 'boolean') update.notificationsMuted = patch.notificationsMuted;
    await getDbClient().drizzle.update(sessionTable).set(update).where(eq(sessionTable.id, sessionId));
    // As the desktop's patchSessionMetaInDb: the other fields first, then the status transaction. The
    // event below carries the whole patch, so the restore does not publish its own.
    if (patch.status === 'active') await deps.restoreTaskToActive(sessionId, { publish: false });
    const rows = await getDbClient().drizzle.select().from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    const row = rows[0];
    if (!row) throw new Error('session not found');
    deps.publish({ type: 'session_changed', action: 'update', sessionId, patch, status: row.status });
    return { ...sessionToCamel({ ...row, messageCount: 0 }), ...(routeChange ? { runtimeSelection } : {}) };
  };
}
