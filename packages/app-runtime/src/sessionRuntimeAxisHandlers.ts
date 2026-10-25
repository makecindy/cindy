import { eq } from 'drizzle-orm';
import { sessions } from '@cindy/runtime-db/schema';
import { MAKER_INVOKE } from '@cindy/maker-shared/maker-channels';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import { isIpcError } from '@cindy/remote-agent/shared/ipc-errors';
import { effectiveSourceIdForModel, findCatalogModel, supportsSubscriptionFastPolicy, type ProviderView, type AgentKind } from '@cindy/model-providers';
import { isUserPendingAgentSwitchIntent, projectPendingAgentSwitchIntent, type PendingAgentSwitchIntent } from '@cindy/im-runtime/sessionAgentSwitch';
import type { Maker } from '@cindy/maker-core';
import type { SessionModelSelectionHost } from './sessionModelSelectionHost.js';
import type { SessionRuntimeProfile, SessionRuntimeAxisPatch, SessionRuntimeControlSnapshot, PendingSessionRuntimeMutation, createSessionRuntimeControl } from './sessionRuntimeControl.js';
import type { createScheduledPreferenceStore } from './scheduledPreferenceStore.js';
import type { ScheduledModelSelection } from './scheduledModelSelection.js';
import { commitRuntimeAxisAfterPersistence } from './runtimeSelectionAxes.js';
import { applyRuntimeEffortWithRecovery } from './runtimeSetEffort.js';

