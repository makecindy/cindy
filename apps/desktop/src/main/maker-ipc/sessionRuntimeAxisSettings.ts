/**
 * Changing a task's reasoning effort, Fast mode or thinking while it runs, moved verbatim out of
 * register.ts so the Node Host runs the same steps: the SET_EFFORT, SET_FAST_MODE and
 * SET_THINKING_ENABLED handlers' bodies after their sender check, and the closures with logic they use (a pending pick's axis staging, the scheduled
 * preference's axis update, the recovery of a remote axis write). register.ts keeps each IPC
 * registration and its sender check (assertTrustedAppRendererEvent, before anything else) and calls the
 * moved body; it calls each factory where it defined the piece and binds the ports.
 *
 * - pendingCredentialSwitchHolder is register.ts's module-level holder: its port is a getter, called
 *   where the body read the holder, so the body reads it at the same point as before, line for line,
 *   without relying on how often register.ts assigns it (the one changed line of the effort and Fast
 *   bodies).
 */
import type { AgentKind, ProviderView } from '@cindy/model-providers';
import { effectiveSourceIdForModel, findCatalogModel, supportsSubscriptionFastPolicy } from '@cindy/model-providers';
import type { Maker } from '@cindy/maker-core';
import { eq } from 'drizzle-orm';
import { isIpcError } from '../../shared/ipc-errors.js';
import { parseScheduledModelBaseline } from '../../shared/scheduledModelBaseline';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import type { Logger } from '../logger.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { withRehydrateCloseSuppressed } from '../maker-host/rehydrateCloseSuppression.js';
import { setSessionEffort, setSessionFastMode } from '../maker-host/session-effort-store.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { PendingCredentialSwitchService } from './pendingCredentialSwitch.js';
import { commitRuntimeAxisAfterPersistence } from './runtimeSelectionAxes.js';
import { applyRuntimeEffortWithRecovery } from './runtimeSetEffort.js';
import type { ScheduledModelSelection } from './scheduledModelSelection';
import { withSendToSessionLock } from './sendToSessionLock.js';
import {
  isUserPendingAgentSwitchIntent,
  projectPendingAgentSwitchIntent,
  type MakerSessionAgentSwitchHandlerDeps,
  type PendingAgentSwitchIntent,
  type PendingAgentSwitchRegistry,
} from './sessionAgentSwitchHandler.js';
import {
  captureSessionRuntimeControlOwnerEpoch,
  recordRecoveredSessionRuntimeAxisMutation,
  recordUserSessionRuntimeAxisMutation,
  resolveSessionRuntimeAxes,
  sessionRuntimeControlOwnerEpochMatches,
  type SessionRuntimeAxisPatch,
  type SessionRuntimeProfile,
} from './sessionRuntimeControl.js';
import type { createUpdateScheduledPreference } from './sessionRuntimeProjection.js';
import type { createResolvePendingRuntimeAxisPatch } from './pendingRuntimeAxisPatch.js';
import type { createReadSessionRuntimeProfiles } from './sessionRuntimeSelectionLanding.js';
import type { createSharedTaskSettingGuard } from './sharedTaskSetting.js';

/** register.ts's readUsableAgentDeviceProviders (an Agent on another computer). */
export type ReadUsableAgentDeviceProviders = (
  deviceId: string,
  agent: AgentKind,
  model: string,
  providerId: string | null,
  unavailableCode?: 'MODEL_SELECTION_UNAVAILABLE',
) => Promise<ProviderView[]>;
type ProviderListing = () => Pick<ReturnType<typeof import('../maker-host/createDesktopProviderService.js').getDesktopProviderService>, 'listProviders'>;
type PersistSessionFields = typeof import('../localDb/ipc/sessions.js').persistSessionFields;

