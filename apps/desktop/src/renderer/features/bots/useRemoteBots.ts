import { useEffect, useSyncExternalStore } from 'react';
import {
  REMOTE_RESOURCE_CHANGED_CHANNEL,
  REMOTE_RESOURCE_LIST_CHANNEL,
  type RemoteCollectionListRequest,
} from '@cindy/device-link';
import { useAuth } from '@/contexts/AuthContext';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { useCompanionCloud, companionCloudApi } from './companionCloudStore';
import { parseRemoteBots, remoteBotCreatedTaskIds, type RemoteBot } from './remoteBotRoster';

const CACHE_PREFIX = 'cindy.remoteBots.v1.';
const READ_PREFIX = 'cindy.remoteBotReads.v1.';
let owner: string | null = null;
let snapshot: RemoteBot[] = [];
let cindyIds = new Set<string>();
const listeners = new Set<() => void>();
const readKey = (bot: Pick<RemoteBot, 'deviceId' | 'id'>) => JSON.stringify([bot.deviceId, bot.id]);
function cachedReadPositions(raw: string | null): Map<string, number> {
  const positions = new Map<string, number>();
  try {
    if (!raw || raw.length > 256 * 1024) return positions;
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) return positions;
    for (const row of rows) {
      if (!row || typeof row.deviceId !== 'string' || typeof row.id !== 'string'
        || typeof row.readAt !== 'number' || !Number.isFinite(row.readAt) || row.readAt < 0) continue;
      const key = readKey(row);
      positions.set(key, Math.max(positions.get(key) ?? 0, row.readAt));
    }
  } catch { /* Missing/corrupt display cache must not affect the live roster. */ }
  return positions;
}
// Each acknowledgement has its own immutable key. Different windows (including
// two reads of the same companion) cannot replace one another's read position.
const readEntryPrefix = (account: string) => READ_PREFIX + 'entry.' + JSON.stringify(account) + '.';
function readEntries(account: string) {
  const prefix = readEntryPrefix(account);
  const entries: { key: string; identity: string; readAt: number }[] = [];
  for (const key of Object.keys(window.localStorage)) {
    if (!key.startsWith(prefix) || key.length > 256 * 1024) continue;
    try {
      const row: unknown = JSON.parse(key.slice(prefix.length));
      if (!Array.isArray(row) || row.length !== 3 || typeof row[0] !== 'string'
        || typeof row[1] !== 'string' || typeof row[2] !== 'number' || !Number.isFinite(row[2])
        || row[2] < 0 || window.localStorage.getItem(key) !== '1') continue;
      entries.push({ key, identity: readKey({ deviceId: row[0], id: row[1] }), readAt: row[2] });
    } catch { /* Ignore unrelated/corrupt entries. */ }
  }
  return entries;
}
function savedReadPositions(account: string): Map<string, number> {
  // Read the old bounded array for compatibility; new writes never replace it.
  const positions = cachedReadPositions(window.localStorage.getItem(READ_PREFIX + account));
  for (const entry of readEntries(account)) {
    positions.set(entry.identity, Math.max(positions.get(entry.identity) ?? 0, entry.readAt));
  }
  return positions;
}
function persistReadPosition(account: string, deviceId: string, id: string, readAt: number): void {
  // Observe legacy reads before committing, but never perform a whole-map RMW.
  const positions = savedReadPositions(account);
  readAt = Math.max(positions.get(readKey({ deviceId, id })) ?? 0, readAt);
  const key = readEntryPrefix(account) + JSON.stringify([deviceId, id, readAt]);
  if (key.length + 1 > 256 * 1024) return;
  window.localStorage.setItem(key, '1');
  const entries = readEntries(account).sort((a, b) => b.readAt - a.readAt);
  const newest = new Map<string, typeof entries[number]>();
  for (const entry of entries) if (!newest.has(entry.identity)) newest.set(entry.identity, entry);
  const retained = new Set<string>();
  let size = 0;
  const identity = readKey({ deviceId, id });
  // Bound the new partition, prioritizing the current identity, then recent
  // reads. Only delete observed entries; a concurrent new key is never erased.
  for (const entry of [...newest.values()].sort((a, b) =>
    Number(b.identity === identity) - Number(a.identity === identity) || b.readAt - a.readAt)) {
    if (size + entry.key.length + 1 > 256 * 1024) continue;
    retained.add(entry.key);
    size += entry.key.length + 1;
  }
  for (const entry of entries) if (!retained.has(entry.key)) window.localStorage.removeItem(entry.key);
}
function mergeReadPositions(rows: RemoteBot[], positions: ReadonlyMap<string, number>): RemoteBot[] {
  return rows.map(bot => {
    const at = positions.get(readKey(bot));
    return at !== undefined && at > (bot.readAt ?? -1) ? { ...bot, readAt: at } : bot;
  });
}
const publish = (next: RemoteBot[]) => {
  // A sibling may have marked a reply read before its storage event arrives.
  // Every cache writer must merge that position rather than rewind it.
  let stored: string | null = null;
  let reads = new Map<string, number>();
  try { if (owner) stored = window.localStorage.getItem(CACHE_PREFIX + owner); } catch { /* unavailable cache */ }
  try { if (owner) reads = savedReadPositions(owner); } catch { /* unavailable cache */ }
  next = mergeReadPositions(next, cachedReadPositions(stored));
  next = mergeReadPositions(next, reads);
  next = next.map(bot => cindyIds.has(bot.id) ? { ...bot, templateId: 'cindy' } : bot);
  snapshot = next;
  // Keep roster membership/replies single-writer. A stale secondary mirror may
  // update its own projection, but must not replace the main window's cache.
  if (owner && !isSecondaryWindow()) {
    try { const value = JSON.stringify(next.map((bot) => ({ ...bot, online: false })));
      if (value.length <= 256 * 1024 && value !== stored) window.localStorage.setItem(CACHE_PREFIX + owner, value);
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

/** Non-hook read for entry routing (island / notification clicks); empty while signed out. */
export function readRemoteBots(): readonly RemoteBot[] {
  return owner ? snapshot : empty;
}

export function useRemoteBots(): readonly RemoteBot[] {
  const { dataOwnerId, isAuthenticated } = useAuth();
  const rows = useSyncExternalStore(subscribe, () => snapshot);
  return isAuthenticated && owner === dataOwnerId ? rows : empty;
}

/** Identity discovery is independent of a home computer's roster being online. */
export function useRemoteCindyIds(): ReadonlySet<string> {
  const { dataOwnerId, isAuthenticated } = useAuth();
  const ids = useSyncExternalStore(subscribe, () => cindyIds);
  return isAuthenticated && owner === dataOwnerId ? ids : EMPTY_CINDY_IDS;
}
const EMPTY_CINDY_IDS: ReadonlySet<string> = new Set();

/** One subscription owner per app renderer; a failed host cannot erase another host. */
export function useRemoteBotSync(): void {
  const { dataOwnerId, isAuthenticated } = useAuth();
  const devices = useDeviceLinkDeviceList();
  const cloud = useCompanionCloud();
  const actorsKey = cloud.actors.map(actor => `${actor.externalId}:${actor.homeDeviceId ?? ''}`).join(',');
  const revoked = useSyncExternalStore(
    revokedDevicesStore.subscribe,
    revokedDevicesStore.getSnapshot,
  );
  useEffect(() => {
    const requestOwner = isAuthenticated ? dataOwnerId : null;
    if (!requestOwner) return;
    const onStorage = (event: StorageEvent) => {
      if (owner !== requestOwner || (event.key !== CACHE_PREFIX + requestOwner && event.key !== READ_PREFIX + requestOwner && !event.key?.startsWith(readEntryPrefix(requestOwner))) || event.newValue === null
        || (event.storageArea !== null && event.storageArea !== window.localStorage)) return;
      const positions = cachedReadPositions(event.newValue);
      try {
        for (const [key, at] of savedReadPositions(requestOwner)) positions.set(key, Math.max(positions.get(key) ?? 0, at));
      } catch { /* Keep the event's valid positions if storage is unavailable. */ }
      // Only read positions cross windows here; stale roster or connection data
      // must not replace this renderer's live projection. Repair older writes too.
      if (snapshot.some(bot => { const at = positions.get(readKey(bot)); return at !== undefined && at !== bot.readAt; })) {
        publish(mergeReadPositions(snapshot, positions));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [dataOwnerId, isAuthenticated]);
  useEffect(() => {
    const nextOwner = isAuthenticated ? (dataOwnerId ?? null) : null;
    if (owner !== nextOwner) {
      owner = nextOwner;
      cindyIds = new Set();
      let cached: RemoteBot[] = [];
      try {
        if (!nextOwner) {
          for (const key of Object.keys(window.localStorage)) if (key.startsWith(CACHE_PREFIX) || key.startsWith(READ_PREFIX)) window.localStorage.removeItem(key);
        } else {
          const raw = window.localStorage.getItem(CACHE_PREFIX + nextOwner);
          if (raw && raw.length <= 256 * 1024) {
            const rows = JSON.parse(raw);
            if (Array.isArray(rows)) cached = rows.filter((bot) => bot && ['id', 'deviceId', 'deviceName', 'name', 'avatar', 'avatarColor', 'description', 'preview'].every((key) => typeof bot[key] === 'string') && Number.isFinite(bot.activityAt)).map((bot) => ({
              id: bot.id, deviceId: bot.deviceId, deviceName: bot.deviceName, name: bot.name,
              templateId: typeof bot.templateId === 'string' ? bot.templateId : undefined,
              avatar: bot.avatar, avatarColor: bot.avatarColor, description: bot.description, preview: bot.preview,
              followingSessionIds: Array.isArray(bot.followingSessionIds) ? bot.followingSessionIds.filter((id: unknown) => typeof id === 'string') : [],
              delegatedSessionIds: Array.isArray(bot.delegatedSessionIds) ? bot.delegatedSessionIds.filter((id: unknown) => typeof id === 'string') : [],
              activityAt: bot.activityAt, sessionId: typeof bot.sessionId === 'string' ? bot.sessionId : null,
              lastReplyAt: Number.isFinite(bot.lastReplyAt) ? bot.lastReplyAt : undefined,
              readAt: Number.isFinite(bot.readAt) ? bot.readAt : undefined, online: false, connectionKnown: false,
            }));
          }
        }
      } catch { /* missing/corrupt cache */ }
      publish(cached);
    }
    if (!nextOwner) return;
    if (!devices) { publish(snapshot.map((bot) => ({ ...bot, online: false, connectionKnown: false, generation: undefined }))); return; }
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
        .map((bot) => ({ ...bot, online: bot.online && byId.get(bot.deviceId)!.online, connectionKnown: byId.get(bot.deviceId)!.online ? bot.connectionKnown : true, deviceName: byId.get(bot.deviceId)!.name })),
    );
    const generations = new Map<string, number>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const taskRefreshes = new Set<string>();
    const current = () => !disposed && owner === nextOwner;
    async function refresh(deviceId: string, refreshTasks = true) {
      const host = byId.get(deviceId);
      if (!host?.online || !relayAvailable || !current()) return;
      if (refreshTasks) taskRefreshes.add(deviceId);
      refreshTasks ||= taskRefreshes.has(deviceId);
      // Reachability comes from the live device directory + relay, never from a list/API error.
      publish(snapshot.map(bot => bot.deviceId === deviceId ? { ...bot, online: true, connectionKnown: true } : bot));
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
        const previous = new Map(snapshot.filter(bot => bot.deviceId === deviceId).map(bot => [bot.id, bot]));
        let savedReads = new Map<string, number>();
        try { if (nextOwner) savedReads = savedReadPositions(nextOwner); } catch { /* unavailable cache */ }
        const bots = parseRemoteBots(result, deviceId, host.name).map((bot) => ({
          ...bot,
          delegatedSessionIds: previous.get(bot.id)?.delegatedSessionIds,
          templateId: previous.get(bot.id)?.templateId,
          readAt: previous.get(bot.id)?.readAt ?? savedReads.get(readKey(bot)) ?? bot.lastReplyAt ?? 0,
        }));
        publish([...snapshot.filter((bot) => bot.deviceId !== deviceId), ...bots]);
        // Older released hosts already expose the task-card list, even when their
        // directory has no task links. Read serially per host; never per task row.
        for (const bot of bots) {
          if (!current() || generations.get(deviceId) !== epoch) return;
          if (!bot.sessionId) continue;
          const old = previous.get(bot.id);
          if (!refreshTasks && old?.delegatedSessionIds !== undefined && old.sessionId === bot.sessionId) continue;
          try {
            const tasks = await window.electronAPI.deviceLink.invoke(
              deviceId, 'maker:bot-delegations:list', [bot.sessionId],
            );
            if (!current() || generations.get(deviceId) !== epoch) return;
            const created = remoteBotCreatedTaskIds(tasks, bot.id);
            if (created === null) continue;
            publish(snapshot.map(row => row.deviceId === deviceId && row.id === bot.id
              ? { ...row, delegatedSessionIds: created } : row));
          } catch { /* Keep this host's last known attribution on a temporary read failure. */ }
        }
        if (current() && generations.get(deviceId) === epoch) taskRefreshes.delete(deviceId);
      } catch {
        if (!current() || generations.get(deviceId) !== epoch) return;
        // Keep connection evidence and cached identity. An unsupported/failed
        // resource read does not mean the device disconnected.
        publish(snapshot.map(bot => bot.deviceId === deviceId ? { ...bot, generation: undefined } : bot));
      }
    }
    // The app's existing remote-session synchronizer owns the sessions topic.
    // Sharing its pushes avoids competing subscribe/unsubscribe owners.
    // Subscribe before reading status: a stopped/connecting relay cannot inherit
    // a stale device directory's online flag, and a late GET cannot undo a push.
    const offPush = window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
      if (
        !current() ||
        (push.channel !== REMOTE_RESOURCE_CHANGED_CHANNEL && push.channel !== 'maker:bot-delegation:changed') ||
        !byId.has(push.deviceId) ||
        !isDeviceLinkRemotePushCurrent(push, stamp)
      )
        return;
      if (push.channel === 'maker:bot-delegation:changed') taskRefreshes.add(push.deviceId);
      if (timers.has(push.deviceId)) return;
      timers.set(
        push.deviceId,
        setTimeout(() => {
          timers.delete(push.deviceId);
          const refreshTasks = taskRefreshes.has(push.deviceId);
          void refresh(push.deviceId, refreshTasks);
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
          snapshot.map((bot) => ({ ...bot, online: false, connectionKnown: state.status === 'stopped' || !byId.get(bot.deviceId)?.online, generation: undefined })),
        );
      }
    });
    const revision = statusRevision;
    void window.electronAPI.deviceLink.getState().then((state) => {
      if (!current() || revision !== statusRevision) return;
      relayAvailable = state.linkStatus === 'online';
      if (relayAvailable) {
        for (const host of hosts) if (host.online) void refresh(host.deviceId);
      } else publish(snapshot.map((bot) => ({ ...bot, online: false, connectionKnown: state.linkStatus === 'stopped' || !byId.get(bot.deviceId)?.online, generation: undefined })));
    }).catch(() => {
      if (current() && revision === statusRevision) publish(snapshot.map((bot) => ({ ...bot, online: false, connectionKnown: false, generation: undefined })));
    });
    return () => {
      disposed = true;
      offPush();
      offStatus();
      timers.forEach(clearTimeout);
    };
  }, [dataOwnerId, isAuthenticated, devices, revoked]);
  useEffect(() => {
    const api = companionCloudApi();
    const requestOwner = isAuthenticated ? dataOwnerId : null;
    if (!requestOwner || !cloud.enabled || !api?.listCindyCopies) return;
    let live = true;
    void api.listCindyCopies().then(copies => {
      if (!live || owner !== requestOwner) return;
      cindyIds = new Set(copies.map(copy => copy.botId));
      publish(snapshot);
    }).catch(() => { /* Cached template identity remains usable offline. */ });
    return () => { live = false; };
  }, [dataOwnerId, isAuthenticated, cloud.enabled, actorsKey]);

}

export function markRemoteBotRead(deviceId: string, botId: string, at: number): void {
  if (!Number.isFinite(at) || at < 0) return;
  if (!snapshot.some((bot) => bot.deviceId === deviceId && bot.id === botId && (bot.readAt ?? -1) < at)) return;
  // Read positions must survive even if the main window has not discovered
  // this companion yet. Store only identities/positions, never another roster.
  if (owner) {
    try {
      persistReadPosition(owner, deviceId, botId, at);
    } catch { /* Keep the current window readable when storage is unavailable. */ }
  }
  publish(snapshot.map((bot) => bot.deviceId === deviceId && bot.id === botId ? { ...bot, readAt: Math.max(bot.readAt ?? 0, at) } : bot));
}
