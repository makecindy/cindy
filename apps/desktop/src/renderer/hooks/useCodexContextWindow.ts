import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CodexContextWindowInfo } from '@cindy/maker-core';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, subscribeDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { getDeviceProvidersGeneration, subscribeDeviceProviders } from '@/hooks/useDeviceProviders';
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';
import { parseModelCatalogKey } from '../../shared/controlledModelCatalog';
import type { ModelContextLimitView } from '../../shared/modelContextLimit';

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
    // A forwarded catalog is not a task on this peer. Until that route supports
    // native reads, keep it unknown rather than querying the controller or a group.
    if (deviceId && parseModelCatalogKey(deviceId)) return;
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
      const peerGeneration = deviceId ? getDeviceProvidersGeneration(deviceId) : undefined;
      const current = () => !cancelled && revision === requestRevision
        && isDataOwnerGenerationCurrent(owner)
        && (!deviceId || getDeviceProvidersGeneration(deviceId) === peerGeneration);
      void schedule(async () => {
        if (!current()) return;
        try {
          const view = deviceId
            ? await window.electronAPI.deviceLink.invoke(deviceId, 'maker:model-context-limit:get', [target]) as ModelContextLimitView
            : await window.electronAPI?.maker?.getModelContextLimit?.(target);
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
