import { eq } from 'drizzle-orm';
import { sessions } from '@cindy/runtime-db/schema';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import type { IpcErrorCode } from '@cindy/remote-agent/shared/ipc-errors';
import { actualSourceIdForModel, effectiveSourceIdForModel, findCatalogModel, isLocalOnlyProviderForAgent } from '@cindy/model-providers';
import { resolveCurrentSetModelProviderId, resolveSetModelGuardProviderId, resolveExclusiveSetModelReroute } from '@cindy/model-providers/model-route-guard';
import { buildDeferredRuntimeSelectionProfile, planUserRuntimeModelSwitch, shouldSkipColdPiWindowRehydration } from '@cindy/model-providers/runtimeModelSwitchGate';
import { CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1 } from '@cindy/device-link';
import { dbToMakerAgentKind } from '@cindy/maker-shared/agent-kind-conversion';
import { parseOrcaRemoteLead } from '@cindy/maker-shared/orca-remote-worker';
import { projectPendingAgentSwitchIntent } from '@cindy/im-runtime/sessionAgentSwitch';
import { hasModelWindowContextToProtect, lookupVerifiedContextWindow, type ModelWindowSwitchPreparationResult } from '@cindy/im-runtime/contextOverflowRollover';
import type { InternalRuntimeSelectionOptions, ApplySessionRuntimeSelection } from './sessionRuntimeSelectionTypes.js';
import type { SessionRuntimeProfile, SessionRuntimeAxisPatch } from './sessionRuntimeControl.js';
import { normalizeDeviceLinkSetModelWireArgs } from './setModelWireArgs.js';
import { normalizeSessionProviderId } from './sessionProviderStore.js';
import { readSshCodexModelList, assertSshCodexModel } from './sshCodexModelList.js';
import { classifyColdPiRehydrationOutcome } from './coldPiRehydration.js';
import { ColdPiRehydrationError, logColdPiRehydrationFailure, reportColdPiRehydrationFailure } from './coldPiRehydrationFailure.js';
import { CredentialModeSwitchBusyError } from './credentialModeSwitch.js';
import { resolveVerifiedContextWindow } from './sessionContextWindow.js';
import { closeRejectedRuntimeAndRestoreControlStores } from './runtimeSetModel.js';
import { codexThreadTransferSourcePredicate, relinkCodexProviderThread, commitCodexThreadTransfer } from './codexProviderThreadRelink.js';
import { applyRuntimeSelectionAxesWithRecovery, isSupportedRuntimeEffort, resolveRetainedRuntimeEffort } from './runtimeSelectionAxes.js';
import type { SessionModelSelectionHost } from './sessionModelSelectionHost.js';

