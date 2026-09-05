import { useCallback, useSyncExternalStore } from 'react';

import { customProviderBillingGetFor } from '@/lib/makerTransport';
import {
  getCustomProviderShowSdkCost,
  setCustomProviderShowSdkCost,
  subscribeCustomProviderShowSdkCost,
} from '@/lib/customProviderBillingSettingsStore';

interface CustomProviderBillingSettingsSnapshot {
  showSdkCostForCustomProviders: boolean;
  isCustomized: boolean;
}

const LOCAL_KEY = '';
const EMPTY_REMOTE_SETTINGS: CustomProviderBillingSettingsSnapshot = Object.freeze({
  showSdkCostForCustomProviders: false,
  isCustomized: false,
});
let localSnapshot: CustomProviderBillingSettingsSnapshot = {
  showSdkCostForCustomProviders: getCustomProviderShowSdkCost(),
  isCustomized: false,
};
const remoteSnapshots = new Map<string, CustomProviderBillingSettingsSnapshot>();
const remoteListeners = new Map<string, Set<() => void>>();
const remoteInflight = new Map<string, Promise<void>>();
const remoteGenerations = new Map<string, number>();
let sharedListenersInstalled = false;
let unsubscribeLocalPush: (() => void) | undefined;
let unsubscribeRemotePush: (() => void) | undefined;
let unsubscribePresence: (() => void) | undefined;
let unsubscribeStatus: (() => void) | undefined;

function keyFor(deviceId?: string | null): string {
  return deviceId ?? LOCAL_KEY;
}

function readSnapshot(deviceId?: string | null): CustomProviderBillingSettingsSnapshot {
  return deviceId ? remoteSnapshots.get(deviceId) ?? EMPTY_REMOTE_SETTINGS : localSnapshot;
}

function notify(key: string): void {
  remoteListeners.get(key)?.forEach((listener) => listener());
}

function invalidateRemoteSnapshot(deviceId: string): void {
  remoteGenerations.set(deviceId, (remoteGenerations.get(deviceId) ?? 0) + 1);
  remoteInflight.delete(deviceId);
  remoteSnapshots.delete(deviceId);
  notify(deviceId);
}

function invalidateAllRemoteSnapshots(): void {
  const deviceIds = new Set([
    ...remoteSnapshots.keys(),
    ...remoteInflight.keys(),
    ...remoteListeners.keys(),
  ]);
  deviceIds.delete(LOCAL_KEY);
  for (const deviceId of deviceIds) invalidateRemoteSnapshot(deviceId);
}

function writeSnapshot(
  deviceId: string | null | undefined,
  snapshot: CustomProviderBillingSettingsSnapshot,
): void {
  const key = keyFor(deviceId);
  if (!deviceId) {
    localSnapshot = snapshot;
    setCustomProviderShowSdkCost(snapshot.showSdkCostForCustomProviders);
  } else {
    remoteSnapshots.set(deviceId, snapshot);
  }
  notify(key);
}

function refresh(deviceId?: string | null): Promise<void> {
  const key = keyFor(deviceId);
  const existing = remoteInflight.get(key);
  if (existing) return existing;
  const generation = deviceId ? remoteGenerations.get(deviceId) ?? 0 : 0;
  const isCurrent = () =>
    !deviceId || (remoteGenerations.get(deviceId) ?? 0) === generation;
  const request = customProviderBillingGetFor(deviceId)
    .then((snapshot) => {
      if (isCurrent()) writeSnapshot(deviceId, snapshot);
    })
    .catch(() => {
      if (deviceId && isCurrent()) writeSnapshot(deviceId, EMPTY_REMOTE_SETTINGS);
    })
    .finally(() => {
      if (remoteInflight.get(key) === request) remoteInflight.delete(key);
    });
  remoteInflight.set(key, request);
  return request;
}