export interface SessionRuntimeAxisHost extends Pick<SessionModelSelectionHost,
  'sessionRuntimeControlOwnerEpochMatches' | 'withRehydrateCloseSuppressed' |
  'setSessionEffort' | 'setSessionFastMode' | 'getSessionProvider' | 'recordRecoveredSessionRuntimeAxisMutation' |
  'broadcastSessionRuntimeProjection' | 'log' | 'agentSwitchDeps' | 'getDesktopProviderService' |
  'getActiveCatalog' | 'resolveSessionRuntimeAxes' | 'persistSessionFields' | 'agentSwitchPending' |
  'wakeSessionInputAfterCredentialSwitch' | 'isDeviceLinkInvoke' | 'captureSessionRuntimeControlOwnerEpoch' |
  'captureSharedTaskSettingGuard' | 'markRemoteSettingPersistedInsideHandler' | 'getDbClient' |
  'resolvePendingRuntimeAxisPatch' | 'withSendToSessionLock' | 'assertReviewSettingsUnlocked' |
  'pendingCredentialSwitchHolder'>,
  Pick<ReturnType<typeof createSessionRuntimeControl>, 'recordUserSessionRuntimeAxisMutation'>,
  ReturnType<typeof createScheduledPreferenceStore> {
  maker: Pick<Maker, 'getSession' | 'closeSession' | 'closeSessionIfCurrent'>;
  assertTrustedAppRendererEvent(event: unknown): void;
  readUsableAgentDeviceProviders(device: string, kind: AgentKind, model: string, provider: string | null): Promise<ProviderView[]>;
  readSessionRuntimeProfiles(id: string): Promise<{baseline: SessionRuntimeProfile; effective: SessionRuntimeProfile; control: SessionRuntimeControlSnapshot; pendingMutation?: PendingSessionRuntimeMutation | null} | null>;
  createSubscriptionFastPolicy(sessionId: string, providerId: () => string | null | undefined): { isAllowed(): boolean };
}
export type SessionRuntimeAxisHandler = (event: unknown, sessionId: unknown, value: unknown) => Promise<unknown>;
/** Original Desktop handlers; Node supplies the same owner-scoped services and native runtimes. */
export function registerSessionRuntimeAxisHandlers(ipcMain: {
  handle(channel: string, handler: SessionRuntimeAxisHandler): void;
}, host: SessionRuntimeAxisHost) {
  const { sessionRuntimeControlOwnerEpochMatches, withRehydrateCloseSuppressed, maker, setSessionEffort, setSessionFastMode, getSessionProvider, recordRecoveredSessionRuntimeAxisMutation, broadcastSessionRuntimeProjection, log, agentSwitchDeps, readUsableAgentDeviceProviders, getDesktopProviderService, getActiveCatalog, resolveSessionRuntimeAxes, persistSessionFields, agentSwitchPending, wakeSessionInputAfterCredentialSwitch, isDeviceLinkInvoke, assertTrustedAppRendererEvent, captureSessionRuntimeControlOwnerEpoch, captureSharedTaskSettingGuard, updateScheduledPreference, markRemoteSettingPersistedInsideHandler, getDbClient, updateSavedScheduledAxis, resolvePendingRuntimeAxisPatch, recordUserSessionRuntimeAxisMutation, readSessionRuntimeProfiles, withSendToSessionLock, assertReviewSettingsUnlocked, createSubscriptionFastPolicy, pendingCredentialSwitchHolder } = host;
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

  // Called under the existing send lock after owner/shared-task admission.
  // Keep the selected route intact: cross-engine/device intents must not pass
  // through SET_MODEL, which would reinterpret them as the current harness.
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

  ipcMain.handle(MAKER_INVOKE.SET_EFFORT, async (event, sessionId: unknown, effort: unknown) => {
    // 轮 24-I3 HIGH:会话变更型 IPC 统一 sender 校验(对齐 SET_PERMISSION_MODE)——
    // 任意 WebView/受污染页面不得修改活会话偏好。device-link 远程控制端已授权。
    if (!isDeviceLinkInvoke()) {
      assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    }
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
      if (remoteResponse) markRemoteSettingPersistedInsideHandler?.(remoteResponse);
    };
    const applyEffort = async () => {
      const [runtimeStatus] = await getDbClient()
        .drizzle.select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!runtimeStatus) {
        if (remoteResponse) markRemoteSettingPersistedInsideHandler?.(remoteResponse);
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
        if (remoteResponse) markRemoteSettingPersistedInsideHandler?.(remoteResponse);
        return remoteResponse ?? result;
      }
      if (await updateSavedScheduledAxis(sessionId, { effort: effort as ScheduledModelSelection['effort'] }, () => {
        assertOwnerCurrent();
        assertSharedTaskCurrent.admit();
      })) {
        if (remoteResponse) markRemoteSettingPersistedInsideHandler?.(remoteResponse);
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
      if (pendingCredentialSwitchHolder?.has(sessionId)) {
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
  });

  ipcMain.handle(
    MAKER_INVOKE.SET_FAST_MODE,
    async (event, sessionId: unknown, requestedSpeed: unknown) => {
      // 轮 24-I3 HIGH:会话变更型 IPC 统一 sender 校验(对齐 SET_PERMISSION_MODE)。
      if (!isDeviceLinkInvoke()) {
        assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
      }
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
        if (remoteResponse) markRemoteSettingPersistedInsideHandler?.(remoteResponse);
      };
      const applyFastMode = async () => {
        const [runtimeStatus] = await getDbClient()
          .drizzle.select({ status: sessions.status })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        if (!runtimeStatus) {
          if (remoteResponse) markRemoteSettingPersistedInsideHandler?.(remoteResponse);
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
        const subscriptionForbidsFast = !fastProfile?.agentDeviceId && !createSubscriptionFastPolicy(
          sessionId,
          () => fastProfile?.providerId ?? getSessionProvider(sessionId),
        ).isAllowed();
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
          if (remoteResponse) markRemoteSettingPersistedInsideHandler?.(remoteResponse);
          return remoteResponse ?? result;
        }
        if (await updateSavedScheduledAxis(sessionId, { fastMode: enabled }, () => {
          assertOwnerCurrent();
          assertSharedTaskCurrent.admit();
        })) {
          if (remoteResponse) markRemoteSettingPersistedInsideHandler?.(remoteResponse);
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
        if (pendingCredentialSwitchHolder?.has(sessionId)) {
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
    },
  );

}
