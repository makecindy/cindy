import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { isScopedPeer } from '@cindy/device-link';
import type { CodexContextWindowInfo } from '@cindy/maker-core';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, subscribeDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { getDeviceProvidersGeneration, subscribeDeviceProviders } from '@/hooks/useDeviceProviders';
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';
import { parseModelCatalogKey } from '../../shared/controlledModelCatalog';
import type { ModelContextLimitView } from '../../shared/modelContextLimit';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare';

// 仅用于同一窗口首次探测未知对端时串行化并发请求（能力缺失记忆统一由 preload `remoteReadBridge` 持有，不在此重复缓存）。
let observedDeviceLink: unknown = undefined;
let detachLinkWatch: (() => void) | null = null;
let globalLinkEpoch = 0;
const peerLinkEpochs = new Map<string, number>();
const peerVersions = new Map<string, string>();
const settledProbeScopes = new Set<string>();
const inflightFirstProbeByScope = new Map<string, Promise<void>>();

function bumpPeerEpoch(deviceId: string): void {
  if (!deviceId) return;
  peerLinkEpochs.set(deviceId, (peerLinkEpochs.get(deviceId) ?? 0) + 1);
}

function resetProbeEpochs(): void {
  globalLinkEpoch += 1;
  peerLinkEpochs.clear();
  peerVersions.clear();
  settledProbeScopes.clear();
  inflightFirstProbeByScope.clear();
}

function syncProbeLinkWatch(): void {
  const link = typeof window !== 'undefined' ? window.electronAPI?.deviceLink : undefined;
  if (link === observedDeviceLink) return;
  detachLinkWatch?.();
  detachLinkWatch = null;
  observedDeviceLink = link;
  resetProbeEpochs();
  if (!link) return;
  const offs = [
    link.onPeerLinkReset?.((event) => {
      peerVersions.delete(event.deviceId);
      bumpPeerEpoch(event.deviceId);
    }),
    link.onPeerLinkReopened?.((event) => {
      bumpPeerEpoch(event.deviceId);
    }),
    link.onAccessRevoked?.((event) => {
      peerVersions.delete(event.deviceId);
      bumpPeerEpoch(event.deviceId);
    }),
    link.onControlTargetChanged?.((event) => {
      peerVersions.delete(event.deviceId);
      bumpPeerEpoch(event.deviceId);
    }),
    link.onPresenceChanged?.((presence) => {
      if (!presence.online || presence.remoteControlEnabled === false) {
        peerVersions.delete(presence.deviceId);
        bumpPeerEpoch(presence.deviceId);
        return;
      }
      if (typeof presence.appVersion === 'string') {
        const prev = peerVersions.get(presence.deviceId);
        if (!peerVersions.has(presence.deviceId) && peerVersions.size >= 256) {
          const oldest = peerVersions.keys().next().value;
          if (oldest !== undefined) peerVersions.delete(oldest);
        }
        peerVersions.set(presence.deviceId, presence.appVersion);
        if (prev !== undefined && prev !== presence.appVersion) {
          bumpPeerEpoch(presence.deviceId);
        }
      }
    }),
    link.onStatusChanged?.((payload) => {
      const changedDeviceId = (payload as { dataPathChangedDeviceId?: unknown } | undefined)?.dataPathChangedDeviceId;
      if (typeof changedDeviceId === 'string' && changedDeviceId) {
        bumpPeerEpoch(changedDeviceId);
      } else if (payload?.status !== 'online') {
        resetProbeEpochs();
      }
    }),
    link.onOwnershipChanged?.(() => {
      resetProbeEpochs();
    }),
  ];
  detachLinkWatch = () => {
    for (const off of offs) off?.();
  };
}

export function resetCodexContextWindowProbesForTests(): void {
  detachLinkWatch?.();
  detachLinkWatch = null;
  observedDeviceLink = undefined;
  resetProbeEpochs();
}

