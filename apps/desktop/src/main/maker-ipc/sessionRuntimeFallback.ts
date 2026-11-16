import { eq } from 'drizzle-orm';
import { effectiveSourceIdForModel } from '@cindy/model-providers';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { withRehydrateCloseSuppressed } from '../maker-host/rehydrateCloseSuppression.js';
import type { getDesktopProviderService as getProviderServiceType } from '../maker-host/createDesktopProviderService.js';
import type { RuntimeFallbackResult } from './botCandidateRecovery.js';
import { hasExplicitSessionTaskModel } from './botDelegationHistory.js';
import { isRemoteModelSwitchRouteChangeError } from './runtimeSetModel.js';
import type { MakerSessionAgentSwitchHandlerDeps } from './sessionAgentSwitchHandler.js';
import { withSendToSessionLock } from './sendToSessionLock.js';
import {
  acceptSessionRuntimeMutation,
  cancelPendingSessionRuntimeMutation,
  captureSessionRuntimeControlOwnerEpoch,
  pickSessionRuntimeFallback,
  recordFailedSessionRuntimeFallbackCandidate,
  sessionRuntimeControlOwnerEpochMatches,
  type SessionRuntimeProfile,
} from './sessionRuntimeControl.js';

type FallbackPick = Parameters<typeof pickSessionRuntimeFallback>[0];

/** The runtime selection a fallback candidate is applied through (the desktop: applySessionRuntimeSelection). */
export type FallbackRuntimeSelection = (
  sessionId: string,
  model: string,
  providerId: string | null | undefined,
  selection: { effort: SessionRuntimeProfile['effort']; fastMode: boolean | 'ultrafast' },
  options: {
    source: 'fallback';
    sessionLockHeld: true;
    expectedGeneration: number;
    previousProfile: SessionRuntimeProfile;
    effortExplicit: boolean;
    fastExplicit: boolean;
  },
) => Promise<{
  deferred: boolean;
  superseded: boolean;
  generation?: number;
  contextWindowConfirmationRequired?: number;
  contextTokensForConfirmation?: number;
}>;

// sessionAgentSwitchHandler.ts loads the desktop's provider service (Electron), so the engine switch is passed in.
type PerformSessionAgentSwitch = typeof import('./sessionAgentSwitchHandler.js').performSessionAgentSwitch;