function installSharedListeners(): void {
  if (sharedListenersInstalled) return;
  sharedListenersInstalled = true;
  unsubscribeLocalPush = window.electronAPI?.maker?.onCustomProviderBillingChanged?.(
    (payload: { deviceId?: string }) => {
      if (payload?.deviceId) return;
      void refresh();
    },
  );
  unsubscribeRemotePush = window.electronAPI?.deviceLink?.onRemotePush?.((push) => {
    if (push.channel !== 'maker:custom-provider-billing:changed' || !push.deviceId) return;
    invalidateRemoteSnapshot(push.deviceId);
    if (remoteListeners.has(push.deviceId)) void refresh(push.deviceId);
  });
  unsubscribePresence = window.electronAPI?.deviceLink?.onPresenceChanged?.((snapshot) => {
    invalidateRemoteSnapshot(snapshot.deviceId);
    if (snapshot.online && remoteListeners.has(snapshot.deviceId)) {
      void refresh(snapshot.deviceId);
    }
  });
  unsubscribeStatus = window.electronAPI?.deviceLink?.onStatusChanged?.(({ status }) => {
    if (status !== 'online') {
      invalidateAllRemoteSnapshots();
      return;
    }
    for (const deviceId of remoteListeners.keys()) {
      if (deviceId !== LOCAL_KEY) void refresh(deviceId);
    }
  });
}

function subscribe(deviceId: string | null | undefined, listener: () => void): () => void {
  installSharedListeners();
  const key = keyFor(deviceId);
  const listeners = remoteListeners.get(key) ?? new Set<() => void>();
  const first = listeners.size === 0;
  listeners.add(listener);
  remoteListeners.set(key, listeners);
  if (first) {
    if (deviceId) invalidateRemoteSnapshot(deviceId);
    void refresh(deviceId);
  }
  const unsubscribeLocal = deviceId
    ? undefined
    : subscribeCustomProviderShowSdkCost((showSdkCostForCustomProviders) => {
        if (localSnapshot.showSdkCostForCustomProviders === showSdkCostForCustomProviders) return;
        localSnapshot = { ...localSnapshot, showSdkCostForCustomProviders };
        notify(LOCAL_KEY);
      });
  return () => {
    unsubscribeLocal?.();
    const current = remoteListeners.get(key);
    current?.delete(listener);
    if (current?.size === 0) {
      remoteListeners.delete(key);
      if (deviceId) invalidateRemoteSnapshot(deviceId);
    }
  };
}

export function useCustomProviderBillingSettingsSnapshot(
  deviceId?: string | null,
  enabled = true,
): CustomProviderBillingSettingsSnapshot {
  return useSyncExternalStore(
    useCallback(
      (listener: () => void) => enabled ? subscribe(deviceId, listener) : () => undefined,
      [deviceId, enabled],
    ),
    useCallback(
      () => enabled ? readSnapshot(deviceId) : EMPTY_REMOTE_SETTINGS,
      [deviceId, enabled],
    ),
    () => EMPTY_REMOTE_SETTINGS,
  );
}

export function useCustomProviderBillingSettings(deviceId?: string | null): {
  showSdkCostForCustomProviders: boolean;
  isCustomized: boolean;
  setShowSdkCostForCustomProviders: (next: boolean) => Promise<void>;
  reset: () => Promise<void>;
} {
  const snapshot = useCustomProviderBillingSettingsSnapshot(deviceId);

  const setShowSdkCostForCustomProviders = useCallback(async (next: boolean) => {
    const settings = await window.electronAPI.maker.customProviderBillingSet(next);
    writeSnapshot(null, settings);
  }, []);

  const reset = useCallback(async () => {
    const settings = await window.electronAPI.maker.customProviderBillingReset();
    writeSnapshot(null, settings);
  }, []);

  return { ...snapshot, setShowSdkCostForCustomProviders, reset };
}

export function __resetCustomProviderBillingSettingsForTests(): void {
  localSnapshot = {
    showSdkCostForCustomProviders: getCustomProviderShowSdkCost(),
    isCustomized: false,
  };
  remoteSnapshots.clear();
  remoteListeners.clear();
  remoteInflight.clear();
  remoteGenerations.clear();
  unsubscribeLocalPush?.();
  unsubscribeRemotePush?.();
  unsubscribePresence?.();
  unsubscribeStatus?.();
  unsubscribeLocalPush = undefined;
  unsubscribeRemotePush = undefined;
  unsubscribePresence = undefined;
  unsubscribeStatus = undefined;
  sharedListenersInstalled = false;
}
