/**
 * What a model change reads and runs around the send-time landing, moved verbatim out of register.ts so
 * the Node Host runs the same steps: the same-engine pick an intent lands as (selectSameAgentModel of
 * the agent switch deps), whether an automatic selection may apply (canApplyAutomaticRuntimeSelection),
 * a task's runtime profiles (readSessionRuntimeProfiles) and the recovery of a renamed model before a
 * send (recoverRenamedSessionModelOnSend). register.ts calls each factory where it defined the piece and
 * binds the ports.
 *
 * - applySessionRuntimeSelection stays late-bound: register.ts assigns it after the agent switch deps,
 *   so its port is a function register.ts reads at call time.
 * - handleSetModel and readSessionRuntimeProfiles come in by value: register.ts defined both before it
 *   assigned recoverRenamedSessionModelOnSend.
 */
import type { Maker } from '@cindy/maker-core';
import { eq } from 'drizzle-orm';
import { dbToMakerAgentKind, isPluginEngineKind } from '../../shared/agentKindConversion.js';
import { hasBuiltinAgentKind } from '../maker-host/engineKind.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { getSessionEffort, getSessionFastMode } from '../maker-host/session-effort-store.js';
import { getSessionProvider, hasSessionProvider } from '../maker-host/session-provider-store.js';
import type { Logger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { recoverRenamedSessionModelBeforeSend } from './renamedSessionModelRecovery';
import type { MakerSessionAgentSwitchHandlerDeps, PendingAgentSwitchRegistry } from './sessionAgentSwitchHandler.js';
import {
  getSessionRuntimeControlSnapshot,
  sessionRuntimeGenerationMatches,
  type SessionRuntimeProfile,
} from './sessionRuntimeControl.js';
import { pendingHarnessRuntimeMutation } from './sessionRuntimeHarnessSelection.js';
import type { ApplySessionRuntimeSelection, createHandleSetModel } from './sessionRuntimeSelectionApply.js';

/** register.ts's selectSameAgentModel of the agent switch deps. */
export function createSelectSameAgentModel(ports: {
  /** Read at call time: register.ts assigns it after the agent switch deps. */
  applySessionRuntimeSelection: ApplySessionRuntimeSelection;
}): NonNullable<MakerSessionAgentSwitchHandlerDeps['selectSameAgentModel']> {
  const { applySessionRuntimeSelection } = ports;
  return async (sessionId, intent, applyNow, assertSelectionCurrent, beforeMutation, pendingSelectionAccess, nextInputChars) => {
    const result = await applySessionRuntimeSelection(sessionId, intent.model, intent.providerId, {
      effort: (intent.effort ?? null) as SessionRuntimeProfile['effort'],
      fastMode: intent.fastMode ?? false,
      ...(intent.thinking !== undefined ? { thinking: intent.thinking } : {}),
      // 只有 Agent 在另一台电脑运行的任务会在意图里带确认过的目标窗口。
      // Preserve the exact window acknowledged by the picker until send.
      ...(intent.confirmedContextWindow ? { confirmedContextWindow: intent.confirmedContextWindow } : {}),
    }, { source: 'user', sessionLockHeld: true, applyingUserSelectionOnSend: applyNow,
      runtimeSource: intent.runtimeSource, configStaged: intent.configStaged === true,
      ...(intent.preserveModelGroupBinding === true ? { preserveModelGroupBinding: true } : {}),
      ...(intent.modelGroupPickedKey ? { modelGroupPickedKey: intent.modelGroupPickedKey } : {}),
      ...(intent.routeChangeAttribution ? { routeChangeAttribution: intent.routeChangeAttribution } : {}),
      credentialSelectionAxes: intent.credentialSelectionAxes ?? {
        effort: !intent.configStaged && intent.effort !== undefined,
        fastMode: !intent.configStaged && intent.fastMode !== undefined,
      },
      deviceLinkModelSelectionOrigin: intent.deviceLinkModelSelectionOrigin,
      nextInputChars, assertSelectionCurrent, beforeMutation, pendingSelectionAccess });
    if (result.contextWindowConfirmationRequired !== undefined) {
      throwIpcError('PRECONDITION_FAILED', 'Model context window changed or was unknown; select the model again to confirm');
    }
    return result;
  };
}

/** register.ts's canApplyAutomaticRuntimeSelection. */
export function createCanApplyAutomaticRuntimeSelection(ports: {
  agentSwitchPending: PendingAgentSwitchRegistry;
}): (sessionId: string, expectedGeneration?: number) => boolean {
  const { agentSwitchPending } = ports;
  const canApplyAutomaticRuntimeSelection = (sessionId: string, expectedGeneration?: number): boolean =>
    !agentSwitchPending.get(sessionId) &&
    sessionRuntimeGenerationMatches(sessionId, expectedGeneration);
  return canApplyAutomaticRuntimeSelection;
}

/** register.ts's readSessionRuntimeProfiles. */
export function createReadSessionRuntimeProfiles(ports: {
  maker: Pick<Maker, 'getSessionMeta' | 'getSession'>;
  agentSwitchPending: PendingAgentSwitchRegistry;
  log: Logger;
}) {
  const { maker, agentSwitchPending, log } = ports;
  const readSessionRuntimeProfiles = async (sessionId: string) => {
    const meta = await maker.getSessionMeta(sessionId);
    // Plugin-engine tasks have no catalog runtime profile; their model lives on the task row.
    if (!meta || !hasBuiltinAgentKind(meta)) return null;
    let baseline: SessionRuntimeProfile = {
      agentDeviceId: null,
      agentKind: meta.agentKind,
      model: meta.model,
      providerId: null,
      effort: meta.effort ?? null,
      fastMode: (meta.fastMode === 'ultrafast' ? 'ultrafast' : meta.fastMode === true),
    };
    try {
      const [row] = await getDbClient()
        .drizzle.select({
          agentKind: sessions.agentKind,
          agentDeviceId: sessions.agentDeviceId,
          model: sessions.model,
          providerId: sessions.providerId,
          effort: sessions.effort,
          fastMode: sessions.fastMode,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (row) {
        baseline = {
          agentKind: dbToMakerAgentKind(row.agentKind),
          agentDeviceId: row.agentDeviceId ?? null,
          model: row.model,
          providerId: row.providerId?.trim() || null,
          effort: row.effort,
          fastMode: (row.fastMode === 'ultrafast' ? 'ultrafast' : row.fastMode === true),
        };
      }
    } catch (error) {
      log.debug('session runtime baseline lookup failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const control = getSessionRuntimeControlSnapshot(sessionId);
    const live = maker.getSession(sessionId);
    const effective: SessionRuntimeProfile = control.effectiveOverride
      ? {
          ...control.effectiveOverride,
          agentDeviceId: control.effectiveOverride.agentDeviceId ?? baseline.agentDeviceId ?? null,
        }
      : {
          agentDeviceId: baseline.agentDeviceId ?? null,
          agentKind: live && hasBuiltinAgentKind(live) ? live.agentKind : meta.agentKind,
          model: live?.model ?? meta.model,
          providerId: hasSessionProvider(sessionId)
            ? getSessionProvider(sessionId)
            : baseline.providerId,
          effort:
            (getSessionEffort(sessionId) as SessionRuntimeProfile['effort']) ?? meta.effort ?? null,
          fastMode: live ? getSessionFastMode(sessionId) : (meta.fastMode ?? false),
        };
    const pendingMutation = pendingHarnessRuntimeMutation(agentSwitchPending.get(sessionId), control.generation, effective.agentDeviceId)
      ?? control.pending;
    return { baseline, effective, control, pendingMutation };
  };
  return readSessionRuntimeProfiles;
}

/** register.ts's recoverRenamedSessionModelOnSend. */
export function createRecoverRenamedSessionModelOnSend(ports: {
  agentSwitchPending: PendingAgentSwitchRegistry;
  getDesktopProviderService: () => Pick<ReturnType<typeof import('../maker-host/createDesktopProviderService.js').getDesktopProviderService>, 'listProviders'>;
  readSessionRuntimeProfiles: ReturnType<typeof createReadSessionRuntimeProfiles>;
  handleSetModel: ReturnType<typeof createHandleSetModel>;
}): (sessionId: string) => Promise<void> {
  const { agentSwitchPending, getDesktopProviderService, readSessionRuntimeProfiles, handleSetModel } = ports;
  return async (sessionId) => {
    if (agentSwitchPending.get(sessionId)) return;
    const [row] = await getDbClient().drizzle.select({
      status: sessions.status,
      model: sessions.model,
      providerId: sessions.providerId,
      agentKind: sessions.agentKind,
      remoteHostId: sessions.remoteHostId,
      agentDeviceId: sessions.agentDeviceId,
      effort: sessions.effort,
      fastMode: sessions.fastMode,
    }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!row || row.status !== 'active' || !row.providerId ||
        row.remoteHostId || row.agentDeviceId || isPluginEngineKind(row.agentKind)) return;
    const providers = await getDesktopProviderService().listProviders({
      allowSideEffects: false,
      catalog: getActiveCatalog(),
    });
    const profiles = await readSessionRuntimeProfiles(sessionId);
    await recoverRenamedSessionModelBeforeSend({
      route: { ...row, agentKind: dbToMakerAgentKind(row.agentKind) },
      effectiveRoute: profiles?.effective ?? null,
      hasPendingSelection: !!agentSwitchPending.get(sessionId) || !!profiles?.pendingMutation,
      providers,
      apply: (model, providerId) => handleSetModel(
        sessionId, model, providerId, undefined,
        { effort: row.effort as SessionRuntimeProfile['effort'], fastMode: row.fastMode },
        {
          source: 'agent', sessionLockHeld: true, applyingUserSelectionOnSend: true,
          persistRenamedSessionModel: true,
          expectedGeneration: getSessionRuntimeControlSnapshot(sessionId).generation,
        },
      ),
    });
  };
}
