import { useEffect, useSyncExternalStore } from 'react';
import {
  REMOTE_RESOURCE_CHANGED_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  REMOTE_RESOURCE_LIST_CHANNEL,
  type RemoteCollectionListRequest,
} from '@cindy/device-link';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { acknowledgeRemoteBotRead, getBotReadStateSyncStatus, getRemoteBotReadAt, seedRemoteBotReadState, subscribeBotReadState } from './botReadState';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { useCompanionCloud, companionCloudApi } from './companionCloudStore';
import { cloudRemoteBotVisibilityKey } from './companionCloudPresentation';
import { parseRemoteBots, parseTeammateInboxSnooze, remoteBotCreatedTaskIds, type RemoteBot } from './remoteBotRoster';

const CACHE_PREFIX = 'cindy.remoteBots.v1.';
const OMISSIONS_CACHE_PREFIX = 'cindy.remoteBotOmissions.v2.';
const ROSTER_LIMIT = 200;
let owner: string | null = null;
let snapshot: RemoteBot[] = [];
let cindyIds = new Set<string>();
let omissions: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const publish = (next: RemoteBot[]) => {
  next = next.map(bot => cindyIds.has(bot.id) ? { ...bot, templateId: 'cindy' } : bot);
  // A projection lookup is in memory. Never scan localStorage for each delegation result.
  snapshot = next.map(bot => ({ ...bot, readAt: getRemoteBotReadAt(bot.deviceId, bot.id) }));
  const readStatus = getBotReadStateSyncStatus();
  if (owner && !isSecondaryWindow() && readStatus.phase === 'ready'
    && !readStatus.corruptSources.includes(CACHE_PREFIX + owner)) {
    // Display cache has no read authority: omitting readAt also prevents re-importing new seeds as legacy acks.
    try { const value = JSON.stringify(snapshot.map(bot => {
      const cached = { ...bot, online: false };
      delete cached.readAt;
      return cached;
    }));
      if (value.length <= 256 * 1024) window.localStorage.setItem(CACHE_PREFIX + owner, value);
      const missing = JSON.stringify([...omissions]);
      if (missing.length <= 256 * 1024) window.localStorage.setItem(OMISSIONS_CACHE_PREFIX + owner, missing);
      else window.localStorage.removeItem(OMISSIONS_CACHE_PREFIX + owner);
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

/** Account-, actor- and home-qualified display evidence, never a permission or deletion. */
export function useRemoteBotOmissions(): ReadonlySet<string> {
  const { dataOwnerId, isAuthenticated } = useAuth();
  const missing = useSyncExternalStore(subscribe, () => omissions);
  return isAuthenticated && owner === dataOwnerId ? missing : EMPTY_CINDY_IDS;
}

/** Each complete app window mirrors the roster; only the main window writes the display cache. */
export function useRemoteBotSync(): void {
  const { dataOwnerId, isAuthenticated } = useAuth();
  const devices = useDeviceLinkDeviceList();
  const cloud = useCompanionCloud();
  const dataOwner = getDataOwnerGeneration();
  const actorsKey = cloud.actors.map(cloudRemoteBotVisibilityKey).join(',');
  useEffect(() => subscribeBotReadState(() => {
    if (owner === dataOwnerId && isDataOwnerGenerationCurrent(dataOwner)) publish(snapshot);
  }), [dataOwnerId, dataOwner]);
  const revoked = useSyncExternalStore(
    revokedDevicesStore.subscribe,
    revokedDevicesStore.getSnapshot,
  );
  useEffect(() => {
    const nextOwner = isAuthenticated ? (dataOwnerId ?? null) : null;
    if (owner !== nextOwner) {
      owner = nextOwner;
      cindyIds = new Set();
      omissions = new Set();
      unreportedReads.clear();
      inFlightReads.clear();
      let cached: RemoteBot[] = [];
      try {
        if (!nextOwner) {
          // Signing out clears this mirror, not other accounts' migration sources.
        } else {
          const missing = window.localStorage.getItem(OMISSIONS_CACHE_PREFIX + nextOwner);
          if (missing && missing.length <= 256 * 1024) {
            try {
              const keys: unknown = JSON.parse(missing);
              if (Array.isArray(keys)) omissions = new Set(keys.filter((key): key is string => {
                if (typeof key !== 'string') return false;
                try { const parts: unknown = JSON.parse(key); return Array.isArray(parts) && parts.length === 3
                  && parts.every(part => typeof part === 'string' && part.length > 0 && part.length <= 256); }
                catch { return false; }
              }));
            } catch { /* A damaged omission cache must not discard usable roster rows. */ }
          }
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
              // A snoozed teammate stays snoozed while its computer is offline.
              ...(parseTeammateInboxSnooze(bot.inboxSnooze) ? { inboxSnooze: parseTeammateInboxSnooze(bot.inboxSnooze) } : {}),
              online: false, connectionKnown: false,
            }));
          }
        }
      } catch { /* missing/corrupt cache */ }
      publish(cached);
    }
    if (!nextOwner) return;
    if (cloud.enabled) {
      const keys = new Set(cloud.actors.map(cloudRemoteBotVisibilityKey));
      omissions = new Set([...omissions].filter(key => keys.has(key)));
    }
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
    const current = () => !disposed && owner === nextOwner && isDataOwnerGenerationCurrent(dataOwner);
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
          limit: ROSTER_LIMIT,
        };
        const result = await window.electronAPI.deviceLink.invoke(
          deviceId,
          REMOTE_RESOURCE_LIST_CHANNEL,
          [request],
        );
        if (!current() || generations.get(deviceId) !== epoch) return;
        const previous = new Map(snapshot.filter(bot => bot.deviceId === deviceId).map(bot => [bot.id, bot]));
        const bots = parseRemoteBots(result, deviceId, host.name).map((bot) => ({
          ...bot,
          delegatedSessionIds: previous.get(bot.id)?.delegatedSessionIds,
          templateId: previous.get(bot.id)?.templateId,
          // Reading on the phone or the home computer counts here too; newest position wins.
          readAt: Math.max(snapshot.find((old) => old.deviceId === deviceId && old.id === bot.id)?.readAt ?? bot.lastReplyAt ?? 0, bot.hostReadAt ?? 0),
        }));
        const missing = new Set(omissions);
        const response = result as { items: unknown[]; nextCursor?: unknown; teammateRecovery?: unknown };
        const evidence = response.teammateRecovery as { version?: unknown; recoveringIds?: unknown } | undefined;
        const validEvidence = evidence && evidence.version === 1 && Array.isArray(evidence.recoveringIds)
          && evidence.recoveringIds.length <= 200 && evidence.recoveringIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256);
        const listed = new Set(bots.map(bot => bot.id));
        const complete = response.items.length < ROSTER_LIMIT && response.nextCursor === undefined;
        for (const actor of cloud.actors) {
          if (actor.homeDeviceId !== deviceId) continue;
          const key = cloudRemoteBotVisibilityKey(actor);
          if (listed.has(actor.externalId)) missing.delete(key);
          else if (complete) {
            // Old/unknown evidence cannot rule out a failed initial restoration. Drop
            // this host's old inference rather than persisting it over that uncertainty.
            if (!validEvidence || (evidence.recoveringIds as string[]).includes(actor.externalId)) missing.delete(key);
            else missing.add(key);
          }
        }
        omissions = missing;
        for (const bot of bots) {
          seedRemoteBotReadState(deviceId, bot.id, bot.lastReplyAt ?? 0);
          if (bot.hostReadAt !== undefined) acknowledgeRemoteBotRead(deviceId, bot.id, bot.hostReadAt);
        }
        publish([...snapshot.filter((bot) => bot.deviceId !== deviceId), ...bots]);
        flushUnreportedReads(deviceId, bots);
        // Every host answers the V1 task-card list (newer ones read-only from stored rows):
        // the children a teammate started there keep their "opened by" mark. Read serially
        // per host; never per task row.
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
    // Older hosts still run V1 background tasks and push `maker:bot-delegation:changed`;
    // newer hosts never do. Either way it only refreshes this host's created-task marks.
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
  }, [dataOwnerId, isAuthenticated, devices, revoked, dataOwner, actorsKey, cloud.enabled]);
  useEffect(() => {
    const api = companionCloudApi();
    const requestOwner = isAuthenticated ? dataOwnerId : null;
    if (!requestOwner || !cloud.enabled || !api?.listCindyCopies) return;
    let live = true;
    void api.listCindyCopies().then(copies => {
      if (!live || owner !== requestOwner || !isDataOwnerGenerationCurrent(dataOwner)) return;
      cindyIds = new Set(copies.map(copy => copy.botId));
      publish(snapshot);
    }).catch(() => { /* Cached template identity remains usable offline. */ });
    return () => { live = false; };
  }, [dataOwnerId, isAuthenticated, cloud.enabled, actorsKey, dataOwner]);

}