/** What the automatic runtime fallback reads and acts through (the desktop: register.ts). */
export interface SessionRuntimeFallbackPorts<RuntimeSession extends { agentKind: string; remoteHostId?: string | null }> {
  maker: { getSession(sessionId: string): RuntimeSession | undefined; closeSession(sessionId: string): Promise<void> };
  readSessionRuntimeProfiles(sessionId: string): Promise<{
    effective: SessionRuntimeProfile;
    control: { pending: unknown; generation: number; visitedRoutes: FallbackPick['visitedRoutes']; fallbackHop: number };
  } | null>;
  canApplyAutomaticRuntimeSelection(sessionId: string, generation: number): boolean;
  readBotFallbackCandidate(sessionId: string, current: SessionRuntimeProfile): Promise<{
    isBot: boolean;
    candidate: SessionRuntimeProfile | null;
    routeLocked?: boolean;
  }>;
  readSessionAgentDeviceId(sessionId: string): Promise<string | null | undefined>;
  readSessionRuntimeFallbackSettings(): { enabled: boolean };
  getDesktopProviderService: typeof getProviderServiceType;
  pendingSessionRuntimeFallbackRebuilds: { set(session: RuntimeSession, attemptToken: number): unknown; delete(session: RuntimeSession): unknown };
  applySessionRuntimeSelection: FallbackRuntimeSelection;
  getPendingCredentialSwitchTarget(sessionId: string): { model?: string; providerId?: string | null } | null | undefined;
  clearPendingCredentialSwitchForSession(sessionId: string, options: { wake: false }): void;
  broadcastSessionRuntimeProjection(sessionId: string): Promise<unknown>;
  agentSwitchDeps: MakerSessionAgentSwitchHandlerDeps;
  performSessionAgentSwitch: PerformSessionAgentSwitch;
  runtimeSelectionRequiresModelWindowConfirmation(result: Awaited<ReturnType<FallbackRuntimeSelection>>): boolean;
  log: {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * The automatic runtime fallback an interrupted-turn auto-resume runs first: a Bot moves to its next
 * configured route; an ordinary task, with the user's fallback setting on, moves to another
 * provider's candidate on its second attempt, recorded as a runtime override. Shared by the desktop
 * and the Node Host.
 */
export function createSessionRuntimeFallback<RuntimeSession extends { agentKind: string; remoteHostId?: string | null }>({
  maker, readSessionRuntimeProfiles, canApplyAutomaticRuntimeSelection, readBotFallbackCandidate,
  readSessionAgentDeviceId, readSessionRuntimeFallbackSettings, getDesktopProviderService,
  pendingSessionRuntimeFallbackRebuilds, applySessionRuntimeSelection, getPendingCredentialSwitchTarget,
  clearPendingCredentialSwitchForSession, broadcastSessionRuntimeProjection, agentSwitchDeps, performSessionAgentSwitch,
  runtimeSelectionRequiresModelWindowConfirmation, log,
}: SessionRuntimeFallbackPorts<RuntimeSession>) {
  return async (
    sessionId: string,
    episodeAttempt: number,
    attemptToken: number,
    requireRouteChange = false,
    isCurrent: () => boolean = () => true,
  ): Promise<RuntimeFallbackResult<RuntimeSession>> => {
    const runtimeOwnerEpoch = captureSessionRuntimeControlOwnerEpoch();
    let runtimeSession: RuntimeSession | null = null;
    let blockAutoResumeForModelWindowConfirmation = false;
    try {
      const profiles = await readSessionRuntimeProfiles(sessionId);
      if (!profiles || !isCurrent()) return { session: null, outcome: 'superseded' };
      // A previously accepted Agent/fallback mutation owns the next boundary.
      // Do not let a later infrastructure retry replace that pending intent.
      if (profiles.control.pending ||
          !canApplyAutomaticRuntimeSelection(sessionId, profiles.control.generation)) return { session: null, outcome: 'superseded' };
      // Ordinary delegated tasks have no Bot link. Their explicit creation route
      // still forbids automatic model replacement, while same-route retries remain valid.
      const explicitTaskModel = await hasExplicitSessionTaskModel(sessionId);
      if (!isCurrent()) return { session: null, outcome: 'superseded' };
      if (explicitTaskModel) return { session: null, outcome: requireRouteChange ? 'exhausted' : 'unchanged' };
      // Bot routes are explicit and ordered. They switch on the first recoverable
      // failure and never depend on the generic Session fallback toggle/catalog
      // guesser. Ordinary Sessions keep their existing second-attempt behavior.
      const botFallback = await readBotFallbackCandidate(sessionId, profiles.effective);
      if (!isCurrent()) return { session: null, outcome: 'superseded' };
      let currentForFallback = profiles.effective;
      let candidate = botFallback.candidate;
      if (!botFallback.isBot) {
        if (await readSessionAgentDeviceId(sessionId)) return { session: null, outcome: requireRouteChange ? 'exhausted' : 'unchanged' };
        if (requireRouteChange) return { session: null, outcome: 'exhausted' };
        if (episodeAttempt < 2 || !readSessionRuntimeFallbackSettings().enabled) return { session: null, outcome: 'unchanged' };
        const providers = await getDesktopProviderService().listProviders({
          allowSideEffects: false,
          catalog: getActiveCatalog(),
        });
        currentForFallback =
          profiles.effective.providerId === null
            ? {
                ...profiles.effective,
                providerId: effectiveSourceIdForModel(
                  providers,
                  null,
                  profiles.effective.model,
                  profiles.effective.agentKind,
                ),
              }
            : profiles.effective;
        candidate = pickSessionRuntimeFallback({
            providers,
            current: currentForFallback,
            visitedRoutes: profiles.control.visitedRoutes,
            currentHop: profiles.control.fallbackHop,
            maxHops: 2,
          });
      }
      // A Bot with no other route has nothing to exhaust; the caller decides whether
      // the same route may be retried.
      if (!candidate) return { session: null, outcome: botFallback.routeLocked ? 'unchanged' : 'exhausted' };
      runtimeSession = maker.getSession(sessionId) ?? null;
      if (runtimeSession) {
        pendingSessionRuntimeFallbackRebuilds.set(runtimeSession, attemptToken);
      }
      const recordFailedCandidate = async (
        failed: SessionRuntimeProfile,
      ): Promise<boolean> => {
        let recorded = false;
        try {
          await withSendToSessionLock(sessionId, async () => {
            if (!sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)) return;
            if (!isCurrent()) return;
            const [runtimeStatus] = await getDbClient()
              .drizzle.select({ status: sessions.status })
              .from(sessions)
              .where(eq(sessions.id, sessionId))
              .limit(1);
            if (runtimeStatus?.status !== 'active') return;
            recorded = recordFailedSessionRuntimeFallbackCandidate(
              sessionId,
              profiles.control.generation,
              failed,
            );
          });
        } catch (recordError) {
          log.debug('automatic runtime fallback failed-candidate record skipped', {
            sessionId,
            providerId: failed.providerId,
            model: failed.model,
            error: recordError instanceof Error ? recordError.message : String(recordError),
          });
        }
        return recorded;
      };
      const advanceConfiguredBotRoute = async (
        failed: SessionRuntimeProfile,
      ): Promise<boolean> => {
        if (!await recordFailedCandidate(failed) || !botFallback.isBot) return false;
        const next = await readBotFallbackCandidate(sessionId, currentForFallback);
        candidate = next.candidate;
        return candidate !== null;
      };

      // A configured route can itself be unusable (missing login, unsupported
      // harness on a remote host, disabled provider). Skip such routes inside
      // this one recovery boundary instead of retrying the broken primary and
      // waiting for another user-visible failure before trying route N+1.
      while (candidate) {
        if (!isCurrent()) return { session: runtimeSession, outcome: 'superseded' };
        const selected = candidate;
        const applyCandidate = () => withSendToSessionLock(sessionId, async () => {
          if (!isCurrent() || !sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch) ||
              !canApplyAutomaticRuntimeSelection(sessionId, profiles.control.generation)) {
            return { deferred: false, superseded: true };
          }
          const result = await applySessionRuntimeSelection(
            sessionId,
            selected.model,
            selected.providerId,
            { effort: selected.effort, fastMode: selected.fastMode },
            {
              source: 'fallback',
              sessionLockHeld: true,
              expectedGeneration: profiles.control.generation,
              previousProfile: currentForFallback,
              effortExplicit: false,
              fastExplicit: false,
            },
          );
          if (requireRouteChange && result.deferred && result.generation !== undefined &&
              cancelPendingSessionRuntimeMutation(sessionId, result.generation)) {
            const pendingCredential = getPendingCredentialSwitchTarget(sessionId);
            if (pendingCredential?.model === selected.model &&
                pendingCredential.providerId === selected.providerId) {
              clearPendingCredentialSwitchForSession(sessionId, { wake: false });
            }
            await broadcastSessionRuntimeProjection(sessionId);
          }
          return result;
        });
        if (selected.agentKind !== currentForFallback.agentKind
          || (selected.agentDeviceId ?? null) !== (currentForFallback.agentDeviceId ?? null)) {
          try {
            const result = await withSendToSessionLock(sessionId, async () => {
              if (!isCurrent() || !sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch) ||
                  !canApplyAutomaticRuntimeSelection(sessionId, profiles.control.generation)) return null;
              const switched = await performSessionAgentSwitch(agentSwitchDeps, {
                sessionId,
                targetAgentKind: selected.agentKind,
                agentDeviceId: selected.agentDeviceId ?? null,
                model: selected.model,
                providerId: selected.providerId,
                effort: selected.effort,
                fastMode: selected.fastMode,
                applyNow: true,
              });
              if (switched.switched) {
                acceptSessionRuntimeMutation({
                  sessionId,
                  source: 'fallback',
                  profile: selected,
                  previousProfile: currentForFallback,
                  deferred: false,
                });
              }
              return switched;
            });
            if (!result) return { session: runtimeSession, outcome: 'superseded' };
            if (!result.switched) {
              if (await advanceConfiguredBotRoute(selected)) continue;
              return { session: runtimeSession, outcome: 'exhausted' };
            }
            // The route transaction has already committed, including a new
            // generation. Its failed bootstrap must not resume input or advance
            // candidates using the pre-switch profile/generation captured above.
            if (!result.engineReady) return { session: runtimeSession, outcome: 'failed' };
          } catch (error) {
            if (await advanceConfiguredBotRoute(selected)) continue;
            throw error;
          }
          log.info('automatic Bot runtime fallback switched harness', {
            sessionId,
            episodeAttempt,
            fromAgentKind: currentForFallback.agentKind,
            toAgentKind: selected.agentKind,
            toProviderId: selected.providerId,
            toModel: selected.model,
          });
          return { session: runtimeSession, outcome: 'switched' };
        }
        let result: Awaited<ReturnType<typeof applySessionRuntimeSelection>>;
        try {
          result = await applyCandidate();
        } catch (error) {
          if (
            runtimeSession?.agentKind !== 'claude-code' ||
            !runtimeSession.remoteHostId ||
            !isRemoteModelSwitchRouteChangeError(error)
          ) {
            if (await advanceConfiguredBotRoute(selected)) continue;
            throw error;
          }
          // SSH Claude daemons freeze endpoint/credential env at spawn. The old
          // Session is already registered in pendingSessionRuntimeFallbackRebuilds,
          // so this requested close preserves the exact auto-resume attempt while
          // lazy bootstrap recreates it from the accepted candidate profile.
          log.info('automatic session runtime fallback rebuilding frozen remote route', {
            sessionId,
            episodeAttempt,
            attemptToken,
            remoteHostId: runtimeSession.remoteHostId,
            toProviderId: selected.providerId,
            toModel: selected.model,
          });
          await withRehydrateCloseSuppressed(sessionId, () => maker.closeSession(sessionId));
          try {
            result = await applyCandidate();
          } catch (retryError) {
            if (await advanceConfiguredBotRoute(selected)) continue;
            throw retryError;
          }
        }
        if (runtimeSelectionRequiresModelWindowConfirmation(result)) {
          // Confirmation is a user decision, not a candidate-availability
          // failure, so it must not advance the configured fallback chain.
          blockAutoResumeForModelWindowConfirmation = true;
          throw new Error(
            'automatic model-window confirmation is unsupported; runtime selection was not changed',
          );
        }
        if (result.deferred && requireRouteChange) {
          // The automatic intent was withdrawn inside the route lock above.
          return { session: runtimeSession, outcome: 'failed' };
        }
        log.info('automatic session runtime fallback evaluated', {
          sessionId,
          episodeAttempt,
          attemptToken,
          fromProviderId: currentForFallback.providerId,
          fromModel: currentForFallback.model,
          toProviderId: selected.providerId,
          toModel: selected.model,
          applied: !result.superseded,
        });
        return { session: runtimeSession, outcome: result.superseded ? 'superseded' : 'switched' };
      }
      return { session: runtimeSession, outcome: 'exhausted' };
    } catch (error) {
      log.warn('automatic session runtime fallback skipped after switch failure', {
        sessionId,
        episodeAttempt,
        attemptToken,
        error: error instanceof Error ? error.message : String(error),
      });
      if (blockAutoResumeForModelWindowConfirmation) {
        // Ordinary fallback failures may retry the unchanged runtime. A required
        // confirmation must instead abort auto-resume before it sends again.
        if (runtimeSession) pendingSessionRuntimeFallbackRebuilds.delete(runtimeSession);
        throw error;
      }
      return { session: runtimeSession, outcome: 'failed' };
    }
  };
}
