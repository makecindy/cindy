import { useCallback, useEffect, useState } from 'react';

import {
  getGitSafetyAutoSnapshotEnabled,
  setGitSafetyAutoSnapshotEnabled,
  subscribeGitSafetyAutoSnapshotEnabled,
} from '@/lib/gitSafetySettingsStore';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

interface DeviceLinkShape {
  invoke: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;
}

type GitSafetyWire = {
  autoSnapshotEnabled: boolean;
  isCustomized: boolean;
  defaultAutoSnapshotEnabled: boolean;
};

function getDeviceLink(): DeviceLinkShape | null {
  const dl = (window as unknown as {
    electronAPI?: { deviceLink?: DeviceLinkShape };
  }).electronAPI?.deviceLink;
  return dl ?? null;
}

function isGitSafetyWire(value: unknown): value is GitSafetyWire {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as GitSafetyWire).autoSnapshotEnabled === 'boolean',
  );
}

const remoteCache = new Map<string, boolean>();
const remoteInflight = new Map<string, Promise<boolean>>();
const remoteDeviceGen = new Map<string, number>();

async function fetchRemoteGitSafetyAutoSnapshotEnabled(
  deviceId: string,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const cached = remoteCache.get(deviceId);
  if (!opts.force && typeof cached === 'boolean') return cached;
  const ip = remoteInflight.get(deviceId);
  if (ip) return ip;

  const startGen = remoteDeviceGen.get(deviceId) ?? 0;
  const isCurrent = (): boolean => (remoteDeviceGen.get(deviceId) ?? 0) === startGen;

  const dl = getDeviceLink();
  if (!dl) throw new Error('device-link IPC not available');
  const p = dl.invoke(deviceId, IPC_CHANNELS.MAKER_INVOKE.GIT_SAFETY_GET, [])
    .then((settings) => (isGitSafetyWire(settings) ? settings.autoSnapshotEnabled : false))
    .then((enabled) => {
      if (isCurrent()) {
        remoteCache.set(deviceId, enabled);
        remoteInflight.delete(deviceId);
      }
      return enabled;
    })
    .catch((e) => {
      if (isCurrent()) remoteInflight.delete(deviceId);
      throw e;
    });
  remoteInflight.set(deviceId, p);
  return p;
}

export function useGitSafetySettings(): {
  autoSnapshotEnabled: boolean;
  isCustomized: boolean;
  setAutoSnapshotEnabled: (next: boolean) => Promise<void>;
  reset: () => Promise<void>;
} {
  const [autoSnapshotEnabled, setEnabledState] = useState<boolean>(getGitSafetyAutoSnapshotEnabled);
  const [isCustomized, setIsCustomized] = useState(false);

  const refresh = useCallback(async (isCancelled: () => boolean = () => false) => {
    const settings = await window.electronAPI.maker.gitSafetyGet();
    if (isCancelled()) return;
    setGitSafetyAutoSnapshotEnabled(settings.autoSnapshotEnabled);
    setEnabledState(settings.autoSnapshotEnabled);
    setIsCustomized(settings.isCustomized);
  }, []);

  const setAutoSnapshotEnabled = useCallback(async (next: boolean) => {
    const settings = await window.electronAPI.maker.gitSafetySet(next);
    setGitSafetyAutoSnapshotEnabled(settings.autoSnapshotEnabled);
    setEnabledState(settings.autoSnapshotEnabled);
    setIsCustomized(settings.isCustomized);
  }, []);

  const reset = useCallback(async () => {
    const settings = await window.electronAPI.maker.gitSafetyReset();
    setGitSafetyAutoSnapshotEnabled(settings.autoSnapshotEnabled);
    setEnabledState(settings.autoSnapshotEnabled);
    setIsCustomized(settings.isCustomized);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refresh(() => cancelled).catch(() => undefined);
    const unsubscribe = subscribeGitSafetyAutoSnapshotEnabled((next) => {
      if (!cancelled) setEnabledState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [refresh]);

  return { autoSnapshotEnabled, isCustomized, setAutoSnapshotEnabled, reset };
}

export function useGitSafetyAutoSnapshotEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(getGitSafetyAutoSnapshotEnabled);

  useEffect(() => subscribeGitSafetyAutoSnapshotEnabled(setEnabled), []);

  return enabled;
}

/**
 * Codex Rewind safety gate for local and device-link sessions.
 *
 * Local sessions use the existing synchronous renderer mirror. Device-link
 * sessions must read the controlled device's setting because snapshots are
 * created there, not in the controller window.
 */
export function useGitSafetyAutoSnapshotEnabledForDevice(deviceId?: string): boolean {
  const localEnabled = useGitSafetyAutoSnapshotEnabled();
  const [remoteEnabled, setRemoteEnabled] = useState<boolean>(
    deviceId ? remoteCache.get(deviceId) ?? false : false,
  );

  useEffect(() => {
    if (!deviceId) {
      setRemoteEnabled(false);
      return;
    }
    let cancelled = false;
    const cached = remoteCache.get(deviceId);
    if (typeof cached === 'boolean') {
      setRemoteEnabled(cached);
    } else {
      setRemoteEnabled(false);
    }
    const refreshRemote = () => {
      fetchRemoteGitSafetyAutoSnapshotEnabled(deviceId, { force: true })
        .then((enabled) => {
          if (!cancelled) setRemoteEnabled(enabled);
        })
        .catch(() => {
          if (!cancelled) setRemoteEnabled(false);
        });
    };
    refreshRemote();
    window.addEventListener('focus', refreshRemote);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refreshRemote);
    };
  }, [deviceId]);

  return deviceId ? remoteEnabled : localEnabled;
}

/** device-link:被控设备下线 / 断链时驱逐其 Git safety setting cache。 */
export function evictDeviceGitSafetySettings(deviceId: string): void {
  remoteCache.delete(deviceId);
  remoteInflight.delete(deviceId);
  remoteDeviceGen.set(deviceId, (remoteDeviceGen.get(deviceId) ?? 0) + 1);
}

export async function prefetchDeviceGitSafetySettings(deviceId: string): Promise<void> {
  try {
    await fetchRemoteGitSafetyAutoSnapshotEnabled(deviceId);
  } catch {
    // Opening a remote session will retry; until then Codex Rewind stays hidden.
  }
}