/**
 * Read positions this window advanced that the home computer has not acknowledged yet, by
 * `deviceId\nbotId`. Kept apart from the local `readAt`: advancing locally must not decide
 * whether the computer still needs to hear about it (offline, a failed request, a restart of
 * the link), so an unacknowledged position is re-sent on the next read and on reconnect.
 */
const unreportedReads = new Map<string, number>();
const inFlightReads = new Map<string, number>();
let readReportOwner = getDataOwnerGeneration();
function settleReadReportOwner(): void {
  const next = getDataOwnerGeneration();
  if (isDataOwnerGenerationCurrent(readReportOwner)) return;
  inFlightReads.clear();
  if (next.dataOwnerId !== readReportOwner.dataOwnerId) unreportedReads.clear();
  readReportOwner = next;
}
const readReportKey = (deviceId: string, botId: string) => `${deviceId}\n${botId}`;

function sendRemoteBotRead(deviceId: string, botId: string, at: number): void {
  settleReadReportOwner();
  const requestOwner = getDataOwnerGeneration();
  const key = readReportKey(deviceId, botId);
  if ((inFlightReads.get(key) ?? 0) >= at) return;
  inFlightReads.set(key, at);
  void window.electronAPI.deviceLink.invoke(deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, [{
    client: { protocolVersion: 1, primitives: [] },
    collectionId: 'teammates',
    actionId: 'read',
    resourceRef: { collectionId: 'teammates', kind: 'bot', id: botId },
    input: { at: Math.floor(at) },
  }]).then(() => {
    if (!isDataOwnerGenerationCurrent(requestOwner)) return;
    if ((unreportedReads.get(key) ?? 0) <= at) unreportedReads.delete(key);
  }, () => undefined).finally(() => {
    if (!isDataOwnerGenerationCurrent(requestOwner)) return;
    if (inFlightReads.get(key) === at) inFlightReads.delete(key);
  });
}

