/** Remote usage data only; each device/provider consumes the same snapshots as its local UI. */
import { useEffect, useState } from 'react';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { extractIpcError } from '@/utils/ipcError';

const UNSUPPORTED_RETRY_AFTER_MS = 15 * 60_000;
function isSnapshotShape(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface RemoteDeviceUsageMirror<T> {
  useMirror(deviceId: string | null, providerId?: string): T | null;
  request(deviceId: string, providerId?: string): void;
  resetForTest(): void;
}

export function createRemoteDeviceUsageMirror<T extends object>(cfg: {
  invokeChannel: string | null;
  invokeArgs?: unknown[];
  pushChannel: string;
  defaultProviderId?: string;
  providerPushChannel?: string;
}): RemoteDeviceUsageMirror<T> {
  type Entry = {
    snapshot: T | null;
    revision: number;
    unsupportedUntil: number;
    pending: boolean;
    owner: ReturnType<typeof getDataOwnerGeneration>;
    listeners: Set<() => void>;
  };
  const entries = new Map<string, Entry>();
  let cacheOwner = getDataOwnerGeneration();
  function entryFor(deviceId: string, providerId?: string): Entry {
    if (!isDataOwnerGenerationCurrent(cacheOwner)) {
      cacheOwner = getDataOwnerGeneration();
      entries.clear();
    }
    const key = JSON.stringify([deviceId, providerId ?? cfg.defaultProviderId ?? null]);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        snapshot: null,
        revision: 0,
        unsupportedUntil: 0,
        pending: false,
        owner: cacheOwner,
        listeners: new Set(),
      };
      entries.set(key, entry);
    }
    return entry;
  }
  function apply(entry: Entry, snapshot: T | null): void {
    entry.snapshot = snapshot;
    entry.revision++;
    for (const notify of entry.listeners) notify();
  }
  function request(deviceId: string, providerId?: string): void {
    if (!cfg.invokeChannel) return;
    const entry = entryFor(deviceId, providerId);
    if (entry.pending || Date.now() < entry.unsupportedUntil) return;
    const revision = entry.revision;
    const args = [...(cfg.invokeArgs ?? [])];
    // Keep the legacy builtin call shape; scoped reads must explicitly name their provider.
    if (providerId && providerId !== cfg.defaultProviderId) args.push(providerId);
    entry.pending = true;
    void window.electronAPI.deviceLink
      .invoke(deviceId, cfg.invokeChannel, args)
      .then((value) => {
        if (!isDataOwnerGenerationCurrent(entry.owner) || entry.revision !== revision) return;
        // Older hosts may ignore new optional arguments. Never accept their builtin snapshot
        // as a named account's usage; scoped handlers echo the provider they actually read.
        if (
          providerId &&
          providerId !== cfg.defaultProviderId &&
          value !== null &&
          (!isSnapshotShape(value) || value.providerId !== providerId)
        )
          return;
        if (value === null || isSnapshotShape(value)) apply(entry, value as T | null);
      })
      .catch((error: unknown) => {
        if (!isDataOwnerGenerationCurrent(entry.owner) || entry.revision !== revision) return;
        if (
          extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' ||
          (error instanceof Error && /\[(?:DEVICE_LINK_)?CHANNEL_NOT_ALLOWED\]/.test(error.message))
        ) {
          entry.unsupportedUntil = Date.now() + UNSUPPORTED_RETRY_AFTER_MS;
        }
      })
      .finally(() => {
        entry.pending = false;
      });
  }
  function useMirror(deviceId: string | null, providerId?: string): T | null {
    const entry = deviceId ? entryFor(deviceId, providerId) : null;
    const [, rerender] = useState(0);
    useEffect(() => {
      if (!deviceId || !entry) return;
      const notify = () => rerender((value) => value + 1);
      entry.listeners.add(notify);
      request(deviceId, providerId);
      const off = window.electronAPI.deviceLink.onRemotePush((push, ownerStamp) => {
        if (
          push.deviceId !== deviceId ||
          !isDataOwnerGenerationCurrent(entry.owner) ||
          !isDeviceLinkRemotePushCurrent(push, ownerStamp)
        )
          return;
        const id = providerId ?? cfg.defaultProviderId;
        let value: unknown;
        if (
          push.channel === cfg.pushChannel &&
          (!cfg.defaultProviderId || id === cfg.defaultProviderId)
        ) {
          value = push.payload;
        } else if (
          push.channel === cfg.providerPushChannel &&
          isSnapshotShape(push.payload) &&
          push.payload.providerId === id
        ) {
          value = push.payload.snapshot;
        } else return;
        if (value !== null && !isSnapshotShape(value)) return;
        entry.unsupportedUntil = 0;
        apply(entry, value as T | null);
      });
      return () => {
        entry.listeners.delete(notify);
        off();
      };
    }, [deviceId, providerId, entry]);
    // Read the current entry during render: switching devices/accounts must not show the old value.
    return entry?.snapshot ?? null;
  }
  return {
    useMirror,
    request,
    resetForTest: () => {
      entries.clear();
      cacheOwner = getDataOwnerGeneration();
    },
  };
}