/** Native read-only facts. Missing/old hosts stay unknown, never fall back to a model catalog. */
export function useCodexContextWindow(options: {
  enabled: boolean;
  providerId?: string | null;
  modelId: string;
  sessionId?: string;
  deviceId?: string;
  reportedWindow?: number;
  refreshKey?: boolean | string;
}) {
  const { enabled, providerId, modelId, sessionId, deviceId, reportedWindow, refreshKey } = options;
  const owner = useSyncExternalStore(subscribeDataOwnerGeneration, getDataOwnerGeneration);
  const key = JSON.stringify([owner.dataOwnerId, owner.generation, deviceId, providerId, modelId, sessionId, reportedWindow]);
  // Inspection refreshes share one in-flight read for the same task/model.
  // Changing the target or owner starts an independent generation immediately.
  const schedule = useMemo(() => createCoalescedRefresh<void>(), [key]);
  const [state, setState] = useState<{
    key: string; info: CodexContextWindowInfo | null; peerGeneration?: number;
  }>({ key: '', info: null });
  useEffect(() => {
    if (!enabled || (!providerId && !sessionId) || !modelId) return;
    // A forwarded catalog, shared task, or shared provider is not an owner-controlled peer with native context reads.
    if (
      deviceId &&
      (!owner.dataOwnerId ||
        parseModelCatalogKey(deviceId) ||
        isScopedPeer(deviceId) ||
        isProviderShareAgentDeviceId(deviceId))
    ) {
      return;
    }
    let cancelled = false;
    let revision = 0;
    let windowHidden = isWindowHidden();
    const isVisible = () => !deviceId || (document.visibilityState === 'visible' && !windowHidden);
    let visible = isVisible();
    const target = {
      agent: 'codex', providerId: providerId ?? 'codex', modelId, ...(sessionId ? { sessionId } : {}),
    } as const;
    const refresh = () => {
      const requestRevision = ++revision;
      if (!isVisible()) return;
      syncProbeLinkWatch();
      const peerGeneration = deviceId ? getDeviceProvidersGeneration(deviceId) : undefined;
      const startGlobalEpoch = globalLinkEpoch;
      const startPeerEpoch = deviceId ? (peerLinkEpochs.get(deviceId) ?? 0) : 0;
      const isScopeCurrent = () =>
        isDataOwnerGenerationCurrent(owner) &&
        (!deviceId ||
          (getDeviceProvidersGeneration(deviceId) === peerGeneration &&
            globalLinkEpoch === startGlobalEpoch &&
            (peerLinkEpochs.get(deviceId) ?? 0) === startPeerEpoch));
      const current = () => !cancelled && revision === requestRevision && isScopeCurrent();
      void schedule(async () => {
        if (!current()) return;
        try {
          let view: ModelContextLimitView | null | undefined;
          if (deviceId) {
            const scopeKey = JSON.stringify([
              owner.dataOwnerId,
              owner.generation,
              deviceId,
              peerGeneration,
              startGlobalEpoch,
              startPeerEpoch,
            ]);
            while (!settledProbeScopes.has(scopeKey)) {
              const pendingGate = inflightFirstProbeByScope.get(scopeKey);
              if (!pendingGate) break;
              await pendingGate;
              // 切号、重连、对端目录失效或当前组件取消/切换目标后立即终止，绝不把旧 sessionId 发往新连接。
              if (!current()) return;
            }
            if (!current()) return;
            let releaseGate: (() => void) | undefined;
            let gate: Promise<void> | undefined;
            if (!settledProbeScopes.has(scopeKey)) {
              gate = new Promise<void>((resolve) => {
                releaseGate = resolve;
              });
              inflightFirstProbeByScope.set(scopeKey, gate);
            }
            try {
              view = (await window.electronAPI?.deviceLink?.invoke(
                deviceId,
                'maker:model-context-limit:get',
                [target],
              )) as ModelContextLimitView | undefined;
            } finally {
              if (isScopeCurrent()) {
                if (settledProbeScopes.size >= 256) {
                  const oldest = settledProbeScopes.values().next().value;
                  if (oldest !== undefined) settledProbeScopes.delete(oldest);
                }
                settledProbeScopes.add(scopeKey);
              }
              if (gate && inflightFirstProbeByScope.get(scopeKey) === gate) {
                inflightFirstProbeByScope.delete(scopeKey);
              }
              releaseGate?.();
            }
          } else {
            view = await window.electronAPI?.maker?.getModelContextLimit?.(target);
          }
          if (current()) setState({ key, peerGeneration, info: view?.codexContext ?? null });
        } catch {
          if (current()) setState({ key, info: null });
        }
      });
    };
    const unsubscribe = deviceId ? subscribeDeviceProviders(deviceId, event => {
      ++revision;
      setState({ key, info: null });
      // Existing directory recovery owns reconnects and permission changes.
      // Never retry from a disconnect/error notification or reset a shared link.
      if (event.status === 'ready') refresh();
    }) : undefined;
    const onVisibility = () => {
      const next = isVisible();
      if (visible === next) return;
      visible = next;
      ++revision;
      if (next) refresh();
    };
    const offHidden = deviceId ? window.electronAPI?.onWindowHiddenChange?.(hidden => {
      windowHidden = hidden;
      onVisibility();
    }) : undefined;
    if (deviceId) document.addEventListener('visibilitychange', onVisibility);
    refresh();
    return () => {
      cancelled = true;
      unsubscribe?.(); offHidden?.();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, providerId, modelId, sessionId, deviceId, reportedWindow, refreshKey, key, owner, schedule]);
  return enabled && state.key === key
    && (!deviceId || state.peerGeneration === getDeviceProvidersGeneration(deviceId)) ? state.info : null;
}
