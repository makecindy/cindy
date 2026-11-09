/** Remote usage data only; each device/provider consumes the same snapshots as its local UI. */
import { useEffect, useRef, useState } from 'react';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { HIDDEN_ANIMATION_ATTR } from '@/lib/hiddenAnimationGate';
import { extractIpcError } from '@/utils/ipcError';

const UNSUPPORTED_RETRY_AFTER_MS = 15 * 60_000;
/** A mount may reuse a live consumer's snapshot no older than this instead of re-reading. */
const MOUNT_REUSE_MS = 60_000;
function isSnapshotShape(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface RemoteDeviceUsageMirror<T> {
  useMirror(deviceId: string | null, providerId?: string, options?: { live?: boolean; refreshEpoch?: number }): T | null;
  request(deviceId: string, providerId?: string, queueIfPending?: boolean, scheduling?: { background?: boolean }): void;
  resetForTest(): void;
}

export function createRemoteDeviceUsageMirror<T extends object>(cfg: {
  invokeChannel: string | null;
  /** Optional reader for an existing channel with a legacy fallback. */
  read?: (deviceId: string, providerId?: string) => Promise<unknown>;
  /** Only visible, mounted consumers poll; all consumers still share the entry. */
  refreshIntervalMs?: number;
  /** Native group quota owns one recovery observer per shared account entry. */
  refreshOnReconnect?: boolean;
  decodeRead?: (value: unknown) => T | null | undefined;
  /** A read may return a richer contract than its invalidation push. */
  decodePush?: (value: unknown) => T | null | undefined;
  /** A failed reread cannot establish that a cached native snapshot still belongs to the current account. */
  clearOnReadFailure?: boolean;
  invokeArgs?: unknown[];
  pushChannel: string | null;
  defaultProviderId?: string;
  providerPushChannel?: string;
}): RemoteDeviceUsageMirror<T> {
  type Entry = {
    snapshot: T | null;
    revision: number;
    unsupportedUntil: number;
    pending: boolean;
    refreshQueued: boolean;
    liveObservers: number;
    hasLiveObservation: boolean;
    liveRefreshes: Set<object>;
    refreshSupportProbe?: boolean;
    stopReconnect?: () => void;
    refreshScheduling?: { background?: boolean };
    /** Last time a read or push settled this entry; 0 = never. */
    settledAt: number;
    requestedAt: number;
    owner: ReturnType<typeof getDataOwnerGeneration>;
    listeners: Set<() => void>;
  };
  const entries = new Map<string, Entry>();
  let cacheOwner = getDataOwnerGeneration();
  function entryFor(deviceId: string, providerId?: string): Entry {
    if (!isDataOwnerGenerationCurrent(cacheOwner)) {
      cacheOwner = getDataOwnerGeneration();
      for (const entry of entries.values()) entry.stopReconnect?.();
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
        refreshQueued: false,
        liveObservers: 0,
        hasLiveObservation: false,
        liveRefreshes: new Set(),
        settledAt: 0,
        requestedAt: 0,
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
    entry.settledAt = Date.now();
    for (const notify of entry.listeners) notify();
  }
  function request(deviceId: string, providerId?: string, queueIfPending = false, scheduling?: { background?: boolean }, retryUnsupported = false): void {
    if (!cfg.invokeChannel && !cfg.read) return;
    const entry = entryFor(deviceId, providerId);
    if (entry.pending) {
      if (queueIfPending) {
        // An explicit recovery must keep its foreground priority even if a
        // background refresh was already queued behind the current read.
        if (!entry.refreshQueued || !scheduling?.background) entry.refreshScheduling = scheduling;
        entry.refreshQueued = true;
        entry.refreshSupportProbe ||= retryUnsupported;
      }
      return;
    }
    if (retryUnsupported) entry.unsupportedUntil = 0;
    if (Date.now() < entry.unsupportedUntil) return;
    const revision = entry.revision;
    const args = [...(cfg.invokeArgs ?? [])];
    // Keep the legacy builtin call shape; scoped reads must explicitly name their provider.
    if (providerId && providerId !== cfg.defaultProviderId) args.push(providerId);
    entry.pending = true;
    entry.requestedAt = Date.now();
    const reading = cfg.read
      ? cfg.read(deviceId, providerId ?? cfg.defaultProviderId)
      : scheduling
        ? window.electronAPI.deviceLink.invoke(deviceId, cfg.invokeChannel!, args, scheduling)
        : window.electronAPI.deviceLink.invoke(deviceId, cfg.invokeChannel!, args);
    void reading
      .then((value) => {
        if (!isDataOwnerGenerationCurrent(entry.owner) || entry.revision !== revision) return;
        // Older hosts may ignore new optional arguments. Never accept their builtin snapshot
        // as a named account's usage; scoped handlers echo the provider they actually read.
        if (
          providerId &&
          providerId !== cfg.defaultProviderId &&
          value !== null &&
          (!isSnapshotShape(value) || value.providerId !== providerId)
        ) {
          if (cfg.clearOnReadFailure) apply(entry, null);
          return;
        }
        if (cfg.decodeRead) {
          const decoded = cfg.decodeRead(value);
          if (decoded !== undefined) apply(entry, decoded);
          else if (cfg.clearOnReadFailure) apply(entry, null);
        } else if (value === null || isSnapshotShape(value)) apply(entry, value as T | null);
        else if (cfg.clearOnReadFailure) apply(entry, null);
      })
      .catch((error: unknown) => {
        if (!isDataOwnerGenerationCurrent(entry.owner) || entry.revision !== revision) return;
        if (
          extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' ||
          (error instanceof Error && /\[(?:DEVICE_LINK_)?CHANNEL_NOT_ALLOWED\]/.test(error.message))
        ) {
          entry.unsupportedUntil = Date.now() + UNSUPPORTED_RETRY_AFTER_MS;
        }
        if (cfg.clearOnReadFailure) apply(entry, null);
      })
      .finally(() => {
        entry.pending = false;
        const liveQueued = entry.liveRefreshes.size > 0;
        entry.liveRefreshes.clear();
        if (entry.refreshQueued || liveQueued) {
          const queuedScheduling = liveQueued ? undefined : entry.refreshScheduling;
          // An old in-flight request can install a negative capability cache
          // after reconnect. Native probes and still-observed live recovery
          // tokens bypass that TTL; cancelling the card removes its token.
          const retrySupport = entry.refreshSupportProbe || liveQueued;
          entry.refreshSupportProbe = false;
          entry.refreshQueued = false;
          entry.refreshScheduling = undefined;
          if (isDataOwnerGenerationCurrent(entry.owner) && entry.listeners.size > 0) request(deviceId, providerId, false, queuedScheduling, retrySupport);
        }
      });
  }
  function useMirror(deviceId: string | null, providerId?: string, options: { live?: boolean; refreshEpoch?: number } = {}): T | null {
    const entry = deviceId ? entryFor(deviceId, providerId) : null;
    const live = options.live === true;
    const refreshEpoch = live ? options.refreshEpoch : undefined;
    const lastLiveEntry = useRef<Entry | null>(null);
    const [, rerender] = useState(0);
    useEffect(() => {
      if (!deviceId || !entry) return;
      const notify = () => rerender((value) => value + 1);
      // Consumers of one device/account (session chip, model picker rail and rows) share this
      // entry, so a mount beside a live consumer reuses its fresh snapshot. With no listener a
      // clear push (logout, account switch) may have been missed, and pushes are also lost while
      // the link is down; both cases read the device again. Explicit request() always reads.
      const settled =
        entry.listeners.size > 0 &&
        entry.settledAt > 0 &&
        Date.now() - entry.settledAt < MOUNT_REUSE_MS;
      // A pending request from before an observation gap cannot stand in for
      // the fresh read required on resume/reconnect. A changed live refreshEpoch
      // reopens this observation so its queued work remains owned by this effect.
      // Concurrent first-time live consumers still share the pending read.
      const firstObserver = entry.listeners.size === 0;
      const resumePending = !live && firstObserver && entry.pending;
      const resumed = live && (lastLiveEntry.current === entry ||
        (entry.hasLiveObservation && entry.liveObservers === 0));
      let liveRefresh: object | undefined;
      if (live) {
        entry.liveObservers++;
        entry.hasLiveObservation = true;
        lastLiveEntry.current = entry;
        if (resumed && entry.pending) {
          liveRefresh = {};
          entry.liveRefreshes.add(liveRefresh);
        }
      }
      entry.listeners.add(notify);
      if (cfg.refreshOnReconnect && firstObserver) {
        // Subscribe once per entry, rather than once per card: contextBridge
        // can clone the same host event separately for different consumers.
        let online: boolean | null = true;
        let relay: 'stopped' | 'connecting' | 'online' | null = null;
        const recover = () => {
          if (isDataOwnerGenerationCurrent(entry.owner) && entry.listeners.size > 0) {
            request(deviceId, providerId, true, undefined, true);
          }
        };
        const api = window.electronAPI.deviceLink;
        const offPresence = api.onPresenceChanged(snapshot => {
          if (snapshot.deviceId !== deviceId) return;
          const wasOnline = online;
          online = snapshot.online;
          if (online && wasOnline !== true) recover();
        });
        const offStatus = api.onStatusChanged(({ status }) => {
          const previous = relay;
          relay = status;
          if (status !== 'online') online = null;
          else if (previous !== 'online') { online = true; recover(); }
        });
        const offReset = api.onPeerLinkReset?.(event => { if (event.deviceId === deviceId) recover(); });
        const offReopened = api.onPeerLinkReopened?.(event => { if (event.deviceId === deviceId) recover(); });
        entry.stopReconnect = () => { offPresence(); offStatus(); offReset?.(); offReopened?.(); };
      }
      // The existing gate also includes native hide/minimize broadcasts: Electron
      // can keep visibilityState "visible" while active turns disable throttling.
      const visible = () => document.visibilityState !== 'hidden'
        && !document.documentElement.hasAttribute(HIDDEN_ANIMATION_ATTR);
      // An explicit live recovery rechecks capabilities; ordinary polling still
      // respects the negative cache, including after another unsupported reply.
      if ((!settled || resumed) && (!cfg.refreshIntervalMs || visible())) request(deviceId, providerId, resumePending, undefined, resumed || (cfg.refreshOnReconnect && firstObserver));
      let timer: ReturnType<typeof setInterval> | undefined;
      const poll = () => {
        if (!isDataOwnerGenerationCurrent(entry.owner) || !visible()) return;
        if (Date.now() - entry.requestedAt >= cfg.refreshIntervalMs!) request(deviceId, providerId);
      };
      const watchVisibility = () => {
        clearInterval(timer);
        timer = undefined;
        if (visible()) {
          poll();
          timer = setInterval(poll, cfg.refreshIntervalMs);
        }
      };
      if (cfg.refreshIntervalMs) {
        watchVisibility();
        document.addEventListener('visibilitychange', watchVisibility);
      }
      const hiddenObserver = cfg.refreshIntervalMs ? new MutationObserver(watchVisibility) : undefined;
      hiddenObserver?.observe(document.documentElement, {
        attributes: true, attributeFilter: [HIDDEN_ANIMATION_ATTR],
      });
      const off = cfg.pushChannel ? window.electronAPI.deviceLink.onRemotePush((push, ownerStamp) => {
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
        const decoded = cfg.decodePush ? cfg.decodePush(value) : (value as T | null);
        if (decoded === undefined) return;
        entry.unsupportedUntil = 0;
        if (decoded === null) entry.liveRefreshes.clear();
        apply(entry, decoded);
      }) : () => {};
      return () => {
        clearInterval(timer);
        hiddenObserver?.disconnect();
        if (cfg.refreshIntervalMs) document.removeEventListener('visibilitychange', watchVisibility);
        entry.listeners.delete(notify);
        if (live) entry.liveObservers--;
        if (liveRefresh) entry.liveRefreshes.delete(liveRefresh);
        if (entry.listeners.size === 0) { entry.stopReconnect?.(); entry.stopReconnect = undefined; }
        off();
      };
    }, [deviceId, providerId, entry, live, refreshEpoch]);
    // Read the current entry during render: switching devices/accounts must not show the old value.
    return entry?.snapshot ?? null;
  }
  return {
    useMirror,
    request,
    resetForTest: () => {
      for (const entry of entries.values()) entry.stopReconnect?.();
      entries.clear();
      cacheOwner = getDataOwnerGeneration();
    },
  };
}
