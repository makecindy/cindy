import { effectiveSourceIdForModel, findCatalogModel } from '@cindy/model-providers';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { withSendToSessionLock } from './sendToSessionLock.js';
import { performSessionAgentSwitch } from './sessionAgentSwitchHandler.js';
import type { SessionControlServiceDeps } from './sessionControlService.js';
import { captureSessionRuntimeControlOwnerEpoch, getSessionRuntimeControlSnapshot,
  mergeSessionRuntimeProfilePatch, resolveSessionRuntimeAxes } from './sessionRuntimeControl.js';
import type { ReadUsableAgentDeviceProviders } from './sessionRuntimeAxisSettings.js';
import { setSessionRuntimeHarness, stagedSelectionProfile } from './sessionRuntimeHarnessSelection.js';
import type { ApplySessionRuntimeSelection, SessionRuntimeSelectionPorts } from './sessionRuntimeSelectionApply.js';
import type { createReadSessionRuntimeProfiles } from './sessionRuntimeSelectionLanding.js';

type RuntimeRoutePorts = Pick<SessionRuntimeSelectionPorts,
  'agentSwitchPending' | 'agentSwitchDeps' | 'assertModelRouteUsable' | 'getDesktopProviderService'
  | 'reconcileBotModelRoute' | 'updateScheduledPreference'> & {
  readSessionRuntimeProfiles: ReturnType<typeof createReadSessionRuntimeProfiles>;
  readUsableAgentDeviceProviders: ReadUsableAgentDeviceProviders;
  shouldApplyExclusiveProviderRerouteLive: typeof import('../maker-host/model-route-guard-live.js').shouldApplyExclusiveProviderRerouteLive;
  applySessionRuntimeSelection: ApplySessionRuntimeSelection;
  runtimeSelectionRequiresModelWindowConfirmation: (result: Awaited<ReturnType<ApplySessionRuntimeSelection>>) => boolean;
};

/** The runtime writer of the session control service. The selection function is bound lazily
 * because register.ts replaces its startup implementation after assembling this service. */
