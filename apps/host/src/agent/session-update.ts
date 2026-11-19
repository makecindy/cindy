import { eq } from 'drizzle-orm';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { sessions as sessionTable } from '../../../desktop/src/main/localDb/schema.ts';
import { sessionToCamel } from '../../../desktop/src/main/localDb/mapper.ts';
import { dbToMakerAgentKind } from '../../../desktop/src/shared/agentKindConversion.js';
import { applyLiveSessionSettings } from './session-settings.mjs';
import { assessRuntimeModelSwitchGate } from '../../../desktop/src/shared/runtimeModelSwitchGate.ts';
import { shouldRebuildForModelWindowSwitch, type createContextOverflowRollover } from '../../../desktop/src/main/maker-ipc/contextOverflowRollover.ts';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';
import { MODEL_WINDOW_REBUILD_UNSUPPORTED, modelSwitchGateInput, type ModelSwitchLiveRuntime } from './model-window-gate.ts';

type ModelWindowPreparation = ReturnType<typeof createContextOverflowRollover>['prepareModelWindowSwitch'];

export interface HostModelSelectionApply {
  prepareModelWindowSwitch: ModelWindowPreparation;
  assertCurrent(): void;
  signal?: AbortSignal;
  nextInputChars?: number;
}

type LiveSession = ModelSwitchLiveRuntime & Parameters<typeof applyLiveSessionSettings>[0];

/**
 * The Host's session update under the task's route lock. Only the send path can pass an
 * owner selection for application. Ordinary HTTP updates keep the original window gate.
 */
