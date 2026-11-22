import { eq } from 'drizzle-orm';
import { INDEFINITE_SNOOZE_UNTIL } from '@cindy/maker-shared/live-task-priority';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { sessions as sessionTable } from '../../../desktop/src/main/localDb/schema.ts';
import { sessionPatchToRow, sessionToCamel } from '../../../desktop/src/main/localDb/mapper.ts';
import type { DbClient } from '../../../desktop/src/main/localDb/client/DbClient.ts';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';
import { assertSessionContextWindowBudgetPatch } from '../../../desktop/src/main/localDb/sessionContextWindowBudgetPatch.js';
import { isSessionSettingsOnlyPatch } from '../../../desktop/src/main/localDb/sessionSettingsOnlyPatch.ts';
import { touchRecentWorkdir } from '../../../desktop/src/main/localDb/ipc/recentWorkdirsCore.ts';
import { cleanupSessionRuntimeForTerminalStatus } from '../../../desktop/src/main/localDb/sessionRuntimeCleanup.ts';
import {
  assertReviewSessionPatchAllowed,
  assertSessionWorkspaceKindPatch,
  normalizeSessionWorkingDirPatch,
  prepareSessionWorkingDirMove,
  recordRecentWorkdirForMove,
  relocateClaudeTranscriptsForMove,
  withSessionWorkingDirMoveLocks,
  type SessionWorktreeBindingLookup,
} from '../../../desktop/src/main/localDb/ipc/sessionWorkingDirMove.ts';
import { explicitPorts } from './explicit-ports.ts';

/** The fields this entry writes; anything else is INVALID_PARAMS, naming the fields. */
const UPDATABLE_FIELDS = new Set(['title', 'status', 'pinnedAt', 'notificationsMuted', 'model', 'providerId', 'contextWindowBudget',
  'workingDir', 'workspaceKind', 'snoozedUntil']);
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
 * carries the selection's result. A task's context window budget is the desktop's own path (its budget
 * chip saves through local-db:sessions:update, updateSessionInDb): the same range check, then
 * persistSessionFields (persistSessionFieldsWith with the budget hook). As updateSessionInDb, a missing
 * task is NOT_FOUND before anything is written, and a budget that cannot be saved fails a budget-only
 * update but only drops the budget from a mixed one. Moving a task to another working directory or to a
 * dialogue runs the desktop's own move steps (sessionWorkingDirMove.ts, moved from updateSessionInDb) at
 * the places updateSessionInDb runs them: the route and worktree locks around everything (inside the
 * route lock main.ts already holds, re-entered), the workspaceKind check, the stored form of the
 * directory, the Review task check (for the whole patch, as the desktop), the worktree ownership guard
 * and closing an idle Pi/Codex runtime, the Claude transcript move, and the recent project record. The
 * patch they change in place (the stored directory, a resume id the transcript move persisted) is the
 * one published. The other fields are written here.
 */