/** The original Desktop SET_MODEL transaction, with platform services supplied by the host. */
export function createSessionModelSelection(host: SessionModelSelectionHost) {
const { isDeviceLinkInvoke, deviceLinkInvokeControllerSupports, captureSessionRuntimeControlOwnerEpoch, captureSharedTaskSettingGuard, sessionRuntimeControlOwnerEpochMatches, assertReviewSettingsUnlocked, getDbClient, canApplyAutomaticRuntimeSelection, agentSwitchPending, applyAgentDeviceRuntimeSelection, hasSessionProvider, hydrateSessionProvider, log, getSessionProvider, listSshCodexProviders, getSessionRuntimeControlSnapshot, maker, getDesktopProviderService, getActiveCatalog, resolveSessionRuntimeRefreshEffort, getSessionEffort, getSessionDbAgentKind, assertModelRouteUsable, resolveSessionRuntimeAxes, clearPendingCredentialSwitchForSession, agentSwitchDeps, wakeSessionInputAfterCredentialSwitch, markRemoteSettingPersistedInsideHandler, resolvePendingRuntimeAxisPatch, acceptSessionRuntimeMutation, getSessionFastMode, deferSessionRuntimeAxisMutation, getPendingCredentialSwitchTarget, broadcastSessionRuntimeProjection, isSessionInTurn, setSessionProvider, clearSessionProvider, setSessionEffort, setSessionFastMode, withRehydrateCloseSuppressed, getSessionLastLiveUsage, resolveConfiguredContextWindow, readStoredSessionContextWindowBudget, rehydrateColdPiRuntimeForWindowVerification, recordRecoveredSessionRuntimeMutation, recordRecoveredSessionRuntimeAxisMutation, broadcastSessionPatched, getCurrentDbClientSnapshot, captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent, applyRuntimeSetModelChange, registerPendingCredentialSwitchForSession, getCodexProxyAuthInjectionState, persistSessionFields, updateScheduledPreference, recordUserSessionRuntimeMutation, settlePendingSessionRuntimeMutation, acceptSessionRuntimeAxisMutation, recordSessionContextSnapshot, withSendToSessionLock } = host;
function localModelWindowSwitchErrorCode(code: IpcErrorCode): IpcErrorCode { return isDeviceLinkInvoke() ? 'PRECONDITION_FAILED' : code; }
const handleSetModel = async (
    sessionId: unknown,
    model: unknown,
    providerId: unknown,
    expectedAgentSwitchRevision: unknown,
    selection: unknown,
    internalOptions: InternalRuntimeSelectionOptions,
  ): ReturnType<ApplySessionRuntimeSelection> => {
    if (typeof sessionId !== 'string' || typeof model !== 'string') {
      throwIpcError('INVALID_PARAMS', 'sessionId + model required');
    }
    const normalizedWireArgs =
      internalOptions.source === 'user'
        ? normalizeDeviceLinkSetModelWireArgs(
            isDeviceLinkInvoke(),
            deviceLinkInvokeControllerSupports(
              CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1,
            ),
            providerId,
            expectedAgentSwitchRevision,
            selection,
          )
        : { providerId, expectedAgentSwitchRevision, selection };
    providerId = normalizedWireArgs.providerId;
    expectedAgentSwitchRevision = normalizedWireArgs.expectedAgentSwitchRevision;
    selection = normalizedWireArgs.selection;
    if (providerId !== undefined && providerId !== null && typeof providerId !== 'string') {
      throwIpcError('INVALID_PARAMS', 'providerId must be string, null, or undefined');
    }
    if (
      expectedAgentSwitchRevision !== undefined &&
      (typeof expectedAgentSwitchRevision !== 'number' ||
        !Number.isSafeInteger(expectedAgentSwitchRevision) ||
        expectedAgentSwitchRevision < 0)
    ) {
      throwIpcError('INVALID_PARAMS', 'expectedAgentSwitchRevision must be a non-negative integer');
    }
    const confirmedContextWindow = (selection as { confirmedContextWindow?: unknown } | undefined)
      ?.confirmedContextWindow;
    const selectionEffort = (selection as { effort?: unknown } | undefined)?.effort;
    const selectionThinking = (selection as { thinking?: unknown } | undefined)?.thinking;
    if (selectionThinking !== undefined && typeof selectionThinking !== 'boolean') {
      // 与 SWITCH_SESSION_AGENT 同口径：非 boolean 的 thinking 当作「未提供」，不让
      // 历史/异常客户端的多余字段把整次模型切换打成 INVALID_PARAMS。
      delete (selection as { thinking?: unknown }).thinking;
    }
    if (
      selection !== undefined &&
      (selection === null ||
        typeof selection !== 'object' ||
        Array.isArray(selection) ||
        (!isSupportedRuntimeEffort(selectionEffort) &&
          selectionEffort !== null) ||
        (typeof (selection as { fastMode?: unknown }).fastMode !== 'boolean' &&
          (selection as { fastMode?: unknown }).fastMode !== 'ultrafast'))
    ) {
      throwIpcError('INVALID_PARAMS', 'selection must contain effort + fastMode');
    }
    if (
      confirmedContextWindow !== undefined &&
      (typeof confirmedContextWindow !== 'number' ||
        !Number.isSafeInteger(confirmedContextWindow) ||
        confirmedContextWindow <= 0)
    ) {
      throwIpcError('INVALID_PARAMS', 'confirmedContextWindow must be a positive integer');
    }
    if (isDeviceLinkInvoke() && confirmedContextWindow !== undefined) {
      throwIpcError(
        'PRECONDITION_FAILED',
        'remote model-window confirmation is unsupported; runtime selection was not changed',
      );
    }
    let atomicSelection = selection as
      { effort: SessionRuntimeProfile['effort']; fastMode: boolean | 'ultrafast'; thinking?: boolean } | undefined;
    const runtimeOwnerEpoch = captureSessionRuntimeControlOwnerEpoch();
    const assertSharedTaskCurrent = captureSharedTaskSettingGuard(sessionId);
    const assertRuntimeOwnerCurrent = (): void => {
      assertSharedTaskCurrent();
      internalOptions.assertSelectionCurrent?.();
      if (!sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)) {
        throwIpcError(
          'PRECONDITION_FAILED',
          'app session changed during runtime selection; request dropped',
        );
      }
    };
    const supersededByOwnerBoundary = (): boolean => {
      assertSharedTaskCurrent();
      if (sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)) return false;
      if (internalOptions.source === 'user') {
        assertRuntimeOwnerCurrent();
      }
      return true;
    };
    // 与 send 事务共用 session 锁:发送时刻执行的跨引擎切换必须先落定,
    // 后到的 SET_MODEL 才能写 route。否则切换 DB await 恢复后会用旧 provider
    // 覆盖用户刚选的新 route，形成 DB 与进程内路由分叉。
    const applyLocked = async () => {
      await assertReviewSettingsUnlocked(sessionId);
      if (supersededByOwnerBoundary()) {
        return { deferred: false, superseded: true };
      }
      // 归档/删除写入与本 handler 共用 session route lock。归档后仍允许用户
      // 暂存下一次发送的选择，但不得应用 runtime 或允许自动更新重建 override。
      // 删除任务始终拒绝；暂存意图留到发送前先恢复任务再应用。
      const [runtimeStatus] = await getDbClient()
        .drizzle.select({
          status: sessions.status,
          orcaRole: sessions.orcaRole,
          orcaRemoteLead: sessions.orcaRemoteLead,
          agentKind: sessions.agentKind,
          remoteHostId: sessions.remoteHostId,
          agentDeviceId: sessions.agentDeviceId,
          sdkSessionId: sessions.sdkSessionId,
          model: sessions.model,
          providerId: sessions.providerId,
          effort: sessions.effort,
          fastMode: sessions.fastMode,
          updatedAt: sessions.updatedAt,
          workingDir: sessions.workingDir,
          contextTokens: sessions.contextTokens,
          contextWindow: sessions.contextWindow,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!runtimeStatus) {
        return { deferred: false, superseded: true };
      }
      const canStageArchivedSelection = runtimeStatus.status === 'archived' &&
        internalOptions.source === 'user' && !internalOptions.applyingUserSelectionOnSend;
      if (runtimeStatus.status !== 'active' && !canStageArchivedSelection) {
        if (internalOptions.source === 'user') {
          throwIpcError(
            'PRECONDITION_FAILED',
            'archived or deleted task cannot change runtime selection',
          );
        }
        return { deferred: false, superseded: true };
      }
      if (
        internalOptions.source !== 'user' &&
        !canApplyAutomaticRuntimeSelection(sessionId, internalOptions.expectedGeneration)
      ) {
        return { deferred: false, superseded: true };
      }
      const routeExplicit = internalOptions.routeExplicit !== false;
      // 同引擎重选是 switch ack 后的第二段写入。另一控制端若在两段之间更新（含
      // set→clear ABA），修订号已变化：旧 SET_MODEL 必须在任何 route/DB 副作用前让位。
      if (
        typeof expectedAgentSwitchRevision === 'number' &&
        agentSwitchPending.revision?.(sessionId) !== expectedAgentSwitchRevision
      ) {
        return { deferred: false, superseded: true };
      }
      if (runtimeStatus.agentDeviceId && !runtimeStatus.remoteHostId) {
        return applyAgentDeviceRuntimeSelection({
          sessionId, model, providerId, atomicSelection, internalOptions, runtimeStatus,
          assertRuntimeOwnerCurrent, assertSharedTaskCurrent, supersededByOwnerBoundary,
          ...(typeof confirmedContextWindow === 'number' ? { confirmedContextWindow } : {}),
        });
      }
      // 停用轴准入(PR #744 review;第十二轮移入锁内):切换模型是一次新的路由选择,
      // 不得切到用户停用的模型 / 来源(本机选择器已过滤,但本 channel 在 device-link
      // allowlist 内,老控制端可直接点名)。裁决必须在拿到会话锁**之后**执行 ——
      // 排队等待期间目标可能刚被停用,而同凭证族的变更即时生效、不经 deferred 收口
      // 的重裁决,锁前裁决结果可能已过期。会话当前正用着的停用模型不受影响,这里只
      // 拦「切过去」;隐式来源的原生默认落点被停用而有启用替代拷贝时,以显式来源
      // 落地(与 bootstrapSession 同语义)。agentKind 读不到(会话行缺失等)时不拦。
      // DB 存的是 'cc' | 'codex'(messages.agent_kind 口径),目录侧是 AgentKind。
      const requestedProviderId = normalizeSessionProviderId(
        typeof providerId === 'string' || providerId === null
          ? providerId
          : internalOptions.source === 'user' && agentSwitchPending.get(sessionId)?.sameAgentSelection
            ? agentSwitchPending.get(sessionId)?.providerId
            : undefined,
      );
      let persistedProviderId: string | null = null;
      let persistedProviderKnown = true;
      // 「目标 provider」(requestedProviderId,用户要切去的来源)与「源会话 provider」
      // (会话当前路由,窗口评估要用)是两个独立事实。冷会话内存未 hydrate 时,即使
      // 本次请求显式携带了目标 provider,也必须先从 DB 恢复源 provider —— 否则
      // currentProviderId 为 null,源模型窗口按全局 modelId 反查,同名模型跨
      // provider 时解析不确定(fail-closed),冷会话带历史切换渠道会误报
      // MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN(#3996)。目标 provider 只参与目标
      // 模型解析与最终提交,不覆盖源窗口解析所需身份。
      if (!hasSessionProvider(sessionId)) {
        try {
          const db = getDbClient().drizzle;
          const [row] = await db
            .select({ providerId: sessions.providerId })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);
          persistedProviderId = row?.providerId?.trim() || null;
          hydrateSessionProvider(sessionId, persistedProviderId);
        } catch (err) {
          persistedProviderKnown = false;
          log.debug('set-model persisted provider lookup failed (non-fatal)', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const currentProviderId = internalOptions.previousPiRoute
        ? internalOptions.previousPiRoute.providerId
        : resolveCurrentSetModelProviderId(
            hasSessionProvider(sessionId),
            getSessionProvider(sessionId),
            persistedProviderId,
          );
      const guardProviderId = resolveSetModelGuardProviderId(
        requestedProviderId,
        currentProviderId,
      );
      let effectiveProviderId = requestedProviderId;
      const sshCodexProviders = runtimeStatus.remoteHostId && runtimeStatus.agentKind === 'codex'
        ? await readSshCodexModelList({ id: runtimeStatus.remoteHostId }, listSshCodexProviders)
        : null;
      // Route-only refreshes preserve the current axes. A cleared store can mean a
      // fixed-effort model, so normalize the NOT NULL row against the SOURCE model
      // before using it; the requested target must not revive its historical rank.
      const currentRuntimeProfile = getSessionRuntimeControlSnapshot(sessionId).effectiveOverride;
      const currentLiveSession = maker.getSession(sessionId);
      const currentAgentKind = currentLiveSession?.agentKind ?? dbToMakerAgentKind(runtimeStatus.agentKind);
      const currentModelId = currentLiveSession?.model ?? internalOptions.previousPiRoute?.model ?? runtimeStatus.model;
      const runtimeProviders = sshCodexProviders ?? await getDesktopProviderService().listProviders({
        allowSideEffects: false,
        catalog: getActiveCatalog(),
      });
      const currentSourceId = currentProviderId ?? actualSourceIdForModel(
        runtimeProviders, null, currentModelId, currentAgentKind,
      );
      const currentEffort = currentRuntimeProfile
        ? currentRuntimeProfile.effort
        : resolveSessionRuntimeRefreshEffort({
            model: findCatalogModel(runtimeProviders.find(p => p.id === currentSourceId),
              currentModelId, currentAgentKind, { exact: true }) ?? null,
            storedEffort: getSessionEffort(sessionId) as SessionRuntimeProfile['effort'],
            persistedEffort: runtimeStatus.effort ?? null,
          });
      if (sshCodexProviders) {
        assertSshCodexModel(sshCodexProviders, model, guardProviderId);
      } else if (routeExplicit) {
        const dbAgentKind = getSessionDbAgentKind(sessionId);
        if (dbAgentKind) {
          // 停用轴准入只依赖目标路由(guard = 显式目标 ?? 恢复出的源),与源 provider
          // 的 DB 查询成败无关 —— 查询失败只能放弃独占 pin 重裁决,不能跳过准入。
          const reroute = await assertModelRouteUsable(
            dbToMakerAgentKind(dbAgentKind),
            model,
            guardProviderId,
          );
          effectiveProviderId = resolveExclusiveSetModelReroute(
            requestedProviderId,
            currentProviderId,
            reroute,
            persistedProviderKnown,
            getActiveCatalog().providers,
          );
        }
      }
      if (runtimeStatus.remoteHostId) {
        const targetId = effectiveProviderId === undefined ? currentProviderId : effectiveProviderId;
        const target = (sshCodexProviders ?? getActiveCatalog().providers).find((provider) => provider.id === targetId);
        if (target && isLocalOnlyProviderForAgent(target, dbToMakerAgentKind(runtimeStatus.agentKind))) {
          throwIpcError('INVALID_PARAMS', 'This provider requires local execution');
        }
      }
      if (atomicSelection) {
        const meta = await maker.getSessionMeta(sessionId);
        const runtimeAgentKind =
          maker.getSession(sessionId)?.agentKind ??
          (getSessionDbAgentKind(sessionId)
            ? dbToMakerAgentKind(getSessionDbAgentKind(sessionId))
            : meta?.agentKind);
        if (!runtimeAgentKind) {
          throwIpcError('INVALID_PARAMS', `session ${sessionId} has no runtime agent`);
        }
        const selectedProviderId =
          effectiveProviderId === null
            ? null
            : (normalizeSessionProviderId(effectiveProviderId) ?? currentProviderId);
        const actualProviderId =
          selectedProviderId ??
          effectiveSourceIdForModel(runtimeProviders, null, model, runtimeAgentKind);
        const provider = runtimeProviders.find((candidate) => candidate.id === actualProviderId);
        const catalogModel = findCatalogModel(provider, model, runtimeAgentKind, {
          exact: true,
        });
        if ((!provider?.connected && routeExplicit) || !catalogModel) {
          throwIpcError(
            'INVALID_PARAMS',
            `model "${model}" is unavailable from provider "${actualProviderId ?? 'default'}"`,
          );
        }
        if (
          internalOptions.source === 'user' &&
          atomicSelection.effort === null &&
          catalogModel.efforts.length > 0
        ) {
          throwIpcError('INVALID_PARAMS', `effort "null" is unavailable for model "${model}"`);
        }
        const axes = resolveSessionRuntimeAxes({
          model: catalogModel,
          effort: atomicSelection.effort,
          fastMode: atomicSelection.fastMode,
          // 配置跟随(IM 渠道默认跟随 / 伙伴模型对齐)带的是**任务已有的**档位/Fast
          // (Fast 根本不在渠道默认里), 不是用户对目标模型的显式能力选择 —— 目标模型
          // 不支持时应收敛而不是拒, 否则任务会在每条消息上反复失败、永远跟不过去
          // (PR #5155 review P2)。用户 picker 选择仍按显式校验。
          effortExplicit:
            (internalOptions.source === 'user' && internalOptions.configStaged !== true) ||
            internalOptions.effortExplicit === true,
          fastExplicit:
            (internalOptions.source === 'user' && internalOptions.configStaged !== true) ||
            internalOptions.fastExplicit === true,
          allowFixedEffortPlaceholder: internalOptions.source === 'user',
        });
        if (!axes.ok && axes.reason === 'effort-unavailable') {
          throwIpcError(
            'INVALID_PARAMS',
            `effort "${atomicSelection.effort}" is unavailable for model "${model}"`,
          );
        }
        if (!axes.ok) {
          throwIpcError('INVALID_PARAMS', `Fast is unavailable for model "${model}"`);
        }
        const retainedThinking = atomicSelection.thinking;
        atomicSelection = {
          effort: axes.effort,
          fastMode: axes.fastMode,
          ...(retainedThinking !== undefined ? { thinking: retainedThinking } : {}),
        };
      }
      // A picker click records intent only. Keep the persisted route and native binding
      // authoritative until a real send holds this same lock and consumes the final choice.
      if (internalOptions.source === 'user' && !internalOptions.applyingUserSelectionOnSend &&
          (!runtimeStatus.remoteHostId || canStageArchivedSelection)) {
        if (internalOptions.beforeMutation) await internalOptions.beforeMutation();
        assertRuntimeOwnerCurrent();
        assertSharedTaskCurrent.admit();
        clearPendingCredentialSwitchForSession(sessionId, { wake: false });
        const previousIntent = agentSwitchPending.get(sessionId);
        const selectedProviderId = effectiveProviderId === undefined ? currentProviderId : effectiveProviderId;
        const acknowledgedWindow = confirmedContextWindow ?? (
          previousIntent?.sameAgentSelection && previousIntent.model === model &&
          previousIntent.targetAgentKind === dbToMakerAgentKind(runtimeStatus.agentKind) &&
          previousIntent.providerId === selectedProviderId ? previousIntent.confirmedContextWindow : undefined);
        const intent = {
          ...(internalOptions.runtimeSource ? { runtimeSource: internalOptions.runtimeSource } : {}),
          ...(internalOptions.configStaged === true ? { configStaged: true } : {}),
          sameAgentSelection: true,
          targetAgentKind: dbToMakerAgentKind(runtimeStatus.agentKind),
          model,
          providerId: effectiveProviderId === undefined ? currentProviderId : effectiveProviderId,
          effort: atomicSelection ? atomicSelection.effort ?? undefined : runtimeStatus.effort ?? undefined,
          fastMode: atomicSelection?.fastMode ?? runtimeStatus.fastMode,
          ...(atomicSelection?.thinking !== undefined ? { thinking: atomicSelection.thinking } : {}),
          ...(acknowledgedWindow !== undefined ? { confirmedContextWindow: acknowledgedWindow } : {}),
        };
        agentSwitchPending.set(sessionId, intent);
        agentSwitchDeps.onPendingSwitchChanged?.(sessionId, projectPendingAgentSwitchIntent(intent));
        wakeSessionInputAfterCredentialSwitch(sessionId);
        const response = { deferred: true, superseded: false, pendingUntilSend: true };
        // Dispatch must not persist a selection over the source route outside this lock.
        if (isDeviceLinkInvoke()) markRemoteSettingPersistedInsideHandler?.(response);
        return response;
      }
      const axisPatch: SessionRuntimeAxisPatch = {
        ...(internalOptions.effortExplicit === true && atomicSelection
          ? { effort: atomicSelection.effort }
          : {}),
        ...(internalOptions.fastExplicit === true && atomicSelection
          ? { fastMode: atomicSelection.fastMode }
          : {}),
      };
      const pendingAxisPatch = routeExplicit
        ? axisPatch
        : await resolvePendingRuntimeAxisPatch(sessionId, axisPatch);
      const deferLockedSelection = async () => {
        const meta = await maker.getSessionMeta(sessionId);
        if (internalOptions.beforeMutation) await internalOptions.beforeMutation();
        if (!meta) return { deferred: false, superseded: true };
        if (supersededByOwnerBoundary()) {
          return { deferred: false, superseded: true };
        }
        assertSharedTaskCurrent.admit();
        const generation = routeExplicit
          ? acceptSessionRuntimeMutation({
              sessionId,
              source: internalOptions.source === 'fallback' ? 'fallback' : 'agent',
              previousProfile: internalOptions.previousProfile,
              deferred: true,
              // 回合中延期同样要记住思考意图：结算时 settleSelection 会把它回放给
              // runtime，否则 Pi 收不到 thinkingEnabled，上一个模型的 off 会原样漂给新
              // 模型（原症状）。
              ...(atomicSelection?.thinking !== undefined
                ? { thinking: atomicSelection.thinking }
                : {}),
              profile: buildDeferredRuntimeSelectionProfile({
                agentKind: maker.getSession(sessionId)?.agentKind ?? meta.agentKind,
                model,
                providerId:
                  effectiveProviderId === undefined
                    ? getSessionProvider(sessionId)
                    : (normalizeSessionProviderId(effectiveProviderId) ?? null),
                atomicSelection,
                currentEffort,
                currentFastMode: getSessionFastMode(sessionId),
              }),
            })
          : deferSessionRuntimeAxisMutation({
              sessionId,
              source: internalOptions.source === 'fallback' ? 'fallback' : 'agent',
              effectiveProfile: internalOptions.effectiveProfile ?? {
                agentKind: maker.getSession(sessionId)?.agentKind ?? meta.agentKind,
                model,
                providerId: currentProviderId,
                effort: getSessionEffort(sessionId) as SessionRuntimeProfile['effort'],
                fastMode: getSessionFastMode(sessionId),
              },
              pendingPatch: pendingAxisPatch,
              ...(atomicSelection?.thinking !== undefined
                ? { thinking: atomicSelection.thinking }
                : {}),
            });
        // A later accepted route supersedes an earlier context-only rebuild.
        if (routeExplicit && getPendingCredentialSwitchTarget(sessionId)?.forceSessionRebuild) {
          clearPendingCredentialSwitchForSession(sessionId, { wake: false });
        }
        await broadcastSessionRuntimeProjection(sessionId).catch((error) => {
          log.debug('deferred session runtime projection broadcast failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return {
          deferred: true,
          superseded: false,
          generation,
          effectiveProviderId: effectiveProviderId === undefined
            ? currentProviderId : normalizeSessionProviderId(effectiveProviderId) ?? null,
        };
      };
      // 远端回合中不能 live 改 turn:登记选择,回合结束后再生效,不再 PRECONDITION 丢掉。
      if (runtimeStatus.remoteHostId && isSessionInTurn(sessionId)) {
        return deferLockedSelection();
      }
      if (internalOptions.deferWhileRunning && isSessionInTurn(sessionId)) {
        return deferLockedSelection();
      }
      if (internalOptions.previousPiRoute && !maker.getSession(sessionId)) {
        // Renderer may have persisted the deferred target before a Pi turn exited.
        // Restore the captured source identity for the cold window transaction.
        setSessionProvider(sessionId, internalOptions.previousPiRoute.providerId);
      }
      const previousRuntime = {
        hadProviderRoute: hasSessionProvider(sessionId),
        providerId: getSessionProvider(sessionId),
        effort: getSessionEffort(sessionId) as SessionRuntimeProfile['effort'],
        fastMode: getSessionFastMode(sessionId),
        pendingCredentialSwitch: host.pendingCredentialSwitchHolder?.get(sessionId),
        hadLiveSession: maker.getSession(sessionId) !== undefined,
      };
      let liveSessionBeforeRouteChange = maker.getSession(sessionId);
      let rehydratedColdPiRuntime: typeof liveSessionBeforeRouteChange = undefined;
      // 冷 Pi 但没做活进程窗口核验（本轮新增：目标窗口对已知占用有余量、压力预检证明
      // 核实不可能改变结论，于是跳过了冷启动核实）：目标 route 照常落定，由下一次发送
      // 按目标窗口懒创建；apply 之后的终态活进程核验必须同步跳过，否则只会换成
      // 'Pi target runtime could not be verified'。
      let coldPiRouteWithoutLiveWindowCheck = false;
      // Task-level context budgets are host-owned. Read once per model transaction so
      // cold-Pi pressure checks and final window verification use the same value.
      const sessionContextWindowBudget = readStoredSessionContextWindowBudget
        ? await readStoredSessionContextWindowBudget(sessionId)
        : null;
      const targetProviderId =
        effectiveProviderId === undefined
          ? (previousRuntime.pendingCredentialSwitch?.providerId ?? currentProviderId)
          : (normalizeSessionProviderId(effectiveProviderId) ?? null);
      // Codex can resume the same native thread with a new provider. Reconnect the
      // runtime when credentials change; do not fork or rewrite indexed history.
      // Rejected opaque compaction is recovered only after an actual upstream failure.
      const rebuildLiveOrcaWorker =
        routeExplicit &&
        runtimeStatus.orcaRole === 'worker' &&
        liveSessionBeforeRouteChange !== undefined &&
        (liveSessionBeforeRouteChange.model !== model || currentProviderId !== targetProviderId);
      const restoreControlStores = () => {
        if (previousRuntime.hadProviderRoute) {
          setSessionProvider(sessionId, previousRuntime.providerId);
        } else {
          clearSessionProvider(sessionId);
        }
        setSessionEffort(sessionId, previousRuntime.effort);
        setSessionFastMode(sessionId, previousRuntime.fastMode);
      };
      const closeRejectedPiRuntime = (reason: string): Promise<void> =>
        closeRejectedRuntimeAndRestoreControlStores({
          closeRuntime: () =>
            withRehydrateCloseSuppressed(sessionId, () => maker.closeSession(sessionId)),
          restoreControlStores,
          reportCloseError: (error) => {
            log.warn('failed to close Pi after rejected final-window selection', {
              sessionId,
              reason,
              error: error instanceof Error ? error.message : String(error),
            });
          },
          assertRuntimeClosed: () => {
            if (maker.getSession(sessionId)) {
              throwIpcError(
                'PRECONDITION_FAILED',
                'rejected Pi runtime could not be closed; runtime selection was not changed',
              );
            }
          },
        });
      const persistedSessionMeta = liveSessionBeforeRouteChange
        ? null
        : await maker.getSessionMeta(sessionId);
      const runtimeAgentKind =
        liveSessionBeforeRouteChange?.agentKind ??
        (getSessionDbAgentKind(sessionId)
          ? dbToMakerAgentKind(getSessionDbAgentKind(sessionId))
          : persistedSessionMeta?.agentKind);
      const targetRouteProviderId = targetProviderId;
      let currentRuntimeModel = liveSessionBeforeRouteChange?.model ??
        internalOptions.previousPiRoute?.model ?? persistedSessionMeta?.model;
      let runtimeRouteChanged =
        currentRuntimeModel !== undefined &&
        (currentRuntimeModel !== model || currentProviderId !== targetRouteProviderId);
      const piConfigurationRefresh = runtimeAgentKind === 'pi' && internalOptions.refreshPiConfiguration === true;
      const piPreview = runtimeAgentKind === 'pi' && (runtimeRouteChanged || piConfigurationRefresh) && liveSessionBeforeRouteChange
        ? await liveSessionBeforeRouteChange.previewModelSwitch?.(model, {
            providerId: targetRouteProviderId,
          })
        : undefined;
      if (internalOptions.beforeMutation) await internalOptions.beforeMutation();
      if (runtimeAgentKind === 'pi' && (runtimeRouteChanged || piConfigurationRefresh) && liveSessionBeforeRouteChange) {
        if (!piPreview || piPreview.action === 'unavailable') {
          throwIpcError(
            'PRECONDITION_FAILED',
            piPreview?.reason ?? 'Pi target route cannot be previewed; runtime selection was not changed',
          );
        }
      }
      if (runtimeAgentKind === 'pi' && (runtimeRouteChanged || piConfigurationRefresh)) {
        if (isSessionInTurn(sessionId)) {
          return deferLockedSelection();
        }
        if (!liveSessionBeforeRouteChange && !runtimeStatus.sdkSessionId) {
          // There is no native history to inspect or retire. The next send will
          // create Pi directly with the target route and an empty context.
          coldPiRouteWithoutLiveWindowCheck = true;
        }
        if (!liveSessionBeforeRouteChange && runtimeStatus.remoteHostId && runtimeStatus.sdkSessionId) {
          throwIpcError(
            localModelWindowSwitchErrorCode('MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN'),
            'cold remote Pi runtime cannot verify the target window; runtime selection was not changed',
          );
        }
        if (!liveSessionBeforeRouteChange && runtimeStatus.sdkSessionId) {
          assertRuntimeOwnerCurrent();
          assertSharedTaskCurrent.admit();
          // 冷启动核实(2~3s)只在它可能改变决策时才做：目标窗口对**已知占用**已到
          // danger/overflow 才可能需要缩窗交接 / 二次确认；有余量时任何「当前窗口」
          // 读数都不会触发交接（见 assessRuntimeModelSwitchGate 的 fail-open 矩阵），
          // 让用户白等一次 Pi 冷启动就是纯卡顿（2026-09-21 实报）。
          // 占用取 runtime **关闭时固化的 live 读数**（sessionLastLiveUsage），
          // 不读 sessions.context_tokens：后者只在 turn 正常收尾时落库，中断 / 崩溃
          // 后可能低报真实占用，拿它证明「目标还有余量」会绕过缩窗交接
          // （Greptile P1，2026-09-21）；进程重启 / 硬杀后没有缓存时自动回退到核实。
          // 无原生会话的冷 Pi 也不在本预检范围内（维持既有 fail-closed 语义）。
          const coldPiLastLiveUsage = getSessionLastLiveUsage(sessionId);
          const coldPiTargetContextWindow = lookupVerifiedContextWindow(
            (_agentKind, modelId, pid) =>
              resolveConfiguredContextWindow(getActiveCatalog(), 'pi', pid, modelId, sessionContextWindowBudget),
            model,
            targetRouteProviderId,
            'pi',
          );
          const skipColdPiWindowVerification =
            !!runtimeStatus.sdkSessionId &&
            shouldSkipColdPiWindowRehydration({
              contextTokens: coldPiLastLiveUsage?.contextTokens ?? null,
              targetContextWindow: coldPiTargetContextWindow,
            });
          if (skipColdPiWindowVerification) {
            coldPiRouteWithoutLiveWindowCheck = true;
            log.info('set-model: skipped cold Pi window verification', {
              sessionId,
              reason: 'target-window-has-headroom',
              contextTokens: coldPiLastLiveUsage?.contextTokens ?? null,
              contextWindow: coldPiLastLiveUsage?.contextWindow ?? null,
              capturedAtMs: coldPiLastLiveUsage?.capturedAtMs ?? null,
              targetContextWindow: coldPiTargetContextWindow,
              fromModel: currentRuntimeModel ?? null,
              toModel: model,
              currentProviderId,
              nextProviderId: targetRouteProviderId,
            });
          } else {
            // 原始失败原因必须留下来（#5508）：同一条冷路径每次重试都会再失败，
            // 没有类别与原因就无法区分会话行缺失、工作目录丢失还是 bootstrap 失败。
            // 完整原因只进 Main 日志；IPC 错误只带类别与脱敏概述，错误码与 fail-closed 不变。
            const coldPiFailureContext = {
              sessionId,
              fromModel: currentRuntimeModel ?? null,
              toModel: model,
              currentProviderId,
              nextProviderId: targetRouteProviderId,
            };
            let coldPiRehydrationFailed = false;
            try {
              await rehydrateColdPiRuntimeForWindowVerification(sessionId);
            } catch (error) {
              // 恢复失败不再阻断切模（存量 BYOM 路由死锁修复，2026-10-10）：核实是护栏
              // 不是闸门。存量路由已死（provider 被删/不再提供该模型）时 bootstrap 按
              // fail-closed 语义必然失败；若据此拒绝切模，用户既发不出去也切不走，
              // 会话永久卡死。这里降级为「无当前窗口读数」继续：闸门矩阵对未知窗口
              // fail-open 放行热切，目标路由由下一次发送懒创建；届时 bootstrap 失败
              // 会带真实原因浮现。完整原因仍进 Main 日志（#5508）。
              logColdPiRehydrationFailure({ log }, coldPiFailureContext, error);
              coldPiRehydrationFailed = true;
              coldPiRouteWithoutLiveWindowCheck = true;
            }
            liveSessionBeforeRouteChange = maker.getSession(sessionId);
            // 落点分支表见 classifyColdPiRehydrationOutcome：只有「bootstrap 声称成功
            // 却没有活会话」这种非降级形状保留原 fail-closed 出口。
            const coldPiRehydrationOutcome = classifyColdPiRehydrationOutcome({
              rehydrationFailed: coldPiRehydrationFailed,
              liveAfterBootstrap: liveSessionBeforeRouteChange !== undefined,
            });
            if (coldPiRehydrationOutcome === 'fail-closed') {
              reportColdPiRehydrationFailure(
                {
                  log,
                  throwIpcError,
                  errorCode: localModelWindowSwitchErrorCode('MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN'),
                },
                coldPiFailureContext,
                new ColdPiRehydrationError('runtime-not-live', 'rehydrated Pi runtime is not live after bootstrap'),
              );
            }
            if (coldPiRehydrationOutcome === 'verified' && liveSessionBeforeRouteChange) {
              rehydratedColdPiRuntime = liveSessionBeforeRouteChange;
              currentRuntimeModel = liveSessionBeforeRouteChange.model;
              runtimeRouteChanged =
                currentRuntimeModel !== model || currentProviderId !== targetRouteProviderId;
            }
          }
        }
      }
      let targetContextWindow: number | undefined;
      let verifiedCurrentWindow: number | undefined;
      let modelWindowContextNeedsProtection = false;
      let modelWindowRebuilt = false;
      if (runtimeAgentKind && (runtimeRouteChanged || piConfigurationRefresh || confirmedContextWindow !== undefined)) {
        const resolveRouteWindow = (_agentKind: string, modelId: string, pid: string | null) =>
          sshCodexProviders
            ? resolveVerifiedContextWindow({ providers: sshCodexProviders }, runtimeAgentKind, pid ?? 'openai', modelId)
            : resolveConfiguredContextWindow(
                getActiveCatalog(), runtimeAgentKind, pid, modelId, sessionContextWindowBudget,
              );
        const catalogTargetWindow = lookupVerifiedContextWindow(
          resolveRouteWindow,
          model,
          targetRouteProviderId,
          runtimeAgentKind,
        );
        const verifiedTargetWindow =
          runtimeAgentKind === 'pi' && piPreview?.windowVerified === true &&
          typeof piPreview.targetContextWindow === 'number' && piPreview.targetContextWindow > 0
            ? catalogTargetWindow === null
              ? piPreview.targetContextWindow
              : Math.min(piPreview.targetContextWindow, catalogTargetWindow)
            : catalogTargetWindow;
        const catalogCurrentWindow =
          lookupVerifiedContextWindow(
            resolveRouteWindow,
            currentRuntimeModel,
            currentProviderId,
            runtimeAgentKind,
          ) ?? undefined;
        const liveCurrentWindow = liveSessionBeforeRouteChange?.getUsageSnapshot?.().contextWindow;
        // Pi 的有效窗口只能相信运行时上报值；其它引擎的缩窗闸门只接受目录核实值。
        verifiedCurrentWindow =
          runtimeAgentKind === 'pi'
            ? typeof liveCurrentWindow === 'number' &&
              Number.isFinite(liveCurrentWindow) &&
              liveCurrentWindow > 0
              ? liveCurrentWindow
              : undefined
            : catalogCurrentWindow;
        const targetDoesNotShrink =
          typeof verifiedCurrentWindow === 'number' &&
          typeof verifiedTargetWindow === 'number' &&
          verifiedTargetWindow >= verifiedCurrentWindow;
        // Materialized/user-provider catalog windows can be display-only fallbacks.
        // A destructive native-context rebuild may use only a route-verified window.
        targetContextWindow = verifiedTargetWindow ?? undefined;
        if (
          confirmedContextWindow !== undefined &&
          runtimeAgentKind !== 'pi' &&
          confirmedContextWindow !== targetContextWindow
        ) {
          throwIpcError(
            isDeviceLinkInvoke() ? 'PRECONDITION_FAILED' : 'INVALID_PARAMS',
            'confirmedContextWindow does not match the verified target window',
          );
        }
        // A remote Pi confirmation may name the smaller window verified by the
        // previous final get_state. Re-run the catalog-window preflight first;
        // only the next final Pi verification may consume that confirmation.
        if (!isDeviceLinkInvoke() && runtimeAgentKind === 'pi' &&
            !runtimeStatus.orcaRole && !parseOrcaRemoteLead(runtimeStatus.orcaRemoteLead)) {
          targetContextWindow = confirmedContextWindow ?? targetContextWindow;
        }
        const persistedContextTokens =
          typeof runtimeStatus.contextTokens === 'number' &&
          Number.isFinite(runtimeStatus.contextTokens) &&
          runtimeStatus.contextTokens >= 0
            ? runtimeStatus.contextTokens
            : null;
        const liveContextTokens = liveSessionBeforeRouteChange?.getUsageSnapshot?.().contextTokens;
        const verifiedLiveContextTokens =
          typeof liveContextTokens === 'number' && Number.isFinite(liveContextTokens)
            ? liveContextTokens
            : null;
        const liveUsageIsAuthoritative =
          verifiedLiveContextTokens !== null &&
          (verifiedLiveContextTokens > 0 || persistedContextTokens === 0);
        const contextTokensKnown = liveUsageIsAuthoritative || persistedContextTokens !== null;
        const contextTokens = liveUsageIsAuthoritative
          ? verifiedLiveContextTokens
          : (persistedContextTokens ?? 0);
        modelWindowContextNeedsProtection = hasModelWindowContextToProtect(
          contextTokensKnown,
          contextTokens,
        );
        const modelSwitchPlan = planUserRuntimeModelSwitch({
          agentKind: runtimeAgentKind ?? 'claude-code',
          model,
          providerId: targetRouteProviderId ?? null,
          currentFastMode: getSessionFastMode(sessionId),
          gate: {
            inTurn: isSessionInTurn(sessionId),
            isRemote: !!runtimeStatus.remoteHostId ||
              (!internalOptions.applyingUserSelectionOnSend && isDeviceLinkInvoke()),
            agentKind: runtimeAgentKind,
            runtimeRouteChanged: runtimeRouteChanged || piConfigurationRefresh,
            verifiedTargetWindow,
            verifiedCurrentWindow,
            contextTokensKnown,
            contextTokens,
          },
          ...(atomicSelection ? { selection: atomicSelection } : {}),
        });
        if (modelSwitchPlan.outcome === 'defer') {
          return deferLockedSelection();
        }
        if (modelSwitchPlan.outcome === 'reject') {
          throwIpcError(
            localModelWindowSwitchErrorCode('MODEL_WINDOW_REMOTE_REBUILD_UNSUPPORTED'),
            'remote model-window rebuild is unsupported; runtime selection was not changed',
          );
        }
        if (
          !modelSwitchPlan.skipRebuild &&
          typeof targetContextWindow === 'number' &&
          targetContextWindow > 0 &&
          !targetDoesNotShrink
        ) {
          if (!host.contextOverflowRolloverHolder) {
            throwIpcError(
              localModelWindowSwitchErrorCode('MODEL_WINDOW_PROTECTION_UNAVAILABLE'),
              'model window switch protection is unavailable; runtime selection was not changed',
            );
          }
          let pendingClearedForWindowRebuild = false;
          let confirmationContextTokens: number | undefined;
          let preparation: ModelWindowSwitchPreparationResult;
          try {
            preparation = await host.contextOverflowRolloverHolder.prepareModelWindowSwitch(sessionId, {
              contextWindow: targetContextWindow!,
              recheckTargetPressure: true,
              confirmedTargetPressure:
                (internalOptions.source === 'user' && internalOptions.applyingUserSelectionOnSend === true &&
                  !runtimeStatus.orcaRole && !parseOrcaRemoteLead(runtimeStatus.orcaRemoteLead)) ||
                (!isDeviceLinkInvoke() && confirmedContextWindow === targetContextWindow),
              onConfirmationRequired: (contextTokens) => {
                confirmationContextTokens = contextTokens;
              },
              assertCanCommit: () => { assertRuntimeOwnerCurrent(); assertSharedTaskCurrent.admit(); },
              beforeClose: () => {
                if (!internalOptions.applyingPiCredentialPending) {
                  clearPendingCredentialSwitchForSession(sessionId, { wake: false });
                  pendingClearedForWindowRebuild = true;
                }
              },
            });
          } catch (error) {
            if (
              pendingClearedForWindowRebuild &&
              sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)
            ) {
              if (previousRuntime.pendingCredentialSwitch) {
                host.pendingCredentialSwitchHolder?.register(
                  sessionId,
                  previousRuntime.pendingCredentialSwitch,
                );
              } else {
                wakeSessionInputAfterCredentialSwitch(sessionId);
              }
            }
            throw error;
          }
          if (preparation === 'confirmation-required') {
            if (!previousRuntime.hadLiveSession && maker.getSession(sessionId)) {
              await withRehydrateCloseSuppressed(sessionId, () => maker.closeSession(sessionId));
            }
            restoreControlStores();
            if (isDeviceLinkInvoke()) {
              throwIpcError(
                'PRECONDITION_FAILED',
                'remote model-window confirmation is unsupported; runtime selection was not changed',
              );
            }
            if (!confirmationContextTokens || confirmationContextTokens <= 0) {
              throwIpcError(
                localModelWindowSwitchErrorCode('MODEL_CONTEXT_USAGE_UNKNOWN'),
                'verified model-window confirmation usage is unavailable',
              );
            }
            return {
              deferred: false,
              superseded: false,
              contextWindowConfirmationRequired: targetContextWindow,
              contextTokensForConfirmation: confirmationContextTokens,
            };
          }
          if (preparation === 'busy') {
            return deferLockedSelection();
          }
          if (preparation === 'remote-unsupported') {
            throwIpcError(
              localModelWindowSwitchErrorCode('MODEL_WINDOW_REMOTE_REBUILD_UNSUPPORTED'),
              'this remote task cannot safely rebuild context for the smaller model window',
            );
          }
          if (preparation === 'unknown-context') {
            if (!previousRuntime.hadLiveSession && maker.getSession(sessionId)) {
              await withRehydrateCloseSuppressed(sessionId, () => maker.closeSession(sessionId));
            }
            throwIpcError(
              localModelWindowSwitchErrorCode('MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN'),
              'current context window is unknown; runtime selection was not changed',
            );
          }
          if (preparation === 'in-flight') {
            throwIpcError(
              localModelWindowSwitchErrorCode('MODEL_WINDOW_PREPARATION_IN_PROGRESS'),
              'context preparation is already running; retry the model switch after it finishes',
            );
          }
          assertRuntimeOwnerCurrent();
          modelWindowRebuilt = preparation === 'rebuilt';
          if (
            modelWindowRebuilt &&
            effectiveProviderId === undefined &&
            previousRuntime.pendingCredentialSwitch
          ) {
            // beforeClose deliberately cleared the stale pending record so it
            // cannot finalize against the retiring native session. Preserve its
            // provider intent as an explicit route for this accepted switch.
            effectiveProviderId = targetRouteProviderId;
          }
        }
      }
      const reconcileRetainedLiveProfile = async (): Promise<void> => {
        const retainedSession = maker.getSession(sessionId);
        if (!retainedSession || !sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)) {
          return;
        }
        const retainedProviderId =
          effectiveProviderId === undefined
            ? (previousRuntime.providerId ?? null)
            : (normalizeSessionProviderId(effectiveProviderId) ?? null);
        let targetModelHasFixedEffort = atomicSelection?.effort === null;
        if (!targetModelHasFixedEffort) {
          try {
            const retainedProviders = await getDesktopProviderService().listProviders({
              allowSideEffects: false,
              catalog: getActiveCatalog(),
            });
            const actualRetainedProviderId =
              retainedProviderId ??
              effectiveSourceIdForModel(
                retainedProviders,
                null,
                retainedSession.model,
                retainedSession.agentKind,
              );
            const retainedProvider = retainedProviders.find(
              (provider) => provider.id === actualRetainedProviderId,
            );
            targetModelHasFixedEffort =
              findCatalogModel(retainedProvider, retainedSession.model, retainedSession.agentKind, {
                exact: true,
              })?.efforts.length === 0;
          } catch (error) {
            log.debug('retained runtime model capability lookup failed', {
              sessionId,
              model: retainedSession.model,
              providerId: retainedProviderId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (!sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)) {
          return;
        }
        const retainedProfile: SessionRuntimeProfile = {
          agentKind: retainedSession.agentKind,
          model: retainedSession.model,
          providerId: retainedProviderId,
          effort: resolveRetainedRuntimeEffort({
            targetModelHasFixedEffort,
            requestedEffort: atomicSelection?.effort,
            liveEffort: retainedSession.getEffort(),
            previousEffort: previousRuntime.effort,
          }),
          fastMode: retainedSession.getFastMode() ?? previousRuntime.fastMode,
        };
        if (effectiveProviderId !== undefined) {
          setSessionProvider(sessionId, retainedProfile.providerId);
        }
        setSessionEffort(sessionId, retainedProfile.effort);
        setSessionFastMode(sessionId, retainedProfile.fastMode);
        if (!internalOptions.applyingPiCredentialPending) host.pendingCredentialSwitchHolder?.clear(sessionId);
        if (internalOptions.source === 'user') {
          recordRecoveredSessionRuntimeMutation(sessionId, retainedProfile);
        } else if (!routeExplicit) {
          recordRecoveredSessionRuntimeAxisMutation(sessionId, retainedProfile);
        } else {
          acceptSessionRuntimeMutation({
            sessionId,
            source: internalOptions.source,
            previousProfile: internalOptions.previousProfile,
            profile: retainedProfile,
            deferred: false,
          });
        }
        if (!internalOptions.applyingUserSelectionOnSend) {
          agentSwitchPending.clear(sessionId);
          broadcastSessionPatched(sessionId, {
            agentSwitchIntent: null,
            agentSwitchIntentCanceled: true,
          });
        }
        wakeSessionInputAfterCredentialSwitch(sessionId);
        await broadcastSessionRuntimeProjection(sessionId).catch((error) => {
          log.debug('recovered runtime projection broadcast failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      };
      try {
        const transferDb = getCurrentDbClientSnapshot();
        const transferOwner = captureDataOwnerBroadcastScope();
        // A completed, owner-fenced window handoff may have already replaced the
        // native thread during this same locked selection.
        const transferStatus = modelWindowRebuilt && runtimeAgentKind === 'codex'
          ? (await transferDb!.client.drizzle.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1))[0]
          : runtimeStatus;
        assertRuntimeOwnerCurrent();
        if (!transferStatus || transferStatus.status !== 'active') {
          throw new Error('Codex writer transfer task changed');
        }
        const transferMeta = runtimeAgentKind === 'codex' ? await maker.getSessionMeta(sessionId) : null;
        const transferTarget = {
          sessionId,
          model,
          providerId: targetRouteProviderId,
          remoteHostId: transferStatus.remoteHostId ?? undefined,
          ...(transferMeta?.reviewMode ? { reviewMode: true as const } : {}),
        };
        const canTransferThread = routeExplicit && runtimeAgentKind === 'codex' &&
          !transferStatus.remoteHostId && !!transferStatus.sdkSessionId;
        const assertTransferOwner = () => {
          assertRuntimeOwnerCurrent();
          if (!transferDb || !isDataOwnerBroadcastScopeCurrent(transferOwner) ||
              getCurrentDbClientSnapshot()?.clientEpoch !== transferDb.clientEpoch) {
            throw new Error('Codex writer transfer owner changed');
          }
        };
        const relinkCodexThread = async () => {
          assertTransferOwner();
          const sourceSnapshot = { ...transferStatus, id: sessionId };
          const sourcePredicate = codexThreadTransferSourcePredicate(sourceSnapshot);
          const transferred = await relinkCodexProviderThread({
            readSource: async () => {
              assertTransferOwner();
              const [source] = await transferDb!.client.drizzle.select({ id: sessions.id })
                .from(sessions).where(sourcePredicate).limit(1);
              assertTransferOwner();
              if (!source) throw new Error('Codex writer transfer source changed');
              return {
                sdkSessionId: transferStatus.sdkSessionId,
                model: transferStatus.model ?? currentRuntimeModel ?? model,
                providerId: transferStatus.providerId,
                effort: transferStatus.effort,
                fastMode: transferStatus.fastMode,
                workingDir: transferStatus.workingDir,
              };
            },
            needsFork: async (threadId) => {
              assertTransferOwner();
              return maker.requiresCodexThreadHostTransfer({ ...transferTarget, threadId });
            },
            fork: async ({ sourceSdkSessionId, workingDir }) => {
              assertTransferOwner();
              // Native fork never rewrites source history. The core owns the one-shot
              // writer exit barrier; use the destination route, even if old auth expired.
              return maker.forkSdkSession('codex', {
                sourceSdkSessionId, workingDir, model,
                upToMessageId: undefined,
                providerId: targetRouteProviderId,
                stripEncryptedReasoning: false,
              });
            },
            commit: async ({ newSdkSessionId, target }) => {
              assertTransferOwner();
              return commitCodexThreadTransfer(transferDb!.client, sourceSnapshot, {
                sdkSessionId: newSdkSessionId,
                model: target.model,
                providerId: target.providerId,
                ...(target.effort !== null && isSupportedRuntimeEffort(target.effort) ? { effort: target.effort } : {}),
                fastMode: target.fastMode,
                ...(modelWindowRebuilt && targetContextWindow ? { contextWindow: targetContextWindow } : {}),
              });
            },
          }, {
            sessionId,
            target: {
              model, providerId: targetRouteProviderId,
              effort: atomicSelection ? atomicSelection.effort : transferStatus.effort,
              fastMode: atomicSelection ? atomicSelection.fastMode : transferStatus.fastMode,
            },
          });
          assertTransferOwner();
          if (transferred) {
            try {
              broadcastSessionPatched(sessionId, {
                sdkSessionId: transferred.newSdkSessionId,
                model, providerId: targetRouteProviderId,
              }, transferOwner);
            } catch (error) {
              log.warn('Codex writer transfer projection failed after commit', {
                sessionId, error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        };
        assertRuntimeOwnerCurrent();
        const result: Awaited<ReturnType<typeof applyRuntimeSetModelChange>> = routeExplicit
          ? await applyRuntimeSetModelChange({
              maker,
              beforeMutation: internalOptions.beforeMutation,
              admit: () => { assertRuntimeOwnerCurrent(); assertSharedTaskCurrent.admit(); },
              sessionId,
              model,
              providerId: effectiveProviderId,
              ...(piConfigurationRefresh ? { refreshPiConfiguration: true } : {}),
              ...(canTransferThread ? {
                requiresCodexThreadRelink: () => maker.requiresCodexThreadHostTransfer({
                  ...transferTarget, threadId: transferStatus.sdkSessionId!,
                }),
                relinkCodexThread,
              } : {}),
              ...(atomicSelection?.effort
                ? {
                    effort: atomicSelection.effort as
                      'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra',
                  }
                : {}),
              // Pi 切模后不重置 thinking level：把 renderer 记录的目标模型思考开关
              // 意图交给 runtime，由 Pi 按目标模型能力快照收敛（否则上一个模型的
              // off/旧档位会漂移给新模型）。非 Pi 引擎忽略该参数。
              ...(runtimeAgentKind === 'pi' && atomicSelection?.thinking !== undefined
                ? { thinkingEnabled: atomicSelection.thinking }
                : {}),
              forceSessionRebuild:
                rebuildLiveOrcaWorker ||
                (atomicSelection?.effort === null && runtimeAgentKind !== 'pi'),
              isSessionInTurn,
              registerPendingCredentialSwitch: registerPendingCredentialSwitchForSession,
              clearPendingCredentialSwitch: internalOptions.applyingPiCredentialPending
                ? () => {}
                : atomicSelection ||
                (runtimeAgentKind === 'pi' && (runtimeRouteChanged || piConfigurationRefresh))
                ? (pendingSessionId) =>
                    clearPendingCredentialSwitchForSession(pendingSessionId, { wake: false })
                : clearPendingCredentialSwitchForSession,
              // Worker rebuild must publish the accepted runtime profile before queued input
              // can lazy-create the replacement execution unit.
              ...(!rebuildLiveOrcaWorker && !atomicSelection &&
                !(runtimeAgentKind === 'pi' && (runtimeRouteChanged || piConfigurationRefresh))
                ? { wakeSessionInputQueue: wakeSessionInputAfterCredentialSwitch }
                : {}),
              getPendingCredentialSwitch: getPendingCredentialSwitchTarget,
              // 解析隐式来源的凭证家族,精确判定是否跨远端压缩身份边界(见
              // shouldCloseSessionForCredentialSwitch.codexAuthInjection)。
              codexAuthInjection: getCodexProxyAuthInjectionState(sessionId),
              logger: log,
            })
          : { status: 'applied' };
        // deferred = 会话自己在跑,选择已登记、turn 结束自动生效。renderer 据此提示
        // "任务结束后生效"而不是当成已即时切换。
        const response = {
          deferred: result.status === 'deferred',
          superseded: false,
        };
        if (supersededByOwnerBoundary()) {
          return { deferred: false, superseded: true };
        }
        if (result.persistedRoute === true && isDeviceLinkInvoke()) {
          markRemoteSettingPersistedInsideHandler?.(response);
        }
        const piSessionAfterRouteChange = maker.getSession(sessionId);
        if (
          runtimeAgentKind === 'pi' &&
          (runtimeRouteChanged || piConfigurationRefresh) &&
          result.status !== 'deferred' &&
          result.retiredRuntime !== true &&
          !modelWindowRebuilt &&
          !coldPiRouteWithoutLiveWindowCheck
        ) {
          if (!piSessionAfterRouteChange) {
            restoreControlStores();
            throwIpcError(
              localModelWindowSwitchErrorCode('MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN'),
              'Pi target runtime could not be verified; runtime selection was not accepted',
            );
          }
          const reportedPiWindow = piSessionAfterRouteChange.getUsageSnapshot?.().contextWindow;
          if (typeof reportedPiWindow !== 'number' || !Number.isFinite(reportedPiWindow) || reportedPiWindow <= 0) {
            await closeRejectedPiRuntime('final context window was not verified');
            throwIpcError(
              localModelWindowSwitchErrorCode('MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN'),
              'Pi did not expose its verified final context window; runtime selection was not accepted',
            );
          }
          // Pi reports the configured native budget, which may exceed the route
          // ceiling. Final verification must not undo the history safety cap.
          const verifiedPiWindow = resolveConfiguredContextWindow(
            getActiveCatalog(), 'pi', targetRouteProviderId, model, sessionContextWindowBudget,
          );
          const finalPiWindow = verifiedPiWindow === null
            ? reportedPiWindow : Math.min(reportedPiWindow, verifiedPiWindow);
          targetContextWindow = finalPiWindow;
          if (
            modelWindowContextNeedsProtection &&
            typeof verifiedCurrentWindow === 'number' &&
            finalPiWindow < verifiedCurrentWindow!
          ) {
            if (!host.contextOverflowRolloverHolder) {
              await closeRejectedPiRuntime('model-window protection was unavailable');
              throwIpcError(
                localModelWindowSwitchErrorCode('MODEL_WINDOW_PROTECTION_UNAVAILABLE'),
                'model window switch protection is unavailable; runtime selection was not changed',
              );
            }
            let finalPressureContextTokens: number | undefined;
            let finalPreparation: ModelWindowSwitchPreparationResult;
            try {
              finalPreparation = await host.contextOverflowRolloverHolder.prepareModelWindowSwitch(
                sessionId,
                {
                  contextWindow: finalPiWindow,
                  recheckTargetPressure: true,
                  confirmedTargetPressure:
                    (internalOptions.source === 'user' && internalOptions.applyingUserSelectionOnSend === true &&
                      !runtimeStatus.orcaRole && !parseOrcaRemoteLead(runtimeStatus.orcaRemoteLead)) ||
                    (!isDeviceLinkInvoke() && confirmedContextWindow === finalPiWindow),
                  onConfirmationRequired: (contextTokens) => {
                    finalPressureContextTokens = contextTokens;
                  },
                  assertCanCommit: assertRuntimeOwnerCurrent,
                },
              );
            } catch (error) {
              await closeRejectedPiRuntime('final-window preparation threw');
              throw error;
            }
            if (finalPreparation === 'confirmation-required') {
              assertRuntimeOwnerCurrent();
              await closeRejectedPiRuntime('final-window confirmation was required');
              if (isDeviceLinkInvoke()) {
                throwIpcError(
                  'PRECONDITION_FAILED',
                  'remote model-window confirmation is unsupported; runtime selection was not changed',
                );
              }
              return {
                ...response,
                contextWindowConfirmationRequired: finalPiWindow,
                contextTokensForConfirmation: finalPressureContextTokens,
              };
            }
            if (finalPreparation === 'rebuilt') {
              modelWindowRebuilt = true;
              targetContextWindow = finalPiWindow;
            } else if (finalPreparation !== 'not-needed') {
              await closeRejectedPiRuntime(`final-window preparation returned ${finalPreparation}`);
              const finalPreparationCode =
                finalPreparation === 'remote-unsupported'
                  ? 'MODEL_WINDOW_REMOTE_REBUILD_UNSUPPORTED'
                  : finalPreparation === 'busy'
                    ? 'MODEL_SWITCH_TASK_RUNNING'
                    : finalPreparation === 'in-flight'
                      ? 'MODEL_WINDOW_PREPARATION_IN_PROGRESS'
                      : 'MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN';
              throwIpcError(
                localModelWindowSwitchErrorCode(finalPreparationCode),
                finalPreparation === 'remote-unsupported'
                  ? 'remote model-window rebuild is unsupported; runtime selection was not changed'
                  : `Pi final-window context preparation failed: ${finalPreparation}`,
              );
            }
          }
        }
        if (atomicSelection) {
          const selectionToCommit = atomicSelection;
          assertRuntimeOwnerCurrent();
          assertSharedTaskCurrent.admit();
          // model/provider/effort/fast 是一次选择快照，必须在同一把 session 锁内收敛。
          // applyRuntimeSetModelChange 可能 close + wake；若 effort/fast 留给 renderer
          // 后续独立调用，queue drain 会用新 model + 旧偏好重建，跨控制端时还会发生
          // 旧请求尾写覆盖新选择。
          const commitControlStores = () => {
            setSessionEffort(sessionId, selectionToCommit.effort);
            setSessionFastMode(sessionId, selectionToCommit.fastMode);
          };
          const sess = maker.getSession(sessionId);
          if (
            sess &&
            result.status !== 'deferred' &&
            !host.pendingCredentialSwitchHolder?.has(sessionId)
          ) {
            await applyRuntimeSelectionAxesWithRecovery({
              session: sess,
              effort: selectionToCommit.effort,
              fastMode: selectionToCommit.fastMode,
              applyEffort:
                runtimeAgentKind !== 'pi' &&
                (routeExplicit || internalOptions.effortExplicit === true),
              applyFastMode: routeExplicit || internalOptions.fastExplicit === true,
              assertCanCommit: assertRuntimeOwnerCurrent,
              commitControlStores,
              restoreControlStores,
              terminateSession: () =>
                withRehydrateCloseSuppressed(sessionId, () => maker.closeSession(sessionId)),
              recoverLiveProfileAfterTerminationFailure: reconcileRetainedLiveProfile,
            });
          } else {
            commitControlStores();
          }
        }
        if (
          result.persistedRoute !== true &&
          (modelWindowRebuilt ||
            (runtimeAgentKind === 'pi' && (runtimeRouteChanged || piConfigurationRefresh)) ||
            (internalOptions.source === 'user' && (isDeviceLinkInvoke() || host.persistsLocalModelSelection === true || atomicSelection)))
        ) {
          // device-link 的通用持久化原本发生在 handler 返回、session 锁释放之后；
          // 本地 renderer 的 sessionService.update 也有同一窗口。凡携带 selection 的
          // 新调用都由 host 在解锁前一次落定全部字段。
          const patch: Record<string, unknown> = { model };
          if (effectiveProviderId !== undefined) {
            patch.providerId = normalizeSessionProviderId(
              typeof effectiveProviderId === 'string' ? effectiveProviderId : null,
            );
          }
          if (atomicSelection) {
            // 固定 effort 模型(efforts.length === 0)的运行时语义是 effort: null,
            // 但 sessions.effort 列是 NOT NULL —— 运行时能力与持久化表示在此分离:
            // DB patch 省略该字段,行内保留旧模型的历史合法值;内存 store(上面
            // commitControlStores / setSessionEffort)照常清为 null,重启后按目标
            // 模型能力重新归一化。不写 ''/"none" 等枚举外值,不改 schema。
            if (atomicSelection.effort !== null) {
              patch.effort = atomicSelection.effort;
            }
            patch.fastMode = atomicSelection.fastMode;
          }
          if (modelWindowRebuilt && targetContextWindow) {
            patch.contextWindow = targetContextWindow;
          }
          const routeProjectionOwnerScope = captureDataOwnerBroadcastScope();
          try {
            assertRuntimeOwnerCurrent();
            assertSharedTaskCurrent.admit();
            await persistSessionFields(sessionId, patch);
          } catch (persistenceError) {
            // The live route and host stores are applied before SQLite so the
            // harness can switch atomically. If SQLite rejects, unwind every
            // in-memory side effect while generation/effectiveOverride still
            // describe the old profile.
            if (!internalOptions.applyingPiCredentialPending) host.pendingCredentialSwitchHolder?.clear(sessionId);
            restoreControlStores();
            let recoveryError: unknown;
            const shouldCloseRuntimeAfterPersistenceFailure =
              (result.status !== 'deferred' && previousRuntime.hadLiveSession) ||
              rehydratedColdPiRuntime !== undefined;
            if (
              shouldCloseRuntimeAfterPersistenceFailure &&
              maker.getSession(sessionId)
            ) {
              try {
                await withRehydrateCloseSuppressed(sessionId, () => maker.closeSession(sessionId));
              } catch (error) {
                recoveryError = error;
              }
            }
            if (previousRuntime.pendingCredentialSwitch) {
              host.pendingCredentialSwitchHolder?.register(
                sessionId,
                previousRuntime.pendingCredentialSwitch,
              );
            } else if (!recoveryError && !internalOptions.applyingPiCredentialPending) {
              wakeSessionInputAfterCredentialSwitch(sessionId);
            }
            if (recoveryError) {
              await reconcileRetainedLiveProfile();
              throw new AggregateError(
                [persistenceError, recoveryError],
                'runtime selection persistence and session recovery both failed',
              );
            }
            throw persistenceError;
          }
          if (modelWindowRebuilt && targetContextWindow) {
            // commitRebuild first projects zero usage against the still-authoritative
            // source route. Publish the accepted final window only after its route
            // persistence succeeds, keeping rollback projections on the source window.
            broadcastSessionPatched(
              sessionId,
              {
                contextTokens: 0,
                contextWindow: targetContextWindow,
              },
              routeProjectionOwnerScope,
            );
          }
          if (isDeviceLinkInvoke()) {
            // dispatch 继续兼容最小/旧 handler 的锁外回流；标记本结果避免重复写。
            markRemoteSettingPersistedInsideHandler?.(response);
          }
        }
        if (!internalOptions.applyingUserSelectionOnSend) {
          agentSwitchPending.clear(sessionId);
          broadcastSessionPatched(sessionId, {
            agentSwitchIntent: null,
            agentSwitchIntentCanceled: true,
          });
        }
        if (supersededByOwnerBoundary()) {
          return { deferred: false, superseded: true };
        }
        let generation: number;
        if (internalOptions.source === 'user') {
          if (!internalOptions.configStaged) await updateScheduledPreference(sessionId, null);
          generation = recordUserSessionRuntimeMutation(sessionId);
        } else if (internalOptions.applyingPendingGeneration !== undefined) {
          if (!response.deferred) {
            settlePendingSessionRuntimeMutation(
              sessionId,
              internalOptions.applyingPendingGeneration,
            );
          }
          generation = getSessionRuntimeControlSnapshot(sessionId).generation;
        } else if (!routeExplicit) {
          const meta = await maker.getSessionMeta(sessionId);
          generation = acceptSessionRuntimeAxisMutation({
            sessionId,
            source: internalOptions.source,
            profile: buildDeferredRuntimeSelectionProfile({
              agentKind: maker.getSession(sessionId)?.agentKind ?? meta?.agentKind ?? 'claude-code',
              model,
              providerId: getSessionProvider(sessionId),
              atomicSelection,
              currentEffort,
              currentFastMode: previousRuntime.fastMode,
            }),
            pendingPatch: pendingAxisPatch,
          });
        } else {
          const meta = await maker.getSessionMeta(sessionId);
          generation = acceptSessionRuntimeMutation({
            sessionId,
            source: internalOptions.source,
            previousProfile: internalOptions.previousProfile,
            deferred: response.deferred,
            ...(atomicSelection?.thinking !== undefined
              ? { thinking: atomicSelection.thinking }
              : {}),
            profile: buildDeferredRuntimeSelectionProfile({
              agentKind: maker.getSession(sessionId)?.agentKind ?? meta?.agentKind ?? 'claude-code',
              model,
              providerId:
                effectiveProviderId === undefined
                  ? getSessionProvider(sessionId)
                  : (normalizeSessionProviderId(effectiveProviderId) ?? null),
              atomicSelection,
              currentEffort,
              currentFastMode: getSessionFastMode(sessionId),
            }),
          });
        }
        if (!internalOptions.applyingPiCredentialPending && (rebuildLiveOrcaWorker || modelWindowRebuilt || atomicSelection ||
          (runtimeAgentKind === 'pi' && (runtimeRouteChanged || piConfigurationRefresh))) && !response.deferred) {
          wakeSessionInputAfterCredentialSwitch(sessionId);
        }
        if (!response.deferred) {
          try {
            const currentAgentKind =
              maker.getSession(sessionId)?.agentKind ??
              dbToMakerAgentKind(getSessionDbAgentKind(sessionId));
            const verifiedWindow = lookupVerifiedContextWindow(
              (agentKind, modelId, pid) =>
                resolveConfiguredContextWindow(
                  getActiveCatalog(),
                  dbToMakerAgentKind(agentKind),
                  pid,
                  modelId,
                  sessionContextWindowBudget,
                ),
              model,
              targetRouteProviderId,
              currentAgentKind,
            );
            const piRuntimeWindow = maker.getSession(sessionId)?.getUsageSnapshot?.().contextWindow;
            const snapshotWindow =
              currentAgentKind === 'pi'
                ? typeof piRuntimeWindow === 'number' && piRuntimeWindow > 0
                  ? piRuntimeWindow
                  : null
                : verifiedWindow;
            if (snapshotWindow) {
              const [usage] = await getDbClient()
                .drizzle.select({ contextTokens: sessions.contextTokens })
                .from(sessions)
                .where(eq(sessions.id, sessionId))
                .limit(1);
              await recordSessionContextSnapshot(
                sessionId,
                usage?.contextTokens ?? 0,
                snapshotWindow,
              );
            }
          } catch (error) {
            log.debug('runtime model context snapshot refresh failed', {
              sessionId,
              model,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const projectionMeta = await maker.getSessionMeta(sessionId);
        const userBaselineOverride =
          internalOptions.source === 'user'
            ? buildDeferredRuntimeSelectionProfile({
                agentKind:
                  maker.getSession(sessionId)?.agentKind ??
                  projectionMeta?.agentKind ??
                  'claude-code',
                model,
                providerId:
                  effectiveProviderId === undefined
                    ? getSessionProvider(sessionId)
                    : (normalizeSessionProviderId(effectiveProviderId) ?? null),
                atomicSelection,
                currentEffort,
                currentFastMode: getSessionFastMode(sessionId),
              })
            : undefined;
        await broadcastSessionRuntimeProjection(sessionId, userBaselineOverride).catch((error) => {
          log.debug('session runtime projection broadcast failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        // Preserve object identity so a device-link in-lock persistence mark remains visible
        // to dispatch and cannot be followed by a stale lock-free route write.
        return Object.assign(response, {
          generation,
          effectiveProviderId: effectiveProviderId === undefined
            ? currentProviderId : normalizeSessionProviderId(effectiveProviderId) ?? null,
        });
      } catch (err) {
        // Atomic calls suppress applyRuntimeSetModelChange's early wake. If a later step
        // rejects after clearing an older pending switch, release the queue on the still-
        // authoritative profile; a restored/new pending gate will conservatively block it.
        if (atomicSelection) {
          wakeSessionInputAfterCredentialSwitch(sessionId);
        }
        if (err instanceof CredentialModeSwitchBusyError) {
          // 兜底(正常路径 busy 已转 deferred):切模型撞上凭证切换忙,独立 code,
          // renderer toast 走 ipcError.CREDENTIAL_SWITCH_BUSY 专属文案。
          throwIpcError('CREDENTIAL_SWITCH_BUSY', err.message);
        }
        throw err;
      }
    };
    return internalOptions.sessionLockHeld ? applyLocked() : withSendToSessionLock(sessionId, applyLocked);
  };
return handleSetModel;
}