export function createHostSessionUpdate(deps: {
  getLiveSession(sessionId: string): LiveSession | null | undefined;
  closeRejectedPiRuntime?(sessionId: string, runtime: LiveSession): Promise<void>;
  readSessionForRun(sessionId: string): Promise<{ model?: string | null }>;
  publish(event: Record<string, unknown>): void;
  /** The configured window of a route, with the task's window budget (agent graph). */
  modelWindow?(): {
    resolveRouteWindow(agentKind: string, modelId: string, providerId: string | null, budget: number | null, verification?: 'required'): number | null;
    readSessionBudget(sessionId: string): Promise<number | null>;
  } | null;
}) {
  return async (
    sessionId: string,
    patch: Record<string, unknown>,
    apply?: HostModelSelectionApply,
    assertCurrent = apply?.assertCurrent,
  ) => {
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
    let routeRebuilt = false;
    let liveModelApplied = false;
    if (patch.agentKind === undefined && (typeof patch.model === 'string' || Object.hasOwn(patch, 'providerId'))) {
      const [before] = await getDbClient().drizzle.select().from(sessionTable)
        .where(eq(sessionTable.id, sessionId)).limit(1);
      if (!before) throw new Error('session not found');
      const window = deps.modelWindow?.() ?? null;
      const budget = window ? await window.readSessionBudget(sessionId) : null;
      const target = {
        model: typeof patch.model === 'string' ? patch.model : (live?.model ?? before.model ?? ''),
        providerId: Object.hasOwn(patch, 'providerId') ? (patch.providerId as string | null) : before.providerId,
      };
      const windowInput = await modelSwitchGateInput({
        agentKind: dbToMakerAgentKind(before.agentKind),
        live: live ?? null,
        stored: { model: before.model, providerId: before.providerId, contextTokens: before.contextTokens },
        target,
        ...(window ? {
          resolveRouteWindow: (agentKind: string, modelId: string, providerId: string | null) =>
            window.resolveRouteWindow(agentKind, modelId, providerId, budget, apply ? 'required' : undefined),
        } : {}),
      });
      assertCurrent?.();
      const legacyGate = assessRuntimeModelSwitchGate(windowInput);
      if (apply && before.sdkSessionId && windowInput.runtimeRouteChanged && windowInput.agentKind !== 'codex') {
        if (before.remoteHostId) throwIpcError('PRECONDITION_FAILED', MODEL_WINDOW_REBUILD_UNSUPPORTED);
        if (live?.isTurnRunning?.()) throwIpcError('PRECONDITION_FAILED', 'the agent is still working; change the model after this turn');
        let contextWindow = windowInput.verifiedTargetWindow;
        const currentContextWindow = windowInput.verifiedCurrentWindow;
        const needsProtection = !windowInput.contextTokensKnown || windowInput.contextTokens > 0;
        const piNeedsFinalWindow = windowInput.agentKind === 'pi' && needsProtection;
        if (piNeedsFinalWindow && (!windowInput.piCanVerifyLiveWindow || !live || !deps.closeRejectedPiRuntime)) {
          throwIpcError('PRECONDITION_FAILED', 'Pi final context window could not be verified; runtime selection was not changed');
        }
        if (needsProtection && (!windowInput.contextTokensKnown || !currentContextWindow || !contextWindow)) {
          throwIpcError('PRECONDITION_FAILED', 'target context window or current usage could not be verified; runtime selection was not changed');
        }
        try {
          if (piNeedsFinalWindow && live) {
            // Pi's preview never certifies a different route. setModel reads native get_state
            // before resolving. Keep the old DB route until that final window is checked.
            liveModelApplied = true;
            await applyLiveSessionSettings(live, patch, before);
            apply.assertCurrent();
            const finalWindow = live.getUsageSnapshot?.()?.contextWindow;
            if (!finalWindow || !Number.isFinite(finalWindow) || finalWindow <= 0) {
              throwIpcError('PRECONDITION_FAILED', 'Pi final context window could not be verified; runtime selection was not changed');
            }
            contextWindow = contextWindow ? Math.min(contextWindow, finalWindow) : finalWindow;
          }
          if (contextWindow && currentContextWindow && shouldRebuildForModelWindowSwitch({
            contextTokens: windowInput.contextTokens,
            currentContextWindow,
            targetContextWindow: contextWindow,
          })) {
            const prepared = await apply.prepareModelWindowSwitch(sessionId, {
              contextWindow,
              verifiedHandoffWindow: contextWindow,
              nextInputChars: apply.nextInputChars,
              recheckTargetPressure: true,
              confirmedTargetPressure: true,
              replacementRoute: {
                ...target,
                effort: typeof patch.effort === 'string' ? patch.effort : before.effort,
                fastMode: patch.fastMode === true || patch.fastMode === false || patch.fastMode === 'ultrafast'
                  ? patch.fastMode : (before.fastMode ?? false),
              },
              signal: apply.signal,
              assertCanCommit: apply.assertCurrent,
            });
            if (prepared !== 'not-needed' && prepared !== 'rebuilt') {
              throwIpcError('PRECONDITION_FAILED', `model window preparation failed (${prepared}); runtime selection was not changed`);
            }
            routeRebuilt = prepared === 'rebuilt';
          }
        } catch (error) {
          if (liveModelApplied && live) await deps.closeRejectedPiRuntime?.(sessionId, live);
          throw error;
        }
      } else if (legacyGate.reject === 'remote-shrink-rebuild') {
        throwIpcError('PRECONDITION_FAILED', MODEL_WINDOW_REBUILD_UNSUPPORTED);
      }
    }
    const stored = live && patch.model === undefined && Object.hasOwn(patch, 'providerId')
      ? await deps.readSessionForRun(sessionId) : null;
    assertCurrent?.();
    if (!routeRebuilt && !liveModelApplied) await applyLiveSessionSettings(live, patch, stored);
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
    // Context recovery committed the entire replacement route in context.rebuild.
    if (!routeRebuilt) {
      try {
        assertCurrent?.();
        await getDbClient().drizzle.update(sessionTable).set(update).where(eq(sessionTable.id, sessionId));
      } catch (error) {
        if (liveModelApplied && live) await deps.closeRejectedPiRuntime?.(sessionId, live);
        throw error;
      }
    }
    const rows = await getDbClient().drizzle.select().from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    const row = rows[0];
    if (!row) throw new Error('session not found');
    deps.publish({ type: 'session_changed', action: 'update', sessionId, patch, status: row.status });
    return sessionToCamel({ ...row, messageCount: 0 });
  };
}
