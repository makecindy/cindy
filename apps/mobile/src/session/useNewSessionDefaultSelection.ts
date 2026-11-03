import { useEffect, useRef, type MutableRefObject, type Dispatch, type SetStateAction } from 'react';
import type { UseDeviceProvidersResult } from '@/device-link/useDeviceProviders';
import { mobileDebugLog } from '@/debug/mobileDebugLog';
import { isStoredAgentRestorePending, nextStoredAgentRestoreStep, canResolveStoredAgentRuntime, pickAgentDefaultRuntime, defaultPermissionModeForNewSessionAgent, resolveNewSessionAutoDefault, type NewSessionStoredPreferences, type StoredAgentRestoreState, type NewSessionAgentKind, type NewSessionRuntime, type NewSessionDraft } from './newSession';
import { buildMobileModelSections, flattenProviderSections, isFastRestorable, type ProviderModelRow } from './providerModelSections';
import type { MobileAgentCapabilities, MobileModelOption } from './agentCapabilities';
import type { MobileModelMemoryAccessors } from './draftModelMemory';
import type { NewSessionHostDefaults } from './newSessionHostDefaultsCache';
import { confirmFullAccessChange } from './fullAccessConfirmation';

export function useNewSessionDefaultSelection({
  newSessionPreferences,
  newSessionPreferencesLoaded,
  userTouchedRuntimeRef,
  preferredDefaultDevice,
  selectedDeviceId,
  hostDraftDefaults,
  hostDefaultsSettled,
  hostRuntimeFor,
  deviceProviders,
  deviceProvidersRef,
  catalogReadyRef,
  flatModelsForUnsupportedHost,
  targetAgentHasFast,
  draftMemory,
  autoDefaultDeviceRef,
  setDraft,
  settleRuntime,
  appliedPermissionMemoryRef,
  draft,
  runtimeActionSeqRef,
  selectedDeviceRef,
  capabilities,
  modelRows,
  modelSections,
}: {
  newSessionPreferences: NewSessionStoredPreferences | null;
  newSessionPreferencesLoaded: boolean;
  userTouchedRuntimeRef: MutableRefObject<boolean>;
  preferredDefaultDevice: { deviceId: string } | null | undefined;
  selectedDeviceId: string;
  hostDraftDefaults: NewSessionHostDefaults | null;
  hostDefaultsSettled: boolean;
  hostRuntimeFor: (agent: NewSessionAgentKind) => NewSessionRuntime | null;
  deviceProviders: UseDeviceProvidersResult;
  deviceProvidersRef: MutableRefObject<UseDeviceProvidersResult>;
  catalogReadyRef: MutableRefObject<boolean>;
  flatModelsForUnsupportedHost: (deviceId: string, agent: NewSessionAgentKind, unsupported: boolean) => readonly MobileModelOption[] | undefined;
  targetAgentHasFast: (deviceId: string, agent: NewSessionAgentKind) => boolean;
  draftMemory: MobileModelMemoryAccessors;
  autoDefaultDeviceRef: MutableRefObject<string | null>;
  setDraft: Dispatch<SetStateAction<NewSessionDraft>>;
  settleRuntime: (source: string, deviceId: string) => void;
  appliedPermissionMemoryRef: MutableRefObject<boolean>;
  draft: NewSessionDraft;
  runtimeActionSeqRef: MutableRefObject<number>;
  selectedDeviceRef: MutableRefObject<string>;
  capabilities: MobileAgentCapabilities | null;
  modelRows: ProviderModelRow[];
  modelSections: ReturnType<typeof buildMobileModelSections>;
}) {
  const storedAgentRestoreRef = useRef<StoredAgentRestoreState | null>(null);
  const autoDefaultSnapshotRef = useRef<NewSessionHostDefaults | null | undefined>(undefined);
  useEffect(() => {
    const storedAgentKind = newSessionPreferences?.agentKind;
    if (!newSessionPreferencesLoaded || !storedAgentKind) return;
    if (userTouchedRuntimeRef.current) return;
    const restored = storedAgentRestoreRef.current;
    if (!isStoredAgentRestorePending({
      storedAgentKind,
      appliedStoredAgentKind: restored?.phase === 'done' ? restored.agentKind : null,
      expectedDeviceId: preferredDefaultDevice?.deviceId ?? '',
      selectedDeviceId,
    })) return;
    // agent 偏好一到就恢复;模型要等被控电脑的新建任务默认与目录,否则选不出模型。
    const step = nextStoredAgentRestoreStep({
      storedAgentKind,
      restored,
      modelReady: canResolveStoredAgentRuntime({
        deviceId: selectedDeviceId,
        hostDefaultsSettled: hostDraftDefaults?.deviceId === selectedDeviceId
          && storedAgentKind in hostDraftDefaults.byAgent,
        hostRuntime: hostRuntimeFor(storedAgentKind),
        catalogReady: deviceProviders.ready,
        providersUnsupported: deviceProviders.unsupported,
      }),
    });
    if (!step) return;
    mobileDebugLog('debug', 'new-session', 'stored agent restore', { step, agentKind: storedAgentKind });
    const previousRestore = restored;
    const restoreState: StoredAgentRestoreState = { agentKind: storedAgentKind, phase: step === 'agent' ? 'agent' : 'done' };
    storedAgentRestoreRef.current = restoreState;
    // 现场按最新目录算该 agent 的默认运行配置(rows 与 ready 必须同一代,codex review P2)。
    const resolveStoredRuntime = (currentEffort: string) => {
      const rowsNow = flattenProviderSections(
        buildMobileModelSections({
          providers: deviceProvidersRef.current.providers,
          agentKind: storedAgentKind,
          visibilityOverrides: deviceProvidersRef.current.modelVisibilityOverrides,
        }).sections,
      );
      const next = pickAgentDefaultRuntime({
        agentKind: storedAgentKind,
        hostRuntime: hostRuntimeFor(storedAgentKind),
        modelRows: rowsNow,
        providers: deviceProvidersRef.current.providers,
        currentEffort,
        catalogReady: catalogReadyRef.current,
        visibilityOverrides: deviceProvidersRef.current.modelVisibilityOverrides,
        flatModels: flatModelsForUnsupportedHost(selectedDeviceId, storedAgentKind, deviceProvidersRef.current.unsupported),
      });
      const rememberedFast = next.providerId
        ? draftMemory.getFast(next.agentKind, next.providerId, next.model) ?? false
        : false;
      return {
        model: next.model,
        effort: next.effort,
        providerId: next.providerId,
        // fast 按 (agent, 来源, 模型) 记忆恢复,无记忆置 false;恢复前过与手动选行
        // 同款的 fastEditable 门控(codex review P2:目录/能力变化后不得恢复出
        // UI 显示关、实际发 true 的矛盾态)。agent 级门控只认目标 agent 的缓存
        // 能力表(codex review P1:此刻闭包里的 capabilities 属于切换前 agent 或
        // 为 null);目标 caps 未就绪 → false,由延迟恢复 effect 就绪后补评。
        fastMode: next.providerId
          && isFastRestorable(next.agentKind, next.providerId, next.model, rowsNow, targetAgentHasFast(selectedDeviceId, next.agentKind), rememberedFast)
          ? rememberedFast
          : false,
      };
    };
    // Stored-engine restoration and the generic default effect consume the same
    // snapshot; only a later host refresh may seed the untouched draft again.
    const previousAutoDefaultSnapshot = autoDefaultSnapshotRef.current;
    autoDefaultSnapshotRef.current = hostDraftDefaults;
    if (step === 'model') {
      // agent 与权限已在第一步恢复;只补模型,不动 agent 与权限(期间用户改过权限/计划模式不被覆盖)。
      setDraft((current) => (current.agentKind === storedAgentKind
        ? { ...current, ...resolveStoredRuntime(current.effort) }
        : current));
      settleRuntime('stored-agent-model', selectedDeviceId);
      return;
    }
    // 该路径同时负责恢复 agent 权限，下面的通用权限记忆 effect 不再重复弹框。
    appliedPermissionMemoryRef.current = true;
    const previousAutoDefaultDevice = autoDefaultDeviceRef.current;
    if (selectedDeviceId) autoDefaultDeviceRef.current = selectedDeviceId;
    let applied = false;
    const storedPermissionMode = newSessionPreferences?.permissionModeByAgent[storedAgentKind];
    const nextPermissionMode =
      storedPermissionMode ??
      defaultPermissionModeForNewSessionAgent(storedAgentKind);
    let cancelled = false;
    const deviceAtTrigger = selectedDeviceId;
    const seqAtTrigger = ++runtimeActionSeqRef.current;
    void (async () => {
      const confirmed = await confirmFullAccessChange(draft.permissionMode, nextPermissionMode, {
        restoringRememberedChoice: storedPermissionMode !== undefined,
      });
      if (cancelled) return;
      // 确认期间设备已切换 → 放弃本次写入,新设备自己的恢复/自动默认 effect 会接管。
      if (deviceAtTrigger !== selectedDeviceRef.current) return;
      // 确认期间用户又切了 agent / 手动选了模型 → 旧回调不得覆盖新选择。
      if (seqAtTrigger !== runtimeActionSeqRef.current) return;
      applied = true;
      setDraft((current) => ({
        ...current,
        ...resolveStoredRuntime(current.effort),
        agentKind: storedAgentKind,
        // 上次明确选择过的权限直接沿用；内置默认若升级到 Full access 仍需确认。
        permissionMode: confirmed ? nextPermissionMode : current.permissionMode,
      }));
      // 'agent' 只恢复了 agent,模型仍是占位,等数据到了由 'model' 落定。
      if (step === 'full') settleRuntime('stored-agent', deviceAtTrigger);
    })();
    return () => {
      cancelled = true;
      // 写入前依赖已变(effect 重跑):撤回「已恢复」与设备锁,让重跑的 effect 重新恢复。
      // 否则标记已落、草稿却没写,两条默认路径都不再处理,页面停在占位模型。
      if (applied) return;
      if (storedAgentRestoreRef.current === restoreState) storedAgentRestoreRef.current = previousRestore;
      if (autoDefaultDeviceRef.current === selectedDeviceId) {
        autoDefaultDeviceRef.current = previousAutoDefaultDevice;
        autoDefaultSnapshotRef.current = previousAutoDefaultSnapshot;
      }
    };
  }, [
    draft.permissionMode,
    deviceProviders.ready,
    deviceProviders.unsupported,
    deviceProviders.providers,
    deviceProviders.modelVisibilityOverrides,
    hostDefaultsSettled,
    hostDraftDefaults,
    hostRuntimeFor,
    newSessionPreferences,
    newSessionPreferences?.agentKind,
    newSessionPreferencesLoaded,
    preferredDefaultDevice?.deviceId,
    selectedDeviceId,
  ]);

  // 权限记忆恢复:偏好加载后按当前 agent 恢复上次选过的档(一次;对齐桌面 lastByVendor)。
  // storedAgentKind 路径由上面的 effect 覆盖;这里兜住「没存过 agent 但存过权限」的场景。
  useEffect(() => {
    if (!newSessionPreferencesLoaded || appliedPermissionMemoryRef.current) return;
    appliedPermissionMemoryRef.current = true;
    // 有存储的 agent 时由上面的 agent 恢复 effect 统一处理，避免同一轮出现两个确认框。
    if (newSessionPreferences?.agentKind) return;
    const remembered = newSessionPreferences?.permissionModeByAgent[draft.agentKind];
    if (!remembered || remembered === draft.permissionMode) return;
    let cancelled = false;
    const seqAtTrigger = runtimeActionSeqRef.current;
    void confirmFullAccessChange(draft.permissionMode, remembered, {
      restoringRememberedChoice: true,
    }).then((confirmed) => {
      if (cancelled || !confirmed || seqAtTrigger !== runtimeActionSeqRef.current) return;
      setDraft((current) => ({ ...current, permissionMode: remembered }));
    });
    return () => {
      cancelled = true;
    };
  }, [draft.agentKind, draft.permissionMode, newSessionPreferences, newSessionPreferencesLoaded]);

  // 新建任务默认运行配置 = 被控电脑记住的当前 agent 新建任务默认(model+effort+来源,与桌面远程新建同源);
  // 没有则优先区域默认、再用模型列表最上面那个。一旦用户手动选过模型即不再覆盖;切设备(未手动选过)按新设备重算。
  // 决策逻辑全在纯函数 resolveNewSessionAutoDefault 里(便于单测);此 effect 只负责"调纯函数 → setDraft + 更新 ref"。
  // 被控电脑默认与 providers 都是异步到达,任一就绪后此 effect 再触发。
  useEffect(() => {
    if (!newSessionPreferencesLoaded) return;
    const result = resolveNewSessionAutoDefault({
      userTouched: userTouchedRuntimeRef.current,
      appliedDeviceId: autoDefaultSnapshotRef.current === hostDraftDefaults ? autoDefaultDeviceRef.current : null,
      selectedDeviceId,
      hostDefaultsSettled,
      hostRuntime: hostRuntimeFor(draft.agentKind),
      modelRows,
      providers: deviceProviders.providers,
      rowsAgentKind: draft.agentKind,
      catalogReady: deviceProviders.ready,
      visibilityOverrides: deviceProviders.modelVisibilityOverrides,
      providersUnsupported: deviceProviders.unsupported,
      // provider-aware 模式只用经过可见性过滤的 rows;目录确实不可用时才回退
      // capabilities(上游 main 移植,merge 2026-08-07)。
      availableModels: deviceProviders.unsupported
        ? capabilities?.availableModels
        : undefined,
      currentEffort: draft.effort,
    });
    if (!result) return;
    const previousAutoDefaultDevice = autoDefaultDeviceRef.current;
    const previousAutoDefaultSnapshot = autoDefaultSnapshotRef.current;
    autoDefaultDeviceRef.current = result.appliedDeviceId;
    autoDefaultSnapshotRef.current = hostDraftDefaults;
    let applied = false;
    const nextAgentKind = result.patch.agentKind ?? draft.agentKind;
    const storedPermissionMode = appliedPermissionMemoryRef.current
      ? undefined
      : newSessionPreferences?.permissionModeByAgent[nextAgentKind];
    const nextPermissionMode = appliedPermissionMemoryRef.current
      ? draft.permissionMode
      : storedPermissionMode ?? defaultPermissionModeForNewSessionAgent(nextAgentKind);
    let cancelled = false;
    void confirmFullAccessChange(draft.permissionMode, nextPermissionMode, {
      restoringRememberedChoice: storedPermissionMode !== undefined,
    }).then((confirmed) => {
      if (cancelled || userTouchedRuntimeRef.current) return;
      applied = true;
      settleRuntime(result.source, result.appliedDeviceId);
      setDraft((current) => {
        // 自动默认重算(设备切换/最近会话变化)改了 (agent, model, providerId) 组合 →
        // fastMode 按新组合重验(Codex review P2):A 设备记忆恢复的 fastMode:true 不得
        // 随 `...current` 带进 B 的组合(若 B 的模型行不支持 Fast,终检/延迟恢复/能力
        // 协调三条路径都不会处理它)。组合变化时保守关闭,由延迟恢复 effect 在 B 的
        // 组合 + 能力就绪后按记忆重评(手动关过 → 记忆为 false,不会重新打开)。
        const nextModel = result.patch.model ?? current.model;
        // providerId 用 `!== undefined` 而非 `??`:patch 显式带 providerId:null(来源
        // 切回默认路由)是真实的组合变化,`??` 会取回旧值抹掉该变化(Codex review P2)。
        const nextProviderId = result.patch.providerId !== undefined
          ? result.patch.providerId
          : current.providerId;
        const nextAgentKind = result.patch.agentKind ?? current.agentKind;
        const comboChanged = nextModel !== current.model
          || nextProviderId !== current.providerId
          || nextAgentKind !== current.agentKind;
        return {
          ...current,
          ...result.patch,
          ...(comboChanged ? { fastMode: false } : {}),
          // 自动恢复上次明确选择的权限不再重复确认；内置默认仍按升级规则确认。
          permissionMode: confirmed ? nextPermissionMode : current.permissionMode,
        };
      });
    });
    return () => {
      cancelled = true;
      // 写入前 effect 重跑:撤回设备锁,重跑时按最新数据重新应用,不把这台设备误记为已应用。
      if (!applied && autoDefaultDeviceRef.current === result.appliedDeviceId) {
        autoDefaultDeviceRef.current = previousAutoDefaultDevice;
        autoDefaultSnapshotRef.current = previousAutoDefaultSnapshot;
      }
    };
  }, [capabilities?.availableModels, deviceProviders.providers, deviceProviders.loading, draft.effort, draft.permissionMode, draft.agentKind, modelRows, deviceProviders.ready, deviceProviders.modelVisibilityOverrides, deviceProviders.unsupported, modelSections.connected.length, newSessionPreferences, newSessionPreferencesLoaded, selectedDeviceId, hostDefaultsSettled, hostDraftDefaults, hostRuntimeFor]);

}