/** register.ts's updateSavedScheduledAxis. */
export function createUpdateSavedScheduledAxis(ports: {
  readUsableAgentDeviceProviders: ReadUsableAgentDeviceProviders;
  updateScheduledPreference: ReturnType<typeof createUpdateScheduledPreference>;
  getDesktopProviderService: ProviderListing;
}) {
  const { readUsableAgentDeviceProviders, updateScheduledPreference, getDesktopProviderService } = ports;
  const updateSavedScheduledAxis = async (
    sessionId: string,
    patch: { effort?: ScheduledModelSelection['effort']; fastMode?: ScheduledModelSelection['fastMode'] },
    assertCurrent: () => void,
  ): Promise<boolean> => {
    const [row] = await getDbClient().drizzle.select({ baseline: sessions.scheduledModelBaseline })
      .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    const baseline = parseScheduledModelBaseline(row?.baseline);
    if (!baseline) return false;
    const providers = baseline.agentDeviceId
      ? await readUsableAgentDeviceProviders(baseline.agentDeviceId, baseline.agentKind, baseline.model, baseline.providerId)
      : await getDesktopProviderService().listProviders({
        allowSideEffects: false, catalog: getActiveCatalog(),
      });
    const providerId = baseline.providerId ??
      effectiveSourceIdForModel(providers, null, baseline.model, baseline.agentKind);
    const model = findCatalogModel(providers.find(p => p.id === providerId),
      baseline.model, baseline.agentKind, { exact: true });
    if (!model) throwIpcError('INVALID_PARAMS', `model "${baseline.model}" is unavailable`);
    const axes = resolveSessionRuntimeAxes({
      model, effort: patch.effort ?? baseline.effort,
      fastMode: patch.fastMode ?? baseline.fastMode,
      effortExplicit: patch.effort !== undefined, fastExplicit: patch.fastMode !== undefined,
      allowFixedEffortPlaceholder: true,
    });
    if (!axes.ok) throwIpcError('INVALID_PARAMS', `setting is unavailable for model "${baseline.model}"`);
    assertCurrent();
    // The picker describes the owner's next turn, not the automation currently running.
    await updateScheduledPreference(sessionId, patch);
    return true;
  };
  return updateSavedScheduledAxis;
}

