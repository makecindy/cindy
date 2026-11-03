import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { useDeviceLinkReconnectEpoch } from '@/features/device-link/useDeviceLinkReconnectEpoch';
import { extractIpcError } from '@/utils/ipcError';
import type { AgentCapabilities, AgentKind } from '@/hooks/useAgentCapabilities';
import type { ProviderView } from '@cindy/model-providers';
import { getRemoteDraftDefaults, rememberRemoteDraftDefaults } from './remoteDraftDefaultsCache';
import { resolveDeviceLinkDraftDefaults, shouldReseedDeviceLinkDraftDefaults, type RemoteDraftDefaults, type DeviceLinkDraftSelection } from './deviceLinkDraftDefaults';

export function useRemoteDraftDefaults({
  isDeviceLinkDraft, effectiveDeviceLinkDeviceId, capabilityAgentKind, wtPreferenceTransactionRef, dataOwnerId, dataOwnerGeneration
}: {
  isDeviceLinkDraft: boolean;
  effectiveDeviceLinkDeviceId: string | undefined;
  capabilityAgentKind: AgentKind;
  wtPreferenceTransactionRef: MutableRefObject<Parameters<typeof rememberRemoteDraftDefaults>[3]>;
  dataOwnerId: string | null;
  dataOwnerGeneration: number;
}) {
  const [remoteDraftState, setRemoteDraftState] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    value: RemoteDraftDefaults | null;
  }>(() => {
    const cached = isDeviceLinkDraft && effectiveDeviceLinkDeviceId
      ? getRemoteDraftDefaults(effectiveDeviceLinkDeviceId, capabilityAgentKind)
      : undefined;
    return cached !== undefined
      ? { status: 'ready', value: cached }
      : { status: 'idle', value: null };
  });
  const [remoteDraftRetryEpoch, setRemoteDraftRetryEpoch] = useState(0);
  const [dlSel, setDlSel] = useState<DeviceLinkDraftSelection | null>(null);
  const dlSeedKeyRef = useRef<string | null>(null);
  const dlSeedCapabilitiesRef = useRef<AgentCapabilities | null>(null);
  const dlSeedDefaultsRef = useRef<RemoteDraftDefaults | null>(null);
  /** 控制端是否编辑过当前设备 / Agent 的远程运行配置；能力刷新不得覆盖这类显式意图。 */
  const dlRuntimeTouchedRef = useRef(false);
  const skipDefaultsRefetchRef = useRef(false);
  const remoteDraftIdentityRef = useRef<string | null>(null);
  const remoteDraftRevisionRef = useRef(0);
  const remoteDraftRefreshEpoch = useDeviceLinkReconnectEpoch(
    isDeviceLinkDraft ? effectiveDeviceLinkDeviceId : undefined,
  );

  // 拉被控端当前草稿值。切 device/vendor 时清旧镜像；同一目标重连时后台重拉，
  // 但保留已知值直到新结果落下，避免一次瞬态失败把工作端拥有的 true 压成 false。
  useEffect(() => {
    if (!isDeviceLinkDraft || !effectiveDeviceLinkDeviceId) {
      remoteDraftIdentityRef.current = null;
      setRemoteDraftState({ status: 'idle', value: null });
      return;
    }
    const identity = `${effectiveDeviceLinkDeviceId}:${capabilityAgentKind}`;
    const sameIdentity = remoteDraftIdentityRef.current === identity;
    remoteDraftIdentityRef.current = identity;
    // handoff 路径已 inline 拉取并 set 了 remoteDraftState,跳过本次 effect 重拉。
    if (skipDefaultsRefetchRef.current) {
      skipDefaultsRefetchRef.current = false;
      return;
    }
    let cancelled = false;
    const owner = getDataOwnerGeneration();
    const requestRevision = remoteDraftRevisionRef.current;
    // A worktree write requires fresh host confirmation, never a cached acknowledgement.
    const transaction = wtPreferenceTransactionRef.current;
    const confirmingWrite = transaction?.deviceId === effectiveDeviceLinkDeviceId
      && transaction.status !== 'committed';
    const cached = confirmingWrite ? undefined
      : getRemoteDraftDefaults(effectiveDeviceLinkDeviceId, capabilityAgentKind);
    setRemoteDraftState((previous) => ({
      status: cached !== undefined ? 'ready' : 'loading',
      value: cached !== undefined ? cached : sameIdentity ? previous.value : null,
    }));
    window.electronAPI.deviceLink
      .invoke(effectiveDeviceLinkDeviceId, 'maker:get-new-maker-defaults', [capabilityAgentKind])
      .then((v) => {
        if (!cancelled && isDataOwnerGenerationCurrent(owner) && remoteDraftRevisionRef.current === requestRevision) {
          const received = (v as RemoteDraftDefaults | null) ?? null;
          const value = received && Object.keys(received).length === 0 && cached !== undefined
            ? cached : received;
          rememberRemoteDraftDefaults(effectiveDeviceLinkDeviceId, capabilityAgentKind, value, wtPreferenceTransactionRef.current);
          setRemoteDraftState({
            status: 'ready',
            value,
          });
        }
      })
      .catch((error) => {
        if (cancelled || !isDataOwnerGenerationCurrent(owner) || remoteDraftRevisionRef.current !== requestRevision) return;
        const unsupported = extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED';
        // A failed background refresh must not discard a previously usable default.
        // Without one (or while confirming a write), keep the original error gate.
        setRemoteDraftState((previous) => ({
          status: unsupported || cached !== undefined ? 'ready' : 'error',
          value: unsupported ? null : previous.value,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [
    isDeviceLinkDraft,
    effectiveDeviceLinkDeviceId,
    capabilityAgentKind,
    remoteDraftRefreshEpoch,
    remoteDraftRetryEpoch,
    dataOwnerId,
    dataOwnerGeneration,
  ]);

  return {
    remoteDraftState,
    setRemoteDraftState,
    setRemoteDraftRetryEpoch,
    remoteDraftRefreshEpoch,
    dlSel,
    setDlSel,
    dlSeedKeyRef,
    dlSeedCapabilitiesRef,
    dlSeedDefaultsRef,
    dlRuntimeTouchedRef,
    skipDefaultsRefetchRef,
    remoteDraftRevisionRef,
  };
}

export function useRemoteDraftSelection({
  remoteDefaults,
  usesDeviceCatalog,
  catalogDeviceId,
  capabilityAgentKind,
  agentCatalogProviders,
  capabilities,
  capabilitiesLoading,
  deviceProvidersLoading,
  deviceProvidersUnsupported,
  deviceDraftDefaultsReady,
  deviceDraftDefaults,
  isAgentDeviceDraft,
}: {
  remoteDefaults: ReturnType<typeof useRemoteDraftDefaults>;
  usesDeviceCatalog: boolean;
  catalogDeviceId: string | undefined;
  capabilityAgentKind: AgentKind;
  agentCatalogProviders: ProviderView[];
  capabilities: AgentCapabilities | null;
  capabilitiesLoading: boolean;
  deviceProvidersLoading: boolean;
  deviceProvidersUnsupported: boolean;
  deviceDraftDefaultsReady: boolean;
  deviceDraftDefaults: RemoteDraftDefaults | null;
  isAgentDeviceDraft: boolean;
}) {
  const { dlSeedKeyRef, dlSeedCapabilitiesRef, dlSeedDefaultsRef, dlRuntimeTouchedRef, setDlSel } = remoteDefaults;
  useEffect(() => {
    if (!usesDeviceCatalog || !catalogDeviceId) {
      dlSeedKeyRef.current = null;
      dlSeedCapabilitiesRef.current = null;
      dlSeedDefaultsRef.current = null;
      dlRuntimeTouchedRef.current = false;
      setDlSel(null);
      return;
    }
    // provider revision 驱逐时 hook 会保留旧快照但标 loading；必须等新代际 ready，不能用 stale
    // capabilities 把 inline handoff 或用户当前选择校准回旧目录。
    // 现代被控端还要等 provider:list；否则 flat capabilities 先播种后不会因目录到达而重校准。
    // 明确不支持该 channel 的旧端继续使用 capabilities fallback。
    const deviceProviderCatalogReady = deviceProvidersUnsupported || !deviceProvidersLoading;
    if (
      !capabilities ||
      capabilitiesLoading ||
      !deviceDraftDefaultsReady ||
      !deviceProviderCatalogReady
    ) return;
    const key = `${catalogDeviceId}:${capabilityAgentKind}`;
    const newTarget = dlSeedKeyRef.current !== key;
    const capabilitiesChanged = dlSeedCapabilitiesRef.current !== capabilities;
    if (
      !shouldReseedDeviceLinkDraftDefaults({
        currentSeedKey: dlSeedKeyRef.current,
        nextSeedKey: key,
        capabilitiesChanged,
        defaultsChanged: !isAgentDeviceDraft && dlSeedDefaultsRef.current !== deviceDraftDefaults,
        controllerTouched: dlRuntimeTouchedRef.current,
        remoteModelChosenByUser: deviceDraftDefaults?.modelChosenByUser,
      })
    ) {
      if (capabilitiesChanged) {
        dlSeedCapabilitiesRef.current = capabilities;
        // 显式意图只禁止“换成区域默认”，不能把已从新能力清单消失的 model / effort /
        // permission 留在草稿里。用当前控制端选择合成 active draft，只做合法性夹紧。
        setDlSel((current) =>
          current
            ? resolveDeviceLinkDraftDefaults(
                capabilities,
                {
                  model: current.model,
                  modelChosenByUser: true,
                  effort: current.effort,
                  fastMode: current.fastMode,
                  permissionMode: current.permissionMode,
                  providerId: current.providerId,
                },
                current.model,
                capabilityAgentKind,
                agentCatalogProviders,
              )
            : current,
        );
      }
      return;
    }
    dlSeedKeyRef.current = key;
    dlSeedCapabilitiesRef.current = capabilities;
    dlSeedDefaultsRef.current = deviceDraftDefaults;
    if (newTarget) dlRuntimeTouchedRef.current = false;
    setDlSel(
      resolveDeviceLinkDraftDefaults(
        capabilities,
        deviceDraftDefaults,
        undefined,
        capabilityAgentKind,
        agentCatalogProviders,
      ),
    );
  }, [
    usesDeviceCatalog,
    catalogDeviceId,
    capabilityAgentKind,
    agentCatalogProviders,
    capabilities,
    capabilitiesLoading,
    deviceProvidersLoading,
    deviceProvidersUnsupported,
    deviceDraftDefaultsReady,
    deviceDraftDefaults,
    isAgentDeviceDraft,
  ]);
}

export function useRemoteDraftPush({
  remoteDefaults, isDeviceLinkDraft, effectiveDeviceLinkDeviceId, effectiveAgentDeviceId, capabilityAgentKind, capabilities, agentCatalogProviders, wtPreferenceTransactionRef
}: {
  remoteDefaults: ReturnType<typeof useRemoteDraftDefaults>;
  isDeviceLinkDraft: boolean;
  effectiveDeviceLinkDeviceId: string | undefined;
  effectiveAgentDeviceId: string | undefined;
  capabilityAgentKind: AgentKind;
  capabilities: AgentCapabilities | null;
  agentCatalogProviders: ProviderView[];
  wtPreferenceTransactionRef: MutableRefObject<Parameters<typeof rememberRemoteDraftDefaults>[3]>;
}) {
  const { remoteDraftRevisionRef, setRemoteDraftState, setDlSel } = remoteDefaults;
  useEffect(() => {
    if (!isDeviceLinkDraft || !effectiveDeviceLinkDeviceId) return;
    const vendorSlot = capabilityAgentKind === 'claude-code' ? 'claudeCode' : capabilityAgentKind;
    return window.electronAPI.deviceLink.onRemotePush((push, localOwnerStamp) => {
      if (push.deviceId !== effectiveDeviceLinkDeviceId) return;
      if (!isDeviceLinkRemotePushCurrent(push, localOwnerStamp)) return;
      if (push.channel !== 'maker:new-maker-draft:changed') return;
      const payload = push.payload as Record<string, RemoteDraftDefaults | undefined> | null;
      const next = payload?.[vendorSlot] ?? null;
      remoteDraftRevisionRef.current += 1;
      rememberRemoteDraftDefaults(effectiveDeviceLinkDeviceId, capabilityAgentKind, next, wtPreferenceTransactionRef.current);
      setRemoteDraftState({ status: 'ready', value: next });
      // 选中行(dlSel)的 effort/fast 也跟被控端走:按当前 dlSel.model 重解析,但保留控制端的
      // permission/source/model 选择(非按模型记 / 控制端 launch 意图)。被控端改选中模型 effort 即时反映。
      // Agent 在另一台电脑运行时选中的是那台目录里的模型,档位与被控端的记忆无关,不跟。
      if (capabilities && !effectiveAgentDeviceId) {
        setDlSel((prev) => {
          if (!prev) return prev;
          const re = resolveDeviceLinkDraftDefaults(
            capabilities,
            next,
            prev.model,
            capabilityAgentKind,
            agentCatalogProviders,
          );
          return { ...prev, effort: re.effort, fastMode: re.fastMode };
        });
      }
    });
  }, [
    isDeviceLinkDraft,
    effectiveDeviceLinkDeviceId,
    effectiveAgentDeviceId,
    capabilityAgentKind,
    capabilities,
    agentCatalogProviders,
  ]);
}
