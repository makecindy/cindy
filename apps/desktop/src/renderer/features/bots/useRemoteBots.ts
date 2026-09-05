import { useEffect, useSyncExternalStore } from 'react';
import {
  REMOTE_RESOURCE_CHANGED_CHANNEL,
  REMOTE_RESOURCE_LIST_CHANNEL,
  type RemoteCollectionListRequest,
} from '@cindy/device-link';
import { useAuth } from '@/contexts/AuthContext';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { parseRemoteBots, type RemoteBot } from './remoteBotRoster';

const CACHE_PREFIX = 'cindy.remoteBots.v1.';
let owner: string | null = null;
let snapshot: RemoteBot[] = [];
const listeners = new Set<() => void>();
const publish = (next: RemoteBot[]) => {
  snapshot = next;
  if (owner) {
    try { const value = JSON.stringify(next.map((bot) => ({ ...bot, online: false })));
      if (value.length <= 256 * 1024) window.localStorage.setItem(CACHE_PREFIX + owner, value);
    } catch { /* display cache may be unavailable */ }
  }
  listeners.forEach((fn) => fn());
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const empty: RemoteBot[] = [];

export function useRemoteBots(): readonly RemoteBot[] {
  const { dataOwnerId, isAuthenticated } = useAuth();
  const rows = useSyncExternalStore(subscribe, () => snapshot);
  return isAuthenticated && owner === dataOwnerId ? rows : empty;
}

/** One subscription owner in BotsFeatureLayout; a failed host cannot erase another host. */
export function useRemoteBotSync(): void {
  const { dataOwnerId, isAuthenticated } = useAuth();
  const devices = useDeviceLinkDeviceList();
  const revoked = useSyncExternalStore(
    revokedDevicesStore.subscribe,
    revokedDevicesStore.getSnapshot,
  );
  useEffect(() => {
    const nextOwner = isAuthenticated ? (dataOwnerId ?? null) : null;
    if (owner !== nextOwner) {
      owner = nextOwner;
      let cached: RemoteBot[] = [];
      try {
        if (!nextOwner) {
          for (const key of Object.keys(window.localStorage)) if (key.startsWith(CACHE_PREFIX)) window.localStorage.removeItem(key);
        } else {
          const raw = window.localStorage.getItem(CACHE_PREFIX + nextOwner);
          if (raw && raw.length <= 256 * 1024) {
            const rows = JSON.parse(raw);
            if (Array.isArray(rows)) cached = rows.slice(0, 200).filter((bot) => bot && ['id', 'deviceId', 'deviceName', 'name', 'avatar', 'avatarColor', 'description', 'preview'].every((key) => typeof bot[key] === 'string') && Number.isFinite(bot.activityAt)).map((bot) => ({
              id: bot.id, deviceId: bot.deviceId, deviceName: bot.deviceName, name: bot.name,
              avatar: bot.avatar, avatarColor: bot.avatarColor, description: bot.description, preview: bot.preview,
              activityAt: bot.activityAt, sessionId: typeof bot.sessionId === 'string' ? bot.sessionId : null,
              lastReplyAt: Number.isFinite(bot.lastReplyAt) ? bot.lastReplyAt : undefined,
              readAt: Number.isFinite(bot.readAt) ? bot.readAt : undefined, online: false,
            }));
          }
        }
      } catch { /* missing/corrupt cache */ }
      publish(cached);
    }
    if (!nextOwner) return;
    if (!devices) { publish(snapshot.map((bot) => ({ ...bot, online: false }))); return; }
    let disposed = false;
    let relayAvailable = false;
    let statusRevision = 0;
    const hosts = devices.filter(
      (d) => !d.isSelf && d.controlEnabled && d.remoteControlEnabled && !revoked.has(d.deviceId),
    );
    const byId = new Map(hosts.map((d) => [d.deviceId, d]));
    publish(
      snapshot
        .filter((bot) => byId.has(bot.deviceId))
        .map((bot) => ({ ...bot, online: bot.online && byId.get(bot.deviceId)!.online, deviceName: byId.get(bot.deviceId)!.name })),
    );
    const generations = new Map<string, number>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const current = () => !disposed && owner === nextOwner;
    async function refresh(deviceId: string) {
      const host = byId.get(deviceId);
      if (!host?.online || !relayAvailable || !current()) return;
      const epoch = (generations.get(deviceId) ?? 0) + 1;
      generations.set(deviceId, epoch);
      try {
        const request: RemoteCollectionListRequest = {
          client: { protocolVersion: 1, primitives: ['status', 'session-link'] },
          collectionId: 'teammates',
          limit: 200,
        };
        const result = await window.electronAPI.deviceLink.invoke(
          deviceId,
          REMOTE_RESOURCE_LIST_CHANNEL,
          [request],
        );
        if (!current() || generations.get(deviceId) !== epoch) return;
        const bots = parseRemoteBots(result, deviceId, host.name).map((bot) => ({
          ...bot, readAt: snapshot.find((old) => old.deviceId === deviceId && old.id === bot.id)?.readAt ?? bot.lastReplyAt ?? 0,
        }));
        publish([...snapshot.filter((bot) => bot.deviceId !== deviceId), ...bots]);
      } catch {
        if (!current() || generations.get(deviceId) !== epoch) return;
        // Old hosts do not advertise this API. Keep their cached rows offline;
        // retry on a real reconnect or change, never downgrade to a local call.
        publish(
          snapshot.map((bot) => (bot.deviceId === deviceId ? { ...bot, online: false } : bot)),
        );
      }
    }
    // The app's existing remote-session synchronizer owns the sessions topic.
    // Sharing its pushes avoids competing subscribe/unsubscribe owners.
    // Subscribe before reading status: a stopped/connecting relay cannot inherit
    // a stale device directory's online flag, and a late GET cannot undo a push.
    const offPush = window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
      if (
        !current() ||
        push.channel !== REMOTE_RESOURCE_CHANGED_CHANNEL ||
        !byId.has(push.deviceId) ||
        !isDeviceLinkRemotePushCurrent(push, stamp)
      )
        return;
      if (timers.has(push.deviceId)) return;
      timers.set(
        push.deviceId,
        setTimeout(() => {
          timers.delete(push.deviceId);
          void refresh(push.deviceId);
        }, 500),
      );
    });
    const offStatus = window.electronAPI.deviceLink.onStatusChanged((state) => {
      if (!current()) return;
      statusRevision += 1;
      relayAvailable = state.status === 'online';
      if (state.status === 'online') {
        for (const host of hosts) if (host.online) void refresh(host.deviceId);
      } else {
        for (const id of byId.keys()) generations.set(id, (generations.get(id) ?? 0) + 1);
        publish(
          snapshot.map((bot) => ({ ...bot, online: false })),
        );
      }
    });
    const revision = statusRevision;
    void window.electronAPI.deviceLink.getState().then((state) => {
      if (!current() || revision !== statusRevision) return;
      relayAvailable = state.linkStatus === 'online';
      if (relayAvailable) {
        for (const host of hosts) if (host.online) void refresh(host.deviceId);
      } else publish(snapshot.map((bot) => ({ ...bot, online: false })));
    }).catch(() => {
      if (current() && revision === statusRevision) publish(snapshot.map((bot) => ({ ...bot, online: false })));
    });
    return () => {
      disposed = true;
      offPush();
      offStatus();
      timers.forEach(clearTimeout);
    };
  }, [dataOwnerId, isAuthenticated, devices, revoked]);
}

export function markRemoteBotRead(deviceId: string, botId: string, at: number): void {
  if (!Number.isFinite(at) || at < 0) return;
  if (!snapshot.some((bot) => bot.deviceId === deviceId && bot.id === botId && (bot.readAt ?? -1) < at)) return;
  publish(snapshot.map((bot) => bot.deviceId === deviceId && bot.id === botId ? { ...bot, readAt: Math.max(bot.readAt ?? 0, at) } : bot));
}
