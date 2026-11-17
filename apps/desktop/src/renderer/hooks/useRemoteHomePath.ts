import { useCallback, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';
import type { SessionFileOrigin } from '@/lib/sessionFileOrigin';

const CACHE_CAP = 500;
const RETRY_AFTER_MS = 30_000;
type Entry = {
  owner: ReturnType<typeof getDataOwnerGeneration>;
  deviceId: string;
  workingDir: string;
  href: string;
  path: string | null;
  checkedAt: number;
  pending?: Promise<string | null>;
  refreshQueued: boolean;
  listeners: Set<() => void>;
};
const entries = new Map<string, Entry>();
let owner = getDataOwnerGeneration();
let stopObserving: (() => void) | undefined;

export function isHomePath(href: string): boolean {
  return /^~(?:[\\/]|$)/.test(href);
}

function trimCache(): void {
  for (const [key, entry] of entries) {
    if (entries.size <= CACHE_CAP) break;
    if (!entry.pending && entry.listeners.size === 0) entries.delete(key);
  }
}

function entryFor(deviceId: string, workingDir: string, href: string): Entry {
  if (!isDataOwnerGenerationCurrent(owner)) {
    stopObserving?.();
    stopObserving = undefined;
    entries.clear();
    owner = getDataOwnerGeneration();
  }
  const key = JSON.stringify([deviceId, workingDir, href]);
  let entry = entries.get(key);
  if (!entry) {
    entry = { owner, deviceId, workingDir, href, path: null, checkedAt: 0, refreshQueued: false, listeners: new Set() };
    entries.set(key, entry);
    // Render creates entries before React subscribes. Trim only after requests
    // settle or subscriptions leave, so new mounted entries cannot be evicted
    // before they acquire their listeners (including duplicates in this render).
  }
  return entry;
}

function visible(): boolean {
  return document.visibilityState !== 'hidden' && !isWindowHidden();
}

/** Only the owning device can expand ~. No viewer-home or cwd/~ fallback. */
function request(entry: Entry, refresh = false): Promise<string | null> {
  if (!isDataOwnerGenerationCurrent(entry.owner)) return Promise.resolve(null);
  if (entry.pending) {
    // A recovery while an old call is pending must not be lost. Keep one
    // follow-up, never parallel calls or a connection-level restart.
    if (refresh) entry.refreshQueued = true;
    return entry.pending;
  }
  if (!refresh && (entry.path || Date.now() - entry.checkedAt < RETRY_AFTER_MS)) {
    return Promise.resolve(entry.path);
  }
  entry.pending = (async () => {
    let force = refresh;
    do {
      entry.refreshQueued = false;
      let path: string | null = null;
      try {
        const result = await window.electronAPI.deviceLink.invoke(entry.deviceId, 'fs:resolve-path', [{
          href: entry.href,
          workingDir: entry.workingDir,
          ...(force ? { refresh: true } : {}),
        }]) as Awaited<ReturnType<typeof window.electronAPI.resolvePath>>;
        const candidate = result?.status === 'unique' ? result.candidates?.[0] : undefined;
        if (typeof candidate === 'string' && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(candidate)) path = candidate;
      } catch { /* Offline or unsupported: remain unresolved until a natural retry boundary. */ }
      if (!isDataOwnerGenerationCurrent(entry.owner)) return null;
      if (!entry.refreshQueued) {
        entry.path = path;
        entry.checkedAt = Date.now();
        for (const notify of entry.listeners) notify();
      }
      force = true;
    } while (entry.refreshQueued && entry.listeners.size > 0 && visible());
    return entry.path;
  })().finally(() => { entry.pending = undefined; trimCache(); });
  return entry.pending;
}

function observe(): void {
  if (stopObserving) return;
  // One observer for all mounted references, so duplicate chips cannot turn
  // one connection event into many refreshes. No polling while offline.
  const recover = (deviceId?: string) => {
    if (!visible()) return;
    for (const entry of entries.values()) {
      if (entry.listeners.size && !entry.path && (!deviceId || entry.deviceId === deviceId)) void request(entry, true);
    }
  };
  const focus = () => recover();
  const link = window.electronAPI.deviceLink;
  const online = new Map<string, boolean>();
  let relay: string | undefined;
  const offPresence = link.onPresenceChanged?.(event => {
    if (![...entries.values()].some(entry => entry.listeners.size && entry.deviceId === event.deviceId)) return;
    const previous = online.get(event.deviceId);
    online.set(event.deviceId, event.online);
    if (event.online && previous !== true) recover(event.deviceId);
  });
  const offStatus = link.onStatusChanged?.(event => {
    const previous = relay;
    relay = event.status;
    if (event.status === 'online' && previous !== 'online') recover();
  });
  const offReopened = link.onPeerLinkReopened?.(event => recover(event.deviceId));
  const offHidden = window.electronAPI.onWindowHiddenChange?.(hidden => { if (!hidden) recover(); });
  window.addEventListener('focus', focus);
  document.addEventListener('visibilitychange', focus);
  stopObserving = () => {
    offPresence?.(); offStatus?.(); offReopened?.(); offHidden?.();
    window.removeEventListener('focus', focus);
    document.removeEventListener('visibilitychange', focus);
  };
}

/** Explicit authored-link retry uses the very same owner-scoped lookup. */
export function resolveRemoteHomePath(deviceId: string, workingDir: string, href: string): Promise<string | null> {
  return isHomePath(href) ? request(entryFor(deviceId, workingDir, href), true) : Promise.resolve(null);
}

export function useRemoteHomePath(origin: SessionFileOrigin, workingDir: string, href: string | null): string | null {
  const entry = origin.kind === 'device' && href && isHomePath(href)
    ? entryFor(origin.deviceId, workingDir, href) : null;
  const subscribe = useCallback((notify: () => void) => {
    if (!entry) return () => {};
    entry.listeners.add(notify);
    observe();
    if (visible()) void request(entry);
    return () => {
      entry.listeners.delete(notify);
      if (![...entries.values()].some(item => item.listeners.size)) {
        stopObserving?.();
        stopObserving = undefined;
      }
      trimCache();
    };
  }, [entry]);
  const snapshot = useCallback(() => entry && isDataOwnerGenerationCurrent(entry.owner) ? entry.path : null, [entry]);
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
