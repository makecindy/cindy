import type { SessionControlServiceDeps, SessionRuntimeSetResult } from './sessionControlService.js';
import type { createSessionRuntimeProfiles } from './sessionRuntimeProfiles.js';
import type { createBotFallbackCandidateReader } from './botFallbackCandidate.js';
import type { createSessionRuntimeControl } from './sessionRuntimeControl.js';
import { runtimeSelectionRequiresModelWindowConfirmation, type ApplySessionRuntimeSelection } from './sessionRuntimeSelectionTypes.js';
import type { AgentKind } from '@cindy/maker-core';

type RuntimeRequest=Parameters<SessionControlServiceDeps['setSessionRuntime']>[0];
export function createSessionRuntimeManagement(host:Pick<ReturnType<typeof createSessionRuntimeControl>,'mergeSessionRuntimeProfilePatch'|'getSessionRuntimeControlSnapshot'> & {
  getLiveSession:SessionControlServiceDeps['getLiveSession'];
  readCanonicalSessionActivity:SessionControlServiceDeps['getSessionActivitySnapshot'];
  readSessionRuntimeProfiles:ReturnType<typeof createSessionRuntimeProfiles>;
  readBotFallbackCandidate:ReturnType<typeof createBotFallbackCandidateReader>;
  hasExplicitSessionTaskModel(id:string):Promise<boolean>;
  readSessionRuntimeFallbackSettings():{enabled:boolean};
  applySessionRuntimeSelection:ApplySessionRuntimeSelection;
  setHarness(input:Omit<RuntimeRequest,'patch'>&{patch:RuntimeRequest['patch']&{harness:AgentKind}}):Promise<SessionRuntimeSetResult>;
}):Pick<SessionControlServiceDeps,'getSessionRuntimeDetails'|'setSessionRuntime'> {
  const {getLiveSession,readCanonicalSessionActivity,readSessionRuntimeProfiles,readBotFallbackCandidate,hasExplicitSessionTaskModel,readSessionRuntimeFallbackSettings,applySessionRuntimeSelection,mergeSessionRuntimeProfilePatch,getSessionRuntimeControlSnapshot}=host;
  return {
    getSessionRuntimeDetails: async (sessionId) => {
      const profiles = await readSessionRuntimeProfiles(sessionId);
      if (!profiles) throw new Error(`session ${sessionId} not found`);
      const activity = await readCanonicalSessionActivity(sessionId);
      const turnControl = getLiveSession(sessionId)?.getTurnControlSnapshot();
      const botFallback = await readBotFallbackCandidate(sessionId, profiles.effective);
      return {
        ...activity,
        turnGeneration: turnControl?.turnGeneration ?? null,
        gracefulStopState: turnControl?.gracefulStopState ?? 'none',
        runtimeGeneration: profiles.control.generation,
        baselineProfile: profiles.baseline,
        effectiveProfile: profiles.effective,
        pendingMutation: profiles.pendingMutation,
        fallbackEnabled: await hasExplicitSessionTaskModel(sessionId) ? false : botFallback.isBot
          ? botFallback.candidate !== null
          : readSessionRuntimeFallbackSettings().enabled,
      };
    },
    setSessionRuntime: async ({ targetSessionId, expectedGeneration, patch, beforeMutation }) => {
      if (patch.harness !== undefined) return host.setHarness({targetSessionId,expectedGeneration,beforeMutation,patch:{...patch,harness:patch.harness}});
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
      const control = getSessionRuntimeControlSnapshot(targetSessionId);
      return {
        ok: true,
        status: response.deferred ? 'deferred' : 'applied',
        generation: response.generation ?? control.generation,
        effectiveProfile: control.effectiveOverride ?? profiles.effective,
        pendingMutation: control.pending,
      };
    },
  };
}
