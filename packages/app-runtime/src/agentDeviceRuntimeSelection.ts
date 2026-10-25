import type { AgentKind } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import type { SessionModelSelectionHost, AgentDeviceRuntimeSelectionInput } from './sessionModelSelectionHost.js';
import type { SessionRuntimeProfile } from './sessionRuntimeControl.js';
import type { ApplySessionRuntimeSelection } from './sessionRuntimeSelectionTypes.js';
import { normalizeSessionProviderId } from './sessionProviderStore.js';
import { dbToMakerAgentKind } from '@cindy/maker-shared/agent-kind-conversion';
import { projectPendingAgentSwitchIntent } from '@cindy/im-runtime/sessionAgentSwitch';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import { resolveVerifiedContextWindow } from './sessionContextWindow.js';

export interface AgentDeviceRuntimeSelectionHost extends Pick<SessionModelSelectionHost,
  'hasSessionProvider' | 'getSessionProvider' | 'agentSwitchPending' | 'agentSwitchDeps' | 'wakeSessionInputAfterCredentialSwitch' | 'isDeviceLinkInvoke' | 'markRemoteSettingPersistedInsideHandler' | 'maker' | 'isSessionInTurn' | 'withRehydrateCloseSuppressed' | 'setSessionProvider' | 'setSessionEffort' | 'setSessionFastMode' | 'persistSessionFields' | 'updateScheduledPreference' | 'broadcastSessionPatched' | 'getSessionEffort' | 'recordUserSessionRuntimeMutation' | 'acceptSessionRuntimeMutation' | 'broadcastSessionRuntimeProjection' | 'log' | 'contextOverflowRolloverHolder'> {
  assertAgentDeviceRouteUsable(deviceId: string, agent: AgentKind, model: string, providerId: string | null): Promise<void>;
  readUsableAgentDeviceProviders(deviceId: string, agent: AgentKind, model: string, providerId: string | null): Promise<ProviderView[]>;
}