export function createSessionControlRuntimeWriter(ports: RuntimeRoutePorts): SessionControlServiceDeps['setSessionRuntime'] {
  const { agentSwitchPending, agentSwitchDeps, assertModelRouteUsable, getDesktopProviderService,
    reconcileBotModelRoute, updateScheduledPreference, readSessionRuntimeProfiles, readUsableAgentDeviceProviders,
    shouldApplyExclusiveProviderRerouteLive, applySessionRuntimeSelection, runtimeSelectionRequiresModelWindowConfirmation } = ports;
  return async ({ targetSessionId, expectedGeneration, patch, beforeMutation }) => {
    // A deliberate model choice becomes the task's own, like a choice in the composer:
    // an earlier automation's saved route must not restore over it on the next run.
    const keepAsTaskChoice = async <T extends { ok: boolean }>(result: T): Promise<T> => {
      if (result.ok) {
        await updateScheduledPreference(targetSessionId, null).catch(() => false);
        await reconcileBotModelRoute.acceptTaskChoice(targetSessionId).catch(() => {});
      }
      return result;
    };
    // A selection staged for the next send (by the user's picker or a complete agent selection)
    // owns the next route boundary; the turn-end override path would only be superseded by it.
    // Revise that selection instead, as choosing again in the picker does.
    const revisesStagedSelection = patch.harness === undefined && patch.agentDeviceId === undefined &&
      stagedSelectionProfile(agentSwitchPending.get(targetSessionId)) !== null;
    if (patch.harness !== undefined || patch.agentDeviceId !== undefined || revisesStagedSelection) {
      const harness = patch.harness ?? (revisesStagedSelection
        ? undefined
        : (await readSessionRuntimeProfiles(targetSessionId))?.effective.agentKind);
      if (!harness && !revisesStagedSelection) {
        return { ok: false, errorCode: 'NOT_FOUND', message: 'Task runtime is unavailable' };
      }
      return keepAsTaskChoice(await setSessionRuntimeHarness({
        withSessionLock: withSendToSessionLock,
        ownerEpoch: captureSessionRuntimeControlOwnerEpoch,
        generation: (id) => getSessionRuntimeControlSnapshot(id).generation,
        pendingRevision: (id) => agentSwitchPending.revision!(id),
        pending: (id) => agentSwitchPending.get(id),
        read: async (id) => (await readSessionRuntimeProfiles(id))?.effective ?? null,
        resolve: async (profile, explicit) => {
          const reroute = profile.agentDeviceId ? undefined
            : await assertModelRouteUsable(profile.agentKind, profile.model, profile.providerId);
          const providers = profile.agentDeviceId
            ? await readUsableAgentDeviceProviders(profile.agentDeviceId, profile.agentKind, profile.model, profile.providerId)
            : await getDesktopProviderService().listProviders({ allowSideEffects: false, catalog: getActiveCatalog() });
          const providerId = reroute && shouldApplyExclusiveProviderRerouteLive(profile.providerId)
            ? reroute
            : profile.providerId ?? effectiveSourceIdForModel(providers, null, profile.model, profile.agentKind);
          const provider = providers.find((candidate) => candidate.id === providerId);
          const model = findCatalogModel(provider, profile.model, profile.agentKind, { exact: true });
          if (!provider?.connected || !model) {
            throwIpcError('INVALID_PARAMS', `model "${profile.model}" is unavailable for harness "${profile.agentKind}"`);
          }
          const axes = resolveSessionRuntimeAxes({
            model, effort: profile.effort, fastMode: profile.fastMode,
            effortExplicit: explicit.effort, fastExplicit: explicit.fast,
          });
          if (!axes.ok) throwIpcError('INVALID_PARAMS', `target model runtime axes unavailable: ${axes.reason}`);
          return { ...profile, providerId: providerId ?? null, effort: axes.effort, fastMode: axes.fastMode };
        },
        stage: async (id, profile, assertSelectionCurrent, beforeMutation, source) => {
          return performSessionAgentSwitch(agentSwitchDeps, {
            sessionId: id, targetAgentKind: profile.agentKind, model: profile.model,
            providerId: profile.providerId, effort: profile.effort, fastMode: profile.fastMode,
            ...(profile.agentDeviceId !== undefined ? { agentDeviceId: profile.agentDeviceId } : {}),
            runtimeSource: source === 'user' ? undefined : 'agent', assertSelectionCurrent, beforeMutation,
          });
        },
      }, { targetSessionId, expectedGeneration, beforeMutation,
        patch: { ...patch, ...(harness !== undefined ? { harness } : {}) } }));
    }
    const profiles = await readSessionRuntimeProfiles(targetSessionId);
    if (beforeMutation) await beforeMutation();
    if (!profiles) {
      return {
        ok: false,
        errorCode: 'NOT_FOUND',
        message: `session ${targetSessionId} not found`,
      };
    }
    const routeExplicit = patch.model !== undefined || patch.providerId !== undefined;
    const mergeBase = routeExplicit
      ? (profiles.control.pending?.profile ?? profiles.effective)
      : profiles.effective;
    const next = mergeSessionRuntimeProfilePatch(mergeBase, patch);
    let response: Awaited<ReturnType<typeof applySessionRuntimeSelection>>;
    try {
      response = await applySessionRuntimeSelection(
        targetSessionId,
        next.model,
        next.providerId,
        { effort: next.effort, fastMode: next.fastMode },
        {
          source: 'agent',
          beforeMutation,
          expectedGeneration,
          deferWhileRunning: true,
          effectiveProfile: profiles.effective,
          effortExplicit: patch.effort !== undefined,
          fastExplicit: patch.fastMode !== undefined,
          routeExplicit,
        },
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (
        code === 'INVALID_PARAMS' ||
        code === 'CREDENTIAL_SWITCH_BUSY' ||
        code === 'REMOTE_MODEL_SWITCH_ROUTE_CHANGE' ||
        code === 'REMOTE_PROVIDER_UPDATING' ||
        code === 'REMOTE_PROVIDER_UNSUPPORTED' ||
        code === 'REMOTE_NATIVE_OAUTH_UNAVAILABLE'
      ) {
        return {
          ok: false,
          errorCode: 'ROUTE_UNAVAILABLE',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    }
    if (response.superseded) {
      return {
        ok: false,
        errorCode: 'CONFLICT',
        message: `session runtime generation changed; read it again before retrying`,
      };
    }
    if (runtimeSelectionRequiresModelWindowConfirmation(response)) {
      return {
        ok: false,
        errorCode: 'ROUTE_UNAVAILABLE',
        message: 'model-window confirmation is required; runtime selection was not changed',
      };
    }
    await keepAsTaskChoice({ ok: true });
    const control = getSessionRuntimeControlSnapshot(targetSessionId);
    return {
      ok: true,
      status: response.deferred ? 'deferred' : 'applied',
      generation: response.generation ?? control.generation,
      effectiveProfile: control.effectiveOverride ?? profiles.effective,
      pendingMutation: control.pending,
    };
  };
}