export function createHostSessionUpdate(deps: {
  /** The session settings write with the budget hook (runtime-selection.ts persistSessionFields). */
  persistSessionFields(sessionId: string, patch: Record<string, unknown>): Promise<void>;
  publish(event: Record<string, unknown>): void;
  /** Making the task active again (task-restore.ts), the one Host route for it; it also serves sends. */
  restoreTaskToActive(sessionId: string, options?: { publish?: boolean }): Promise<void>;
  /** A model or provider change: the desktop's set-model, with the desktop IPC's arguments. */
  setModel(sessionId: string, model: unknown, providerId: unknown, revision: unknown, selection: unknown): Promise<unknown>;
  /** The working-directory move's ports (session-move.ts). */
  move: {
    /** The desktop's worktree registry, read only. */
    lookupSessionWorktreeBinding: SessionWorktreeBindingLookup;
    /** Refuse a busy task. Non-Claude tasks release executor state even after losing their live handle. */
    closeIdleSessionForMove(sessionId: string, storedAgentKind: string): Promise<boolean>;
    /** The desktop's local-db:recent-workdirs:changed. */
    broadcastRecentWorkdirsChanged(path: string): void;
  };
}) {
  // Runs inside the move locks (below), as updateSessionInDb's `update`.
  const applyUpdate = async (sessionId: string, patch: Record<string, unknown>, fields: string[], dbClient: DbClient) => {
    const db = dbClient.drizzle;
    assertSessionWorkspaceKindPatch(patch);
    assertSessionContextWindowBudgetPatch(patch);
    normalizeSessionWorkingDirPatch(patch);
    await assertReviewSessionPatchAllowed({ db, sid: sessionId, p: patch });
    const beforeMove = await prepareSessionWorkingDirMove(explicitPorts<Parameters<typeof prepareSessionWorkingDirMove>[0]>({
      db, sid: sessionId, p: patch,
      moveGuard: undefined, // see the entry below
      opts: explicitPorts<Parameters<typeof prepareSessionWorkingDirMove>[0]['opts']>({
        closeIdleSessionForMove: deps.move.closeIdleSessionForMove,
      }),
      sessionWorktreeBindingLookup: deps.move.lookupSessionWorktreeBinding,
    }));
    // As updateSessionInDb, at the same place: a patch of settings only (a title, a pin, a mute, a move, a
    // model) leaves updatedAt alone; a status change moves it.
    const isSettingsOnly = isSessionSettingsOnlyPatch(patch);
    const hasBudget = patch.contextWindowBudget !== undefined;
    const budgetOnly = fields.length > 0 && fields.every(key => key === 'contextWindowBudget');
    if (hasBudget) {
      // updateSessionInDb answers a missing task NOT_FOUND before it writes the budget; persistSessionFields
      // alone would write the preference (the known difference, release table section 2).
      const [target] = await getDbClient().drizzle.select({ id: sessionTable.id }).from(sessionTable)
        .where(eq(sessionTable.id, sessionId)).limit(1);
      if (!target) throwIpcError('NOT_FOUND', 'Session 不存在');
    }
    // A model or provider change: the desktop's set-model. The row keeps its route; the selection
    // lands at the next send.
    let runtimeSelection: unknown;
    const routeChange = typeof patch.model === 'string' || Object.hasOwn(patch, 'providerId');
    if (routeChange) {
      const [before] = await getDbClient().drizzle.select({ model: sessionTable.model }).from(sessionTable)
        .where(eq(sessionTable.id, sessionId)).limit(1);
      if (!before) throwIpcError('NOT_FOUND', 'Session 不存在');
      runtimeSelection = await deps.setModel(sessionId, typeof patch.model === 'string' ? patch.model : before.model,
        Object.hasOwn(patch, 'providerId') ? patch.providerId : undefined, undefined, undefined);
      patch = { ...patch };
      delete patch.model;
      delete patch.providerId;
    }
    const budget = hasBudget ? patch.contextWindowBudget : undefined;
    if (hasBudget) {
      patch = { ...patch };
      delete patch.contextWindowBudget;
    }
    // A budget-only update writes no row (the budget is a preference, not a column), as updateSessionInDb.
    if (budgetOnly) {
      await deps.persistSessionFields(sessionId, { contextWindowBudget: budget });
      const [row] = await getDbClient().drizzle.select().from(sessionTable).where(eq(sessionTable.id, sessionId)).limit(1);
      if (!row) throwIpcError('NOT_FOUND', 'Session 不存在');
      return sessionToCamel({ ...row, messageCount: 0 });
    }
    // The moved fields through the desktop's mapper (a move to a project or a dialogue drops the explicit
    // project), with a resume id the Claude transcript move persisted.
    const setObj = sessionPatchToRow({
      workingDir: patch.workingDir,
      workspaceKind: patch.workspaceKind,
      snoozedUntil: patch.status === 'active' ? undefined : patch.snoozedUntil,
      // The shared mapper clears both snooze fields on archive. Restore uses the transaction below.
      status: patch.status === 'archived' ? 'archived' : undefined,
    } as Parameters<typeof sessionPatchToRow>[0], { bumpUpdatedAt: false });
    await relocateClaudeTranscriptsForMove(explicitPorts<Parameters<typeof relocateClaudeTranscriptsForMove>[0]>({
      sid: sessionId, p: patch, beforeMove,
      moveGuard: undefined, // see the entry below
      dbClient, setObj,
    }));
    const update: Record<string, unknown> = { ...(isSettingsOnly ? {} : { updatedAt: Date.now() }), ...setObj };
    if (typeof patch.title === 'string') update.title = patch.title;
    if (patch.pinnedAt === null) update.pinnedAt = null;
    else if (typeof patch.pinnedAt === 'string') update.pinnedAt = Date.parse(patch.pinnedAt) || null;
    if (typeof patch.notificationsMuted === 'boolean') update.notificationsMuted = patch.notificationsMuted;
    // As writeSessionPatch: nothing to write is no write (a model pick alone is an intent, not a column).
    if (Object.keys(update).length > 0) {
      await getDbClient().drizzle.update(sessionTable).set(update).where(eq(sessionTable.id, sessionId));
    }
    // As the desktop's patchSessionMetaInDb: the other fields first, then the status transaction. The
    // event below carries the whole patch, so the restore does not publish its own.
    if (patch.status === 'active') await deps.restoreTaskToActive(sessionId, { publish: false });
    const rows = await getDbClient().drizzle.select().from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    const row = rows[0];
    if (!row) throwIpcError('NOT_FOUND', 'Session 不存在');
    // As patchSessionMetaInDb, under the task's route lock (main.ts): an archive clears the task's runtime
    // override and axes (the runtime cleanup bindHostSessionRuntimeHooks installs); other statuses do nothing.
    cleanupSessionRuntimeForTerminalStatus(sessionId, patch.status);
    await recordRecentWorkdirForMove({
      projectTargetChanged: patch.workspaceKind !== undefined || patch.workingDir !== undefined,
      row, dbClient, ownerScope: null,
      touchRecentWorkdir,
      broadcastRecentWorkdirsChanged: path => deps.move.broadcastRecentWorkdirsChanged(path),
    });
    // As updateSessionInDb's broadcast: the project the mapper dropped goes out with the move.
    const published = setObj.projectDir !== undefined ? { ...patch, projectDir: row.projectDir } : patch;
    const result = sessionToCamel({ ...row, messageCount: 0 });
    const snooze = patch.snoozedUntil !== undefined || patch.status === 'active' || patch.status === 'archived'
      ? { snoozedUntil: result.snoozedUntil, snoozedAt: result.snoozedAt } : {};
    deps.publish({ type: 'session_changed', action: 'update', sessionId, patch: { ...published, ...snooze }, status: row.status });
    if (hasBudget) {
      // A mixed update keeps its other fields when the budget cannot be saved (updateSessionInDb).
      try {
        await deps.persistSessionFields(sessionId, { contextWindowBudget: budget });
      } catch (error) {
        console.warn('[sessions] write context window budget failed; row update already applied', {
          sessionId, error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { ...result, ...(routeChange ? { runtimeSelection } : {}) };
  };
  return async (sessionId: string, patch: Record<string, unknown>) => {
    const fields = Object.keys(patch);
    const unknown = fields.filter(key => !UPDATABLE_FIELDS.has(key) && !Object.hasOwn(DEDICATED_ENTRIES, key));
    if (unknown.length > 0) throwIpcError('INVALID_PARAMS', `unsupported session field: ${unknown.join(', ')}`);
    const dedicated = fields.filter(key => Object.hasOwn(DEDICATED_ENTRIES, key));
    if (dedicated.length > 0) {
      throwIpcError('UNSUPPORTED_CAPABILITY', dedicated
        .map(key => `${key} must be changed through ${DEDICATED_ENTRIES[key]}`).join('; '));
    }
    // The same date validation as desktop updateSessionInDb, before any row or other setting changes.
    const snoozedUntil = patch.snoozedUntil;
    if (snoozedUntil !== undefined && snoozedUntil !== null && snoozedUntil !== INDEFINITE_SNOOZE_UNTIL) {
      const ms = typeof snoozedUntil === 'string' ? Date.parse(snoozedUntil) : NaN;
      if (!Number.isFinite(ms) || ms <= Date.now() || ms > Date.now() + 366 * 86_400_000) {
        throwIpcError('INVALID_PARAMS', 'snoozedUntil must be a future ISO timestamp within one year');
      }
    }
    const dbClient = getDbClient();
    // As updateSessionInDb: a working-directory change runs under the task's route lock and its worktree
    // locks (re-entering the route lock main.ts holds); anything else runs at once.
    return withSessionWorkingDirMoveLocks(explicitPorts<Parameters<typeof withSessionWorkingDirMoveLocks>[0]>({
      sid: sessionId, p: patch,
      // The desktop's MCP move tool's guard (updateSessionInDb's moveGuard); the Host has no MCP move tool
      // (host-tools.ts creates the MCP providers without moveSession).
      moveGuard: undefined,
      db: dbClient.drizzle,
      update: () => applyUpdate(sessionId, patch, fields, dbClient),
    }));
  };
}
