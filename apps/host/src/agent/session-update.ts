import { eq } from 'drizzle-orm';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { sessions as sessionTable } from '../../../desktop/src/main/localDb/schema.ts';
import { sessionToCamel } from '../../../desktop/src/main/localDb/mapper.ts';
import { applyLiveSessionSettings } from './session-settings.mjs';

type LiveSession = Parameters<typeof applyLiveSessionSettings>[0];

/**
 * The Host's /sessions/update (main.ts wraps it in the task's route lock). A model or provider change
 * is the desktop's set-model (runtime-selection.ts, handleSetModel): a user's pick is an intent until
 * the next send, so the task row and the running Agent keep their route here, and the answer carries
 * the selection's result. The other fields are written here as before (effort and fast mode alone:
 * the pre-release gap list, checkpoint 3b).
 */
export function createHostSessionUpdate(deps: {
  getLiveSession(sessionId: string): LiveSession | null | undefined;
  readSessionForRun(sessionId: string): Promise<{ model?: string | null }>;
  publish(event: Record<string, unknown>): void;
  /** Making the task active again (task-restore.ts), the one Host route for it; it also serves sends. */
  restoreTaskToActive(sessionId: string, options?: { publish?: boolean }): Promise<void>;
  /** A model or provider change: the desktop's set-model, with the desktop IPC's arguments. */
  setModel(sessionId: string, model: unknown, providerId: unknown, revision: unknown, selection: unknown): Promise<unknown>;
}) {
  return async (sessionId: string, patch: Record<string, unknown>) => {
    const allowed: Record<string, true> = {
      title: true, status: true, pinnedAt: true, notificationsMuted: true, model: true,
      effort: true, permissionMode: true, fastMode: true, planModeEnabled: true,
      providerId: true, agentKind: true,
    };
    if (Object.keys(patch).some((key) => allowed[key] !== true)) {
      throw new Error('unsupported session field');
    }
    // A model or provider change (not an engine switch, which the input queue owns): the desktop's
    // set-model. The row keeps its route; the selection lands at the next send.
    let runtimeSelection: unknown;
    const routeChange = patch.agentKind === undefined
      && (typeof patch.model === 'string' || Object.hasOwn(patch, 'providerId'));
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
    // A live Session keeps its own permission mode. Apply the change there first so the stored value
    // and the running Agent cannot disagree (a tighter mode must bind the very next tool call). An
    // engine switch is left to the input queue, which recreates the Session.
    const live = patch.agentKind === undefined ? deps.getLiveSession(sessionId) : undefined;
    await applyLiveSessionSettings(live, patch, null);
    const update: Record<string, unknown> = { updatedAt: Date.now() };
    if (typeof patch.title === 'string') update.title = patch.title;
    // Restoring goes through the shared transaction below; archiving still writes the column (release
    // table: the desktop's archive also checks lanes, recycles the worktree and notifies plugins).
    if (patch.status === 'archived') update.status = patch.status;
    if (patch.pinnedAt === null) update.pinnedAt = null;
    else if (typeof patch.pinnedAt === 'string') update.pinnedAt = Date.parse(patch.pinnedAt) || null;
    if (typeof patch.notificationsMuted === 'boolean') update.notificationsMuted = patch.notificationsMuted;
    if (typeof patch.model === 'string') update.model = patch.model;
    if (typeof patch.effort === 'string') update.effort = patch.effort;
    if (typeof patch.permissionMode === 'string') update.permissionMode = patch.permissionMode;
    if (typeof patch.fastMode === 'boolean' || patch.fastMode === 'ultrafast') update.fastMode = patch.fastMode;
    if (typeof patch.planModeEnabled === 'boolean') update.planModeEnabled = patch.planModeEnabled;
    if (patch.providerId === null || typeof patch.providerId === 'string') update.providerId = patch.providerId;
    if (typeof patch.agentKind === 'string') update.agentKind = patch.agentKind === 'claude-code' ? 'cc' : patch.agentKind;
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