/** register.ts's recoverRemoteRuntimeAxisPersistence. */
export function createRecoverRemoteRuntimeAxisPersistence(ports: {
  maker: Pick<Maker, 'getSession' | 'closeSession'>;
  broadcastSessionRuntimeProjection: (sessionId: string, baselineOverride?: SessionRuntimeProfile) => Promise<void>;
  log: Logger;
}) {
  const { maker, broadcastSessionRuntimeProjection, log } = ports;
  const recoverRemoteRuntimeAxisPersistence = async (
    sessionId: string,
    previousProfile: SessionRuntimeProfile,
    patch: Pick<Partial<SessionRuntimeProfile>, 'effort' | 'fastMode'>,
    runtimeOwnerEpoch: string,
  ): Promise<void> => {
    if (!sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)) return;
    try {
      await withRehydrateCloseSuppressed(sessionId, () => maker.closeSession(sessionId));
    } catch (recoveryError) {
      if (!sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)) return;
      const retainedSession = maker.getSession(sessionId);
      if (retainedSession) {
        const retainedProfile: SessionRuntimeProfile = {
          ...previousProfile,
          agentKind: retainedSession.agentKind,
          model: retainedSession.model,
          ...patch,
        };
        if (patch.effort !== undefined) {
          setSessionEffort(sessionId, patch.effort);
        }
        if (patch.fastMode !== undefined) {
          setSessionFastMode(sessionId, patch.fastMode);
        }
        recordRecoveredSessionRuntimeAxisMutation(sessionId, retainedProfile);
        await broadcastSessionRuntimeProjection(sessionId).catch((error) => {
          log.debug('recovered runtime axis projection broadcast failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      throw recoveryError;
    }
  };
  return recoverRemoteRuntimeAxisPersistence;
}

/** register.ts's stagePendingUserRuntimeAxis. */
export function createStagePendingUserRuntimeAxis(ports: {
  agentSwitchDeps: MakerSessionAgentSwitchHandlerDeps;
  readUsableAgentDeviceProviders: ReadUsableAgentDeviceProviders;
  agentSwitchPending: PendingAgentSwitchRegistry;
  getDesktopProviderService: ProviderListing;
  persistSessionFields: PersistSessionFields;
  wakeSessionInputAfterCredentialSwitch: (sessionId: string) => void;
}) {
  const {
    agentSwitchDeps, readUsableAgentDeviceProviders, agentSwitchPending, getDesktopProviderService,
    persistSessionFields, wakeSessionInputAfterCredentialSwitch,
  } = ports;
  const stagePendingUserRuntimeAxis = async (
    sessionId: string,
    intent: PendingAgentSwitchIntent,
    patch: Pick<PendingAgentSwitchIntent, 'effort' | 'fastMode'>,
    assertCurrent: () => void,
  ) => {
    let updated = { ...intent, ...patch };
    const row = await agentSwitchDeps.getSessionRow(sessionId);
    if (!row) throwIpcError('PRECONDITION_FAILED', 'session is unavailable during runtime axis update');
    const targetDeviceId = intent.targetAgentDeviceId === undefined
      ? row.agentDeviceId : intent.targetAgentDeviceId;
    // Local same-engine selection already validates in SET_MODEL. Its remote
    // branch only checks route availability, so admit its axes here as well.
    if (!intent.sameAgentSelection || targetDeviceId) {
      const providers = targetDeviceId
        ? await readUsableAgentDeviceProviders(targetDeviceId, intent.targetAgentKind, intent.model, intent.providerId ?? null)
        : await getDesktopProviderService().listProviders({ allowSideEffects: false, catalog: getActiveCatalog() });
      const providerId = intent.providerId ?? effectiveSourceIdForModel(providers, null, intent.model, intent.targetAgentKind);
      const provider = providers.find(candidate => candidate.id === providerId);
      const model = findCatalogModel(provider, intent.model, intent.targetAgentKind, { exact: true });
      if (!provider?.connected || !model) {
        throwIpcError('INVALID_PARAMS', `model "${intent.model}" is unavailable from provider "${providerId ?? 'default'}"`);
      }
      const axes = resolveSessionRuntimeAxes({
        model,
        effort: (updated.effort ?? null) as SessionRuntimeProfile['effort'],
        fastMode: updated.fastMode ?? false,
        effortExplicit: patch.effort !== undefined,
        fastExplicit: patch.fastMode !== undefined,
        allowFixedEffortPlaceholder: true,
      });
      if (!axes.ok) {
        throwIpcError('INVALID_PARAMS', axes.reason === 'effort-unavailable'
          ? `effort "${patch.effort}" is unavailable for model "${intent.model}"`
          : `Fast is unavailable for model "${intent.model}"`);
      }
      updated = { ...updated, effort: axes.effort ?? undefined, fastMode: axes.fastMode };
    }
    // Row/catalog reads can cross an account/shared-task ownership change.
    assertCurrent();
    // Recovery is a post-commit tail: its target route already owns the DB
    // fields and the next bootstrap reads them. The tail itself only repairs
    // the resume boundary/handoff, so it cannot consume newly staged axes.
    if (intent.resumeFallbackRecovery) {
      await persistSessionFields(sessionId, { effort: updated.effort, fastMode: updated.fastMode });
      assertCurrent();
    }
    if (intent.sameAgentSelection) {
      return agentSwitchDeps.selectSameAgentModel!(sessionId, updated, false);
    }
    agentSwitchPending.set(sessionId, updated);
    agentSwitchDeps.onPendingSwitchChanged?.(sessionId, projectPendingAgentSwitchIntent(updated));
    wakeSessionInputAfterCredentialSwitch(sessionId);
    return { deferred: true, pendingUntilSend: true };
  };
  return stagePendingUserRuntimeAxis;
}

/** register.ts's SET_EFFORT handler body, after its sender check. */
export function createSetSessionEffort(ports: {
  maker: Pick<Maker, 'getSession' | 'closeSession' | 'closeSessionIfCurrent'>;
  updateScheduledPreference: ReturnType<typeof createUpdateScheduledPreference>;
  agentSwitchPending: PendingAgentSwitchRegistry;
  stagePendingUserRuntimeAxis: ReturnType<typeof createStagePendingUserRuntimeAxis>;
  updateSavedScheduledAxis: ReturnType<typeof createUpdateSavedScheduledAxis>;
  resolvePendingRuntimeAxisPatch: ReturnType<typeof createResolvePendingRuntimeAxisPatch>;
  readSessionRuntimeProfiles: ReturnType<typeof createReadSessionRuntimeProfiles>;
  recoverRemoteRuntimeAxisPersistence: ReturnType<typeof createRecoverRemoteRuntimeAxisPersistence>;
  assertReviewSettingsUnlocked: (sessionId: string, sendLockHeld?: boolean) => Promise<void>;
  broadcastSessionRuntimeProjection: (sessionId: string, baselineOverride?: SessionRuntimeProfile) => Promise<void>;
  captureSharedTaskSettingGuard: (sessionId: string) => ReturnType<typeof createSharedTaskSettingGuard>;
  markRemoteSettingPersistedInsideHandler: typeof import('../device-link/dispatch.desktop.js').markRemoteSettingPersistedInsideHandler;
  persistSessionFields: PersistSessionFields;
  /** Called where the body read register.ts's holder, line for line. */
  getPendingCredentialSwitchHolder: () => PendingCredentialSwitchService | null;
  log: Logger;
}) {
  const {
    maker, updateScheduledPreference, agentSwitchPending, stagePendingUserRuntimeAxis, updateSavedScheduledAxis,
    resolvePendingRuntimeAxisPatch, readSessionRuntimeProfiles, recoverRemoteRuntimeAxisPersistence,
    assertReviewSettingsUnlocked, broadcastSessionRuntimeProjection, captureSharedTaskSettingGuard,
    markRemoteSettingPersistedInsideHandler, persistSessionFields, getPendingCredentialSwitchHolder, log,
  } = ports;
  return async (sessionId: unknown, effort: unknown) => {
    if (typeof sessionId !== 'string' || typeof effort !== 'string') {
      throwIpcError('INVALID_PARAMS', 'sessionId + effort required');
    }
    const runtimeOwnerEpoch = captureSessionRuntimeControlOwnerEpoch();
    const assertSharedTaskCurrent = captureSharedTaskSettingGuard(sessionId);
    const assertOwnerCurrent = () => {
      assertSharedTaskCurrent();
      if (!sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)) {
        throwIpcError(
          'PRECONDITION_FAILED',
          'app session changed during runtime effort update; request dropped',
        );
      }
    };
    const remoteInvoke = isDeviceLinkInvoke();
    const remoteResponse = remoteInvoke ? {} : undefined;
    const persistEffort = async () => {
      assertOwnerCurrent();
      assertSharedTaskCurrent.admit();
      await persistSessionFields(sessionId, { effort });
      await updateScheduledPreference(sessionId, { effort: effort as ScheduledModelSelection['effort'] });
      if (remoteResponse) markRemoteSettingPersistedInsideHandler(remoteResponse);
    };
    const applyEffort = async () => {
      const [runtimeStatus] = await getDbClient()
        .drizzle.select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!runtimeStatus) {
        if (remoteResponse) markRemoteSettingPersistedInsideHandler(remoteResponse);
        return remoteResponse;
      }
      if (runtimeStatus.status !== 'active' && runtimeStatus.status !== 'archived') {
        throwIpcError(
          'PRECONDITION_FAILED',
          'deleted task cannot change runtime effort',
        );
      }
      const userIntent = agentSwitchPending.get(sessionId);
      if (isUserPendingAgentSwitchIntent(userIntent)) {
        assertOwnerCurrent();
        assertSharedTaskCurrent.admit();
        const result = await stagePendingUserRuntimeAxis(sessionId, userIntent, { effort }, assertOwnerCurrent);
        if (remoteResponse) markRemoteSettingPersistedInsideHandler(remoteResponse);
        return remoteResponse ?? result;
      }
      if (await updateSavedScheduledAxis(sessionId, { effort: effort as ScheduledModelSelection['effort'] }, () => {
        assertOwnerCurrent();
        assertSharedTaskCurrent.admit();
      })) {
        if (remoteResponse) markRemoteSettingPersistedInsideHandler(remoteResponse);
        return remoteResponse;
      }
      if (runtimeStatus.status === 'archived') {
        // Main owns both local and remote commits; Renderer must not write a
        // target axis onto the old route while an intent is still pending.
        await persistEffort();
        return remoteResponse;
      }
      const livePatch: SessionRuntimeAxisPatch = {
        effort: effort as SessionRuntimeProfile['effort'],
      };
      const pendingPatch = await resolvePendingRuntimeAxisPatch(sessionId, livePatch);
      const commitEffort = () => {
        recordUserSessionRuntimeAxisMutation(sessionId, livePatch, pendingPatch);
        // 记下会话 effort:responses-bridge 模型(chatgpt/ / xai/)的 effort 无法经请求体流到 bridge,
        // 由 compat-proxy 路由决策从这里读出、闭包进订阅直连 handler 的 prefs(不影响 session 是否在跑)。
        setSessionEffort(sessionId, effort);
      };
      const sess = maker.getSession(sessionId);
      if (!sess) {
        await commitRuntimeAxisAfterPersistence({
          persist: persistEffort,
          commit: commitEffort,
          assertCanCommit: assertOwnerCurrent,
        });
        log.debug('set-effort: session not found, no-op', { sessionId });
        return remoteResponse;
      }
      // 有 pending 凭证切换 = 本会话的 model/effort 变更已整体延迟到 turn 结束重建:
      // 跳过对仍在跑的旧 turn 的 runtime 推送(与 renderer 本地分支的 deferred 守卫同因,
      // 这里是唯一 choke point,同时覆盖 device-link 远程入口;review P2 2026-07-04)。
      // 本地与设备互联均由此 handler 等待落盘，重建时再应用。
      if (getPendingCredentialSwitchHolder()?.has(sessionId)) {
        await commitRuntimeAxisAfterPersistence({
          persist: persistEffort,
          commit: commitEffort,
          assertCanCommit: assertOwnerCurrent,
        });
        log.debug('set-effort: skipped live push (pending credential switch)', { sessionId });
        return remoteResponse;
      }
      try {
        const previousProfile = (await readSessionRuntimeProfiles(sessionId))?.effective;
        const result = await applyRuntimeEffortWithRecovery({
          applyRuntime: () => {
            assertOwnerCurrent();
            assertSharedTaskCurrent.admit();
            return sess.setEffort(
              effort as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra',
            );
          },
          // 远程 Agent 正在跑一轮、那台只是回得慢：不当场关(会把这一轮杀掉，且不是那台电脑的问题，供应商组也
          // 不会换电脑)，这一轮结束后再按已落库的档位重建(provider-groups.md §6.1「本机的操作不打断进行中的远程一轮」)。
          terminateSession: async () => {
            if (sess.agentDeviceId && sess.isTurnRunning()) {
              await maker.closeSessionIfCurrent(sess, 'runtime-refresh', { afterCurrentTurn: true });
              return;
            }
            await maker.closeSession(sessionId);
          },
        });
        if (result === 'session-terminated') {
          log.warn('set-effort: timed-out runtime session terminated for lazy rebuild', {
            sessionId,
          });
        }
        await commitRuntimeAxisAfterPersistence({
          persist: persistEffort,
          commit: commitEffort,
          assertCanCommit: assertOwnerCurrent,
          ...(result === 'applied' && previousProfile
            ? {
                recoverAfterPersistenceFailure: () =>
                  recoverRemoteRuntimeAxisPersistence(
                    sessionId,
                    previousProfile,
                    { effort: effort as SessionRuntimeProfile['effort'] },
                    runtimeOwnerEpoch,
                  ),
              }
            : {}),
        });
        return remoteResponse;
      } catch (error) {
        if (isIpcError(error)) throw error;
        log.warn('set-effort runtime update failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        throwIpcError('INTERNAL', 'Runtime effort update failed');
      }
    };
    return withSendToSessionLock(sessionId, async () => {
      await assertReviewSettingsUnlocked(sessionId);
      assertOwnerCurrent();
      try {
        return await applyEffort();
      } finally {
        await broadcastSessionRuntimeProjection(sessionId).catch((error) => {
          log.debug('set-effort runtime projection broadcast failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    });
  };
}

/** register.ts's SET_THINKING_ENABLED handler body, after its sender check. */
export function createSetSessionThinkingEnabled(ports: {
  maker: Pick<Maker, 'getSession'>;
  assertReviewSettingsUnlocked: (sessionId: string, sendLockHeld?: boolean) => Promise<void>;
  captureSharedTaskSettingGuard: (sessionId: string) => ReturnType<typeof createSharedTaskSettingGuard>;
}) {
  const { maker, assertReviewSettingsUnlocked, captureSharedTaskSettingGuard } = ports;
  return async (sessionId: unknown, enabled: unknown) => {
    if (typeof sessionId !== 'string' || typeof enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'sessionId + enabled required');
    }
    const assertSharedTaskCurrent = captureSharedTaskSettingGuard(sessionId);
    await assertReviewSettingsUnlocked(sessionId);
    assertSharedTaskCurrent();
    const sess = maker.getSession(sessionId);
    if (!sess) return;
    assertSharedTaskCurrent.admit();
    await sess.setThinkingEnabled(enabled);
  };
}

/** register.ts's SET_FAST_MODE handler body, after its sender check. */
export function createSetSessionFastMode(ports: {
  readSessionRuntimeProfiles: ReturnType<typeof createReadSessionRuntimeProfiles>;
  updateScheduledPreference: ReturnType<typeof createUpdateScheduledPreference>;
  agentSwitchPending: PendingAgentSwitchRegistry;
  readUsableAgentDeviceProviders: ReadUsableAgentDeviceProviders;
  stagePendingUserRuntimeAxis: ReturnType<typeof createStagePendingUserRuntimeAxis>;
  updateSavedScheduledAxis: ReturnType<typeof createUpdateSavedScheduledAxis>;
  resolvePendingRuntimeAxisPatch: ReturnType<typeof createResolvePendingRuntimeAxisPatch>;
  maker: Pick<Maker, 'getSession' | 'closeSession' | 'closeSessionIfCurrent'>;
  recoverRemoteRuntimeAxisPersistence: ReturnType<typeof createRecoverRemoteRuntimeAxisPersistence>;
  assertReviewSettingsUnlocked: (sessionId: string, sendLockHeld?: boolean) => Promise<void>;
  broadcastSessionRuntimeProjection: (sessionId: string, baselineOverride?: SessionRuntimeProfile) => Promise<void>;
  captureSharedTaskSettingGuard: (sessionId: string) => ReturnType<typeof createSharedTaskSettingGuard>;
  markRemoteSettingPersistedInsideHandler: typeof import('../device-link/dispatch.desktop.js').markRemoteSettingPersistedInsideHandler;
  persistSessionFields: PersistSessionFields;
  getDesktopProviderService: ProviderListing;
  createSubscriptionFastPolicy: typeof import('../maker-host/subscription-fast-policy.js').createSubscriptionFastPolicy;
  /** Called where the body read register.ts's holder, line for line. */
  getPendingCredentialSwitchHolder: () => PendingCredentialSwitchService | null;
  log: Logger;
}) {
  const {
    readSessionRuntimeProfiles, updateScheduledPreference, agentSwitchPending, readUsableAgentDeviceProviders,
    stagePendingUserRuntimeAxis, updateSavedScheduledAxis, resolvePendingRuntimeAxisPatch, maker,
    recoverRemoteRuntimeAxisPersistence, assertReviewSettingsUnlocked, broadcastSessionRuntimeProjection,
    captureSharedTaskSettingGuard, markRemoteSettingPersistedInsideHandler, persistSessionFields,
    getDesktopProviderService, createSubscriptionFastPolicy, getPendingCredentialSwitchHolder, log,
  } = ports;
  return async (sessionId: unknown, requestedSpeed: unknown) => {
    if (typeof sessionId !== 'string' || (typeof requestedSpeed !== 'boolean' && requestedSpeed !== 'ultrafast')) {
      throwIpcError('INVALID_PARAMS', 'sessionId + enabled required');
    }
    let enabled: boolean | 'ultrafast' = requestedSpeed;
    const runtimeOwnerEpoch = captureSessionRuntimeControlOwnerEpoch();
    const assertSharedTaskCurrent = captureSharedTaskSettingGuard(sessionId);
    const assertOwnerCurrent = () => {
      assertSharedTaskCurrent();
      if (!sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)) {
        throwIpcError(
          'PRECONDITION_FAILED',
          'app session changed during runtime Fast mode update; request dropped',
        );
      }
    };
    const remoteInvoke = isDeviceLinkInvoke();
    const remoteResponse = remoteInvoke ? {} : undefined;
    const persistFastMode = async () => {
      assertOwnerCurrent();
      assertSharedTaskCurrent.admit();
      await persistSessionFields(sessionId, { fastMode: enabled });
      await updateScheduledPreference(sessionId, { fastMode: enabled });
      if (remoteResponse) markRemoteSettingPersistedInsideHandler(remoteResponse);
    };
    const applyFastMode = async () => {
      const [runtimeStatus] = await getDbClient()
        .drizzle.select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!runtimeStatus) {
        if (remoteResponse) markRemoteSettingPersistedInsideHandler(remoteResponse);
        return remoteResponse;
      }
      if (runtimeStatus.status !== 'active' && runtimeStatus.status !== 'archived') {
        throwIpcError(
          'PRECONDITION_FAILED',
          'deleted task cannot change runtime Fast mode',
        );
      }
      const userIntent = agentSwitchPending.get(sessionId);
      const fastProfile = (await readSessionRuntimeProfiles(sessionId))?.effective;
      assertOwnerCurrent();
      const subscriptionForbidsFast = !fastProfile?.agentDeviceId && !createSubscriptionFastPolicy(sessionId,
        () => fastProfile?.providerId ?? getSessionProvider(sessionId)).isAllowed();
      if (subscriptionForbidsFast) enabled = false;
      if (enabled === 'ultrafast') {
        const profiles = await readSessionRuntimeProfiles(sessionId);
        const profile = isUserPendingAgentSwitchIntent(userIntent)
          ? { ...userIntent, agentKind: userIntent.targetAgentKind,
              agentDeviceId: userIntent.targetAgentDeviceId === undefined
                ? profiles?.baseline.agentDeviceId : userIntent.targetAgentDeviceId }
          : profiles?.pendingMutation?.profile ?? profiles?.effective;
        const providers = profile?.agentDeviceId
          ? await readUsableAgentDeviceProviders(profile.agentDeviceId, profile.agentKind, profile.model, profile.providerId ?? null)
          : await getDesktopProviderService().listProviders({
              allowSideEffects: false, catalog: getActiveCatalog(),
            });
        const providerId = profile?.providerId ?? (profile
          ? effectiveSourceIdForModel(providers, null, profile.model, profile.agentKind) : null);
        const model = profile ? findCatalogModel(providers.find(p => p.id === providerId),
          profile.model, profile.agentKind, { exact: true }) : null;
        if (profile?.agentKind !== 'codex' || model?.supportsUltrafastMode !== true) {
          throwIpcError('PRECONDITION_FAILED', 'Ultrafast is unavailable for the selected account and model');
        }
        assertOwnerCurrent();
      }
      if (isUserPendingAgentSwitchIntent(userIntent)) {
        assertOwnerCurrent();
        assertSharedTaskCurrent.admit();
        const result = await stagePendingUserRuntimeAxis(sessionId, userIntent, { fastMode: enabled }, assertOwnerCurrent);
        if (remoteResponse) markRemoteSettingPersistedInsideHandler(remoteResponse);
        return remoteResponse ?? result;
      }
      if (await updateSavedScheduledAxis(sessionId, { fastMode: enabled }, () => {
        assertOwnerCurrent();
        assertSharedTaskCurrent.admit();
      })) {
        if (remoteResponse) markRemoteSettingPersistedInsideHandler(remoteResponse);
        return remoteResponse;
      }
      if (runtimeStatus.status === 'archived') {
        await persistFastMode();
        return remoteResponse;
      }
      const livePatch: SessionRuntimeAxisPatch = { fastMode: enabled };
      const pendingPatch = await resolvePendingRuntimeAxisPatch(sessionId, livePatch);
      const commitFastMode = () => {
        recordUserSessionRuntimeAxisMutation(sessionId, livePatch, pendingPatch);
        // 记下会话 Fast 态:responses-bridge 模型(chatgpt/ 前缀)的 fast 无法经请求体流到 bridge,
        // 由 compat-proxy 路由决策从这里读出、闭包进订阅直连 handler 的 prefs(与 SET_EFFORT 的 effort 同机制)。
        setSessionFastMode(sessionId, enabled);
      };
      const sess = maker.getSession(sessionId);
      if (!sess) {
        await commitRuntimeAxisAfterPersistence({
          persist: persistFastMode,
          commit: commitFastMode,
          assertCanCommit: assertOwnerCurrent,
        });
        log.debug('set-fast-mode: session not found, no-op', { sessionId });
        return remoteResponse;
      }
      // An explicit enable after relaxation must reach the policy wrapper as
      // well as native Claude, otherwise its request suppression stays latched.
      // Custom API connections retain their existing persistence-only path.
      const claudeSubscription = sess.agentKind === 'claude-code' && !fastProfile?.agentDeviceId &&
        supportsSubscriptionFastPolicy(getActiveCatalog().providers.find(
          provider => provider.id === (fastProfile?.providerId ?? getSessionProvider(sessionId)),
        ));
      if (sess.agentKind !== 'codex' && sess.agentKind !== 'pi' && !claudeSubscription) {
        await commitRuntimeAxisAfterPersistence({
          persist: persistFastMode,
          commit: commitFastMode,
          assertCanCommit: assertOwnerCurrent,
        });
        log.debug('set-fast-mode: agent does not implement fast mode, no-op', {
          sessionId,
          agentKind: sess.agentKind,
        });
        return remoteResponse;
      }
      // 同 set-effort:pending 凭证切换期间不触碰仍在跑的旧 turn,持久化走各自 DB 路径。
      if (getPendingCredentialSwitchHolder()?.has(sessionId)) {
        await commitRuntimeAxisAfterPersistence({
          persist: persistFastMode,
          commit: commitFastMode,
          assertCanCommit: assertOwnerCurrent,
        });
        log.debug('set-fast-mode: skipped live push (pending credential switch)', { sessionId });
        return remoteResponse;
      }
      const previousProfile = (await readSessionRuntimeProfiles(sessionId))?.effective;
      assertOwnerCurrent();
      assertSharedTaskCurrent.admit();
      await sess.setFastMode(enabled);
      enabled = sess.getFastMode() ?? enabled;
      livePatch.fastMode = enabled;
      pendingPatch.fastMode = enabled;
      await commitRuntimeAxisAfterPersistence({
        persist: persistFastMode,
        commit: commitFastMode,
        assertCanCommit: assertOwnerCurrent,
        ...(previousProfile
          ? {
              recoverAfterPersistenceFailure: () =>
                recoverRemoteRuntimeAxisPersistence(
                  sessionId,
                  previousProfile,
                  { fastMode: enabled },
                  runtimeOwnerEpoch,
                ),
            }
          : {}),
      });
      return remoteResponse;
    };
    return withSendToSessionLock(sessionId, async () => {
      await assertReviewSettingsUnlocked(sessionId);
      assertOwnerCurrent();
      try {
        return await applyFastMode();
      } finally {
        await broadcastSessionRuntimeProjection(sessionId).catch((error) => {
          log.debug('set-fast-mode runtime projection broadcast failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    });
  };
}
