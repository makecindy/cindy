import { useCallback, useEffect, useState } from 'react';

import {
  getGitSafetyMode,
  getGitSafetyAutoSnapshotEnabled,
  persistLegacyGitSafetyOptOut,
  setGitSafetyMode,
  subscribeGitSafetyAutoSnapshotEnabled,
  subscribeGitSafetyMode,
} from '@/lib/gitSafetySettingsStore';
import type { GitSafetyMode } from '@/lib/gitSafetySettingsStore';

interface DeviceLinkShape {
  invoke: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;
}

type GitSafetyWire = {
  mode?: GitSafetyMode;
  autoSnapshotEnabled: boolean;
  autoInitProjectGit: boolean;
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
      (typeof (value as GitSafetyWire).mode === 'string' ||
        typeof (value as GitSafetyWire).autoSnapshotEnabled === 'boolean'),
  );
}

function modeFromWire(value: GitSafetyWire): GitSafetyMode {
  if (value.mode === 'off' || value.mode === 'existing-git' || value.mode === 'all-projects') {
    return value.mode;
  }
  return value.autoSnapshotEnabled ? 'all-projects' : 'off';
}

const remoteCache = new Map<string, GitSafetyMode>();
const remoteInflight = new Map<string, Promise<GitSafetyMode>>();
const remoteDeviceGen = new Map<string, number>();

async function fetchRemoteGitSafetyAutoSnapshotEnabled(
  deviceId: string,
  opts: { force?: boolean } = {},
): Promise<GitSafetyMode> {
  const cached = remoteCache.get(deviceId);
  if (!opts.force && cached) return cached;
  const ip = remoteInflight.get(deviceId);
  if (ip) return ip;

  const startGen = remoteDeviceGen.get(deviceId) ?? 0;
  const isCurrent = (): boolean => (remoteDeviceGen.get(deviceId) ?? 0) === startGen;

  const dl = getDeviceLink();
  if (!dl) throw new Error('device-link IPC not available');
  const p = dl.invoke(deviceId, 'maker:git-safety:get', [])
    .then((settings) => (isGitSafetyWire(settings) ? modeFromWire(settings) : 'off'))
    .then((mode) => {
      if (isCurrent()) {
        remoteCache.set(deviceId, mode);
        remoteInflight.delete(deviceId);
      }
      return mode;
    })
    .catch((e) => {
      if (isCurrent()) remoteInflight.delete(deviceId);
      throw e;
    });
  remoteInflight.set(deviceId, p);
  return p;
}

export function useGitSafetySettings(): {
  mode: GitSafetyMode;
  autoSnapshotEnabled: boolean;
  isCustomized: boolean;
  setMode: (next: GitSafetyMode) => Promise<void>;
  setAutoSnapshotEnabled: (next: boolean) => Promise<void>;
  reset: () => Promise<void>;
} {
  const [mode, setModeState] = useState<GitSafetyMode>(getGitSafetyMode);
  const [autoSnapshotEnabled, setEnabledState] = useState<boolean>(getGitSafetyAutoSnapshotEnabled);
  const [isCustomized, setIsCustomized] = useState(false);

  const refresh = useCallback(async (isCancelled: () => boolean = () => false) => {
    try {
      if (await persistLegacyGitSafetyOptOut()) {
        if (isCancelled()) return;
        setModeState('off');
        setEnabledState(false);
        setIsCustomized(true);
        return;
      }
    } catch {
      return;
    }
    const settings = await window.electronAPI.maker.gitSafetyGet();
    if (isCancelled()) return;
    const nextMode = modeFromWire(settings);
    setGitSafetyMode(nextMode);
    setModeState(nextMode);
    setEnabledState(nextMode !== 'off');
    setIsCustomized(settings.isCustomized);
  }, []);

  const setMode = useCallback(async (next: GitSafetyMode) => {
    const settings = await window.electronAPI.maker.gitSafetySet(next);
    const nextMode = modeFromWire(settings);
    setGitSafetyMode(nextMode);
    setModeState(nextMode);
    setEnabledState(nextMode !== 'off');
    setIsCustomized(settings.isCustomized);
  }, []);

  const setAutoSnapshotEnabled = useCallback(
    (next: boolean) => setMode(next ? 'all-projects' : 'off'),
    [setMode],
  );

  const reset = useCallback(async () => {
    const settings = await window.electronAPI.maker.gitSafetyReset();
    const nextMode = modeFromWire(settings);
    setGitSafetyMode(nextMode);
    setModeState(nextMode);
    setEnabledState(nextMode !== 'off');
    setIsCustomized(settings.isCustomized);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refresh(() => cancelled).catch(() => undefined);
    const unsubscribe = subscribeGitSafetyAutoSnapshotEnabled((next) => {
      if (!cancelled) setEnabledState(next);
    });
    const unsubscribeMode = subscribeGitSafetyMode((next, source) => {
      if (!cancelled) {
        setModeState(next);
        setEnabledState(next !== 'off');
        // The mode mirror cannot carry isCustomized. Refresh main's complete
        // wire state so Settings windows also converge on override/reset changes.
        if (source === 'storage') void refresh(() => cancelled).catch(() => undefined);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeMode();
    };
  }, [refresh]);

  return { mode, autoSnapshotEnabled, isCustomized, setMode, setAutoSnapshotEnabled, reset };
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
    deviceId ? (remoteCache.get(deviceId) ?? 'off') !== 'off' : false,
  );

  useEffect(() => {
    if (!deviceId) {
      setRemoteEnabled(false);
      return;
    }
    let cancelled = false;
    const cached = remoteCache.get(deviceId);
    if (cached) {
      setRemoteEnabled(cached !== 'off');
    } else {
      setRemoteEnabled(false);
    }
    const refreshRemote = () => {
      fetchRemoteGitSafetyAutoSnapshotEnabled(deviceId, { force: true })
        .then((enabled) => {
          if (!cancelled) setRemoteEnabled(enabled !== 'off');
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