/** Original remote-device model transaction, shared by Desktop and Node hosts. */
export function createAgentDeviceRuntimeSelection(host: AgentDeviceRuntimeSelectionHost) {
  const { hasSessionProvider, getSessionProvider, agentSwitchPending, agentSwitchDeps, wakeSessionInputAfterCredentialSwitch, isDeviceLinkInvoke, markRemoteSettingPersistedInsideHandler, maker, isSessionInTurn, withRehydrateCloseSuppressed, setSessionProvider, setSessionEffort, setSessionFastMode, persistSessionFields, updateScheduledPreference, broadcastSessionPatched, getSessionEffort, recordUserSessionRuntimeMutation, acceptSessionRuntimeMutation, broadcastSessionRuntimeProjection, log, assertAgentDeviceRouteUsable, readUsableAgentDeviceProviders } = host;
  return async (input: AgentDeviceRuntimeSelectionInput): ReturnType<ApplySessionRuntimeSelection> => {
    const {
      sessionId, model, providerId, atomicSelection, internalOptions, runtimeStatus,
      assertRuntimeOwnerCurrent, assertSharedTaskCurrent, supersededByOwnerBoundary,
    } = input;
    let targetContextWindow = typeof input.confirmedContextWindow === 'number' && input.confirmedContextWindow > 0
      ? input.confirmedContextWindow
      : undefined;
    const currentProviderId = hasSessionProvider(sessionId)
      ? getSessionProvider(sessionId)
      : runtimeStatus.providerId?.trim() || null;
    const pendingSelection = agentSwitchPending.get(sessionId);
    const targetProviderId =
      typeof providerId === 'string' || providerId === null
        ? (normalizeSessionProviderId(providerId) ?? null)
        : internalOptions.source === 'user' && pendingSelection?.sameAgentSelection
          ? (pendingSelection.providerId ?? null)
          : currentProviderId;
    const targetEffort = atomicSelection
      ? atomicSelection.effort
      : ((runtimeStatus.effort ?? null) as SessionRuntimeProfile['effort']);
    const targetFastMode = atomicSelection?.fastMode ?? runtimeStatus.fastMode;
    const agentKind = dbToMakerAgentKind(runtimeStatus.agentKind as 'cc' | 'codex' | 'pi');
    if (internalOptions.source === 'user' && !internalOptions.applyingUserSelectionOnSend) {
      assertRuntimeOwnerCurrent();
      assertSharedTaskCurrent.admit();
      // 那台的目录里没有这个模型(例如控制端列的是任务所在电脑的目录)：现在就拒绝，
      // 不登记一个发送时必然失败、之后每次发送都重试的意图。
      if (runtimeStatus.agentDeviceId) {
        await assertAgentDeviceRouteUsable(runtimeStatus.agentDeviceId, agentKind, model, targetProviderId);
        if (supersededByOwnerBoundary()) return { deferred: false, superseded: true };
        assertRuntimeOwnerCurrent();
        assertSharedTaskCurrent.admit();
      }
      const intent = {
        ...(internalOptions.runtimeSource ? { runtimeSource: internalOptions.runtimeSource } : {}),
        ...(internalOptions.configStaged === true ? { configStaged: true } : {}),
        sameAgentSelection: true,
        targetAgentKind: agentKind,
        model,
        providerId: targetProviderId,
        effort: targetEffort ?? undefined,
        fastMode: targetFastMode,
        ...(targetContextWindow ? { confirmedContextWindow: targetContextWindow } : {}),
      };
      agentSwitchPending.set(sessionId, intent);
      agentSwitchDeps.onPendingSwitchChanged?.(sessionId, projectPendingAgentSwitchIntent(intent));
      wakeSessionInputAfterCredentialSwitch(sessionId);
      const response = { deferred: true, superseded: false, pendingUntilSend: true };
      if (isDeviceLinkInvoke()) markRemoteSettingPersistedInsideHandler?.(response);
      return response;
    }
    if (supersededByOwnerBoundary()) return { deferred: false, superseded: true };
    const orcaSelectionOnSend = !!runtimeStatus.orcaRole && internalOptions.source === 'user' &&
      internalOptions.applyingUserSelectionOnSend === true;
    if (orcaSelectionOnSend && runtimeStatus.agentDeviceId) {
      // Selection-time metadata may be absent or stale after a queued turn. Read
      // the execution computer again; an acknowledgement is not window metadata.
      const providers = await readUsableAgentDeviceProviders(
        runtimeStatus.agentDeviceId, agentKind, model, targetProviderId,
      );
      if (supersededByOwnerBoundary()) return { deferred: false, superseded: true };
      assertRuntimeOwnerCurrent();
      targetContextWindow = resolveVerifiedContextWindow({ providers }, agentKind, targetProviderId, model) ?? undefined;
    }
    let live = maker.getSession(sessionId);
    if (live && isSessionInTurn(sessionId)) {
      // 自动跟随(渠道默认 / 回退)在回合中不改；用户的选择由发送边界在回合外落地。
      if (internalOptions.source !== 'user') return { deferred: false, superseded: true };
      throwIpcError('PRECONDITION_FAILED', 'the agent is still working; change the model after this turn');
    }
    assertSharedTaskCurrent.admit();
    // 换到上下文更小的模型：与本机任务同一套保护——占用超过目标窗口的安全线时先把对话交接
    // 成摘要、关掉当前会话，下一次发送按新模型重新开始。Orca 发送前重读目标窗口，
    // 只有本机确认的具体窗口仍匹配时才允许重建，冷恢复也经过同一保护。
    let rebuiltForWindow = false;
    if (orcaSelectionOnSend && targetContextWindow && !host.contextOverflowRolloverHolder) {
      throwIpcError('PRECONDITION_FAILED', 'model window switch protection is unavailable; runtime selection was not changed');
    }
    if ((live || orcaSelectionOnSend) && targetContextWindow && host.contextOverflowRolloverHolder) {
      const prepared = await host.contextOverflowRolloverHolder.prepareModelWindowSwitch(sessionId, {
        contextWindow: targetContextWindow,
        recheckTargetPressure: true,
        confirmedTargetPressure: orcaSelectionOnSend
          ? input.confirmedContextWindow === targetContextWindow
          : internalOptions.applyingUserSelectionOnSend === true,
        assertCanCommit: () => {
          assertRuntimeOwnerCurrent();
          assertSharedTaskCurrent.admit();
        },
      });
      if (prepared === 'busy') {
        throwIpcError('PRECONDITION_FAILED', 'the agent is still working; change the model after this turn');
      }
      if (prepared === 'confirmation-required') {
        return { deferred: false, superseded: false, contextWindowConfirmationRequired: targetContextWindow };
      }
      if (orcaSelectionOnSend && prepared !== 'not-needed' && prepared !== 'rebuilt') {
        throwIpcError('PRECONDITION_FAILED', 'model window switch could not be verified; runtime selection was not changed');
      }
      if (orcaSelectionOnSend) {
        if (supersededByOwnerBoundary()) return { deferred: false, superseded: true };
        assertRuntimeOwnerCurrent();
        assertSharedTaskCurrent.admit();
      }
      rebuiltForWindow = prepared === 'rebuilt';
      // Cold Pi verification can attach a runtime; use that handle for setModel.
      if (orcaSelectionOnSend && !rebuiltForWindow) live = maker.getSession(sessionId);
    }
    if (live && !rebuiltForWindow) {
      // 那台的 Agent 认为需要换进程(跨来源等)时关掉本次连接，下一次发送按新路由重新启动
      // 并接上原来的对话；否则直接在那台的会话里切换。
      const rebuild = await live.requiresModelSwitchRebuild?.(model, { providerId: targetProviderId }) ?? false;
      if (internalOptions.beforeMutation) await internalOptions.beforeMutation();
      assertRuntimeOwnerCurrent();
      if (rebuild) {
        await withRehydrateCloseSuppressed(sessionId, () => maker.closeSession(sessionId, 'runtime-refresh'));
      } else {
        await live.setModel?.(model, {
          providerId: targetProviderId,
          ...(targetEffort ? { effort: targetEffort } : {}),
        });
        if (atomicSelection) await live.setFastMode?.(targetFastMode);
      }
    }
    setSessionProvider(sessionId, targetProviderId);
    if (atomicSelection) {
      setSessionEffort(sessionId, targetEffort);
      setSessionFastMode(sessionId, targetFastMode);
    }
    const patch: Record<string, unknown> = { model, providerId: targetProviderId };
    if (atomicSelection) {
      if (targetEffort !== null) patch.effort = targetEffort;
      patch.fastMode = targetFastMode;
    }
    await persistSessionFields(sessionId, patch);
    if (internalOptions.source === 'user' && !internalOptions.configStaged) {
      await updateScheduledPreference(sessionId, null);
    }
    if (!internalOptions.applyingUserSelectionOnSend) {
      agentSwitchPending.clear(sessionId);
      broadcastSessionPatched(sessionId, { agentSwitchIntent: null, agentSwitchIntentCanceled: true });
    }
    const profile: SessionRuntimeProfile = {
      agentKind,
      agentDeviceId: runtimeStatus.agentDeviceId,
      model,
      providerId: targetProviderId,
      effort: targetEffort ?? (getSessionEffort(sessionId) as SessionRuntimeProfile['effort']) ?? null,
      fastMode: targetFastMode,
    };
    const generation = internalOptions.source === 'user'
      ? recordUserSessionRuntimeMutation(sessionId)
      : acceptSessionRuntimeMutation({
          sessionId,
          source: internalOptions.source,
          previousProfile: internalOptions.previousProfile,
          deferred: false,
          profile,
        });
    wakeSessionInputAfterCredentialSwitch(sessionId);
    await broadcastSessionRuntimeProjection(sessionId, internalOptions.source === 'user' ? profile : undefined)
      .catch((error) => {
        log.debug('agent-device runtime projection broadcast failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return { deferred: false, superseded: false, generation, effectiveProviderId: targetProviderId };
  };
}