/**
 * After a successful roster read: send positions the computer is still missing, and forget the
 * ones it already has (another device read further) or cannot take (older host, deleted teammate).
 */
function flushUnreportedReads(deviceId: string, bots: readonly RemoteBot[]): void {
  settleReadReportOwner();
  const byId = new Map(bots.map(bot => [bot.id, bot]));
  for (const [key, at] of [...unreportedReads]) {
    const [keyDevice, botId] = key.split('\n');
    if (keyDevice !== deviceId) continue;
    const bot = byId.get(botId);
    if (!bot || bot.hostReadAt === undefined || bot.hostReadAt >= at) unreportedReads.delete(key);
    else sendRemoteBotRead(deviceId, botId, at);
  }
}

export function markRemoteBotRead(deviceId: string, botId: string, at: number): void {
  settleReadReportOwner();
  if (!Number.isFinite(at) || at <= 0) return;
  const bot = snapshot.find((bot) => bot.deviceId === deviceId && bot.id === botId);
  if (!bot) return;
  acknowledgeRemoteBotRead(deviceId, botId, at);
  // Hosts that publish their read position accept `read`. Every call re-checks what the computer
  // has, so showing the same reply again after a failed or offline report sends it again.
  if (bot.hostReadAt !== undefined && bot.hostReadAt >= at) return;
  const key = readReportKey(deviceId, botId);
  unreportedReads.set(key, Math.max(unreportedReads.get(key) ?? 0, at));
  // Without a live list (offline, restored from cache) the position waits for the next refresh.
  if (bot.hostReadAt !== undefined && bot.online) sendRemoteBotRead(deviceId, botId, at);
}
