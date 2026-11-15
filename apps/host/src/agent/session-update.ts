import { eq } from 'drizzle-orm';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { sessions as sessionTable } from '../../../desktop/src/main/localDb/schema.ts';
import { sessionToCamel } from '../../../desktop/src/main/localDb/mapper.ts';
import { dbToMakerAgentKind } from '../../../desktop/src/shared/agentKindConversion.js';
import { applyLiveSessionSettings } from './session-settings.mjs';
import { assertModelSwitchWindow, type ModelSwitchLiveRuntime } from './model-window-gate.ts';

type LiveSession = ModelSwitchLiveRuntime & Parameters<typeof applyLiveSessionSettings>[0];

/**
 * The Host's /sessions/update (main.ts wraps it in the task's route lock). A model or provider
 * change first passes the window gate (model-window-gate.ts): a change the desktop would refuse
 * from a Device Link client is refused before the running Agent, the task row or anything else
 * changes.
 */
export function createHostSessionUpdate(deps: {
  getLiveSession(sessionId: string): LiveSession | null | undefined;
  readSessionForRun(sessionId: string): Promise<{ model?: string | null }>;
  publish(event: Record<string, unknown>): void;
  /** The configured window of a route, with the task's window budget (agent graph). */
  modelWindow?(): {
    resolveRouteWindow(agentKind: string, modelId: string, providerId: string | null, budget: number | null): number | null;
    readSessionBudget(sessionId: string): Promise<number | null>;
  } | null;
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
    // A live Session keeps its own permission mode and model route. Apply the
    // change there first so the stored value and the running Agent cannot
    // disagree (a tighter mode must bind the very next tool call). An engine
    // switch is left to the input queue, which recreates the Session.
    const live = patch.agentKind === undefined ? deps.getLiveSession(sessionId) : undefined;
    if (patch.agentKind === undefined && (typeof patch.model === 'string' || Object.hasOwn(patch, 'providerId'))) {
      const [before] = await getDbClient().drizzle.select().from(sessionTable)
        .where(eq(sessionTable.id, sessionId)).limit(1);
      if (!before) throw new Error('session not found');
      const window = deps.modelWindow?.() ?? null;
      const budget = window ? await window.readSessionBudget(sessionId) : null;
      await assertModelSwitchWindow({
        agentKind: dbToMakerAgentKind(before.agentKind),
        live: live ?? null,
        stored: { model: before.model ?? null, providerId: before.providerId ?? null, contextTokens: before.contextTokens ?? null },
        target: {
          model: typeof patch.model === 'string' ? patch.model : (live?.model ?? before.model ?? ''),
          providerId: Object.hasOwn(patch, 'providerId') ? (patch.providerId as string | null) : (before.providerId ?? null),
        },
        ...(window ? {
          resolveRouteWindow: (agentKind: string, modelId: string, providerId: string | null) =>
            window.resolveRouteWindow(agentKind, modelId, providerId, budget),
        } : {}),
      });
    }
    const stored = live && patch.model === undefined && Object.hasOwn(patch, 'providerId')
      ? await deps.readSessionForRun(sessionId) : null;
    await applyLiveSessionSettings(live, patch, stored);
    const update: Record<string, unknown> = { updatedAt: Date.now() };
    if (typeof patch.title === 'string') update.title = patch.title;
    if (patch.status === 'active' || patch.status === 'archived') update.status = patch.status;
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
    const rows = await getDbClient().drizzle.select().from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    const row = rows[0];
    if (!row) throw new Error('session not found');
    deps.publish({ type: 'session_changed', action: 'update', sessionId, patch, status: row.status });
    return sessionToCamel({ ...row, messageCount: 0 });
  };
}
