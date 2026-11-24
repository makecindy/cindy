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
import { parseRemoteBots, parseTeammateInboxSnooze, remoteBotCreatedTaskIds, type RemoteBot } from './remoteBotRoster';

const CACHE_PREFIX = 'cindy.remoteBots.v1.';
let owner: string | null = null;
let snapshot: RemoteBot[] = [];
let cindyIds = new Set<string>();
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

/** Each complete app window mirrors the roster; only the main window writes the display cache. */
export function useRemoteBotSync(): void {
  const { dataOwnerId, isAuthenticated } = useAuth();
  const devices = useDeviceLinkDeviceList();
  const cloud = useCompanionCloud();
  const dataOwner = getDataOwnerGeneration();
  const actorsKey = cloud.actors.map(actor => `${actor.externalId}:${actor.homeDeviceId ?? ''}`).join(',');
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
      unreportedReads.clear();
      inFlightReads.clear();
      legacyDelegationHosts.clear();
      delegationRetryAt.clear();
      restoredAttribution.clear();
      restoredCheckAt.clear();
      let cached: RemoteBot[] = [];
      try {
        if (!nextOwner) {
          // Signing out clears this mirror, not other accounts' migration sources.
        } else {
          const raw = window.localStorage.getItem(CACHE_PREFIX + nextOwner);
          if (raw && raw.length <= 256 * 1024) {
            const rows = JSON.parse(raw);
            if (Array.isArray(rows)) cached = rows.filter((bot) => bot && ['id', 'deviceId', 'deviceName', 'name', 'avatar', 'avatarColor', 'description', 'preview'].every((key) => typeof bot[key] === 'string') && Number.isFinite(bot.activityAt)).map((bot) => ({
              id: bot.id, deviceId: bot.deviceId, deviceName: bot.deviceName, name: bot.name,
              templateId: typeof bot.templateId === 'string' ? bot.templateId : undefined,
              avatar: bot.avatar, avatarColor: bot.avatarColor, description: bot.description, preview: bot.preview,
              followingSessionIds: Array.isArray(bot.followingSessionIds) ? bot.followingSessionIds.filter((id: unknown) => typeof id === 'string') : [],
              // Missing means never read: that teammate's attribution is still fetched once.
              delegatedSessionIds: Array.isArray(bot.delegatedSessionIds) ? bot.delegatedSessionIds.filter((id: unknown) => typeof id === 'string') : undefined,
              activityAt: bot.activityAt, sessionId: typeof bot.sessionId === 'string' ? bot.sessionId : null,
              lastReplyAt: Number.isFinite(bot.lastReplyAt) ? bot.lastReplyAt : undefined,
              // A snoozed teammate stays snoozed while its computer is offline.
              ...(parseTeammateInboxSnooze(bot.inboxSnooze) ? { inboxSnooze: parseTeammateInboxSnooze(bot.inboxSnooze) } : {}),
              online: false, connectionKnown: false,
            }));
          }
        }
      } catch { /* missing/corrupt cache */ }
      for (const bot of cached) if (bot.delegatedSessionIds !== undefined) restoredAttribution.add(`${bot.deviceId}\n${bot.id}`);
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
    const restoredCheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const taskRefreshes = new Set<string>();
    const current = () => !disposed && owner === nextOwner && isDataOwnerGenerationCurrent(dataOwner);
    async function refresh(deviceId: string, refreshTasks = false) {
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
        const bots = parseRemoteBots(result, deviceId, host.name).map((bot) => ({
          ...bot,
          delegatedSessionIds: previous.get(bot.id)?.delegatedSessionIds,
          templateId: previous.get(bot.id)?.templateId,
          // Reading on the phone or the home computer counts here too; newest position wins.
          readAt: Math.max(snapshot.find((old) => old.deviceId === deviceId && old.id === bot.id)?.readAt ?? bot.lastReplyAt ?? 0, bot.hostReadAt ?? 0),
        }));
        for (const bot of bots) {
          seedRemoteBotReadState(deviceId, bot.id, bot.lastReplyAt ?? 0);
          if (bot.hostReadAt !== undefined) acknowledgeRemoteBotRead(deviceId, bot.id, bot.hostReadAt);
        }
        publish([...snapshot.filter((bot) => bot.deviceId !== deviceId), ...bots]);
        flushUnreportedReads(deviceId, bots);
        // Every host answers the V1 task-card list (newer ones read-only from stored rows):
        // the children a teammate started there keep their "opened by" mark. Read serially
        // per host; never per task row. Stored rows no longer change, so an ordinary refresh
        // only reads a teammate whose attribution is unknown or whose main chat changed. A failed
        // read stays unconfirmed (its retry entry) until one succeeds, even though the row already
        // carries the new main chat next to the previous attribution. Teammates whose read failed
        // go last, so one that keeps stalling cannot stop the round before the others are read.
        const retryKeyOf = (bot: RemoteBot) => `${deviceId}\n${bot.id}\n${bot.sessionId}`;
        // Attribution restored from disk may be stale: an older host can add V1 tasks while this
        // app is closed, with no push to tell it. Check it once per sign-in, a while after the
        // host first answers so the startup burst is not joined, through the same serial reads
        // and backoff. Ordinary refreshes before that keep using the cache.
        const restoredKeyOf = (bot: RemoteBot) => `${deviceId}\n${bot.id}`;
        if (bots.some(bot => restoredAttribution.has(restoredKeyOf(bot)))) {
          if (!restoredCheckAt.has(deviceId)) restoredCheckAt.set(deviceId, Date.now() + RESTORED_CHECK_DELAY_MS);
          const wait = restoredCheckAt.get(deviceId)! - Date.now();
          if (wait > 0 && !restoredCheckTimers.has(deviceId)) {
            restoredCheckTimers.set(deviceId, setTimeout(() => {
              restoredCheckTimers.delete(deviceId);
              void refresh(deviceId);
            }, wait));
          }
        }
        const restoredDue = Date.now() >= (restoredCheckAt.get(deviceId) ?? Infinity);
        const readOrder = [...bots.filter(bot => !delegationRetryAt.has(retryKeyOf(bot))),
          ...bots.filter(bot => delegationRetryAt.has(retryKeyOf(bot)))];
        for (const bot of readOrder) {
          if (!current() || generations.get(deviceId) !== epoch) return;
          if (!bot.sessionId) continue;
          const old = previous.get(bot.id);
          const retryKey = retryKeyOf(bot);
          if (!refreshTasks && ((old?.delegatedSessionIds !== undefined && old.sessionId === bot.sessionId && !delegationRetryAt.has(retryKey)
            && !(restoredDue && restoredAttribution.has(restoredKeyOf(bot))))
            || Math.max(delegationRetryAt.get(retryKey) ?? 0, delegationRetryAt.get(deviceId) ?? 0) > Date.now())) continue;
          try {
            const tasks = await readLegacyDelegations(deviceId, bot.sessionId);
            if (!current() || generations.get(deviceId) !== epoch) return;
            const created = remoteBotCreatedTaskIds(tasks, bot.id);
            if (created === null) { delegationRetryAt.set(retryKey, Date.now() + DELEGATION_RETRY_MS); continue; }
            delegationRetryAt.delete(retryKey);
            restoredAttribution.delete(restoredKeyOf(bot));
            publish(snapshot.map(row => row.deviceId === deviceId && row.id === bot.id
              ? { ...row, delegatedSessionIds: created } : row));
          } catch (error) {
            // Keep this host's last known attribution on a temporary read failure. A superseded
            // round must not pause the round that replaced it.
            if (!current() || generations.get(deviceId) !== epoch) return;
            delegationRetryAt.set(retryKey, Date.now() + DELEGATION_RETRY_MS);
            // The host still holds that request until its invoke budget ends: do not queue the next
            // teammate behind it. Later rounds read the others before retrying this one.
            if (error === DELEGATION_READ_TIMEOUT) {
              delegationRetryAt.set(deviceId, Date.now() + DELEGATION_HOST_PAUSE_MS);
              // A forced re-read cut short: the teammates it skipped stay unconfirmed, so an ordinary
              // refresh after the pause still reads them instead of trusting their cached marks.
              if (refreshTasks) for (const rest of readOrder.slice(readOrder.indexOf(bot) + 1)) {
                if (rest.sessionId && !delegationRetryAt.has(retryKeyOf(rest))) delegationRetryAt.set(retryKeyOf(rest), 0);
              }
              break;
            }
          }
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
    // newer hosts never do. Either way it only refreshes this host's created-task marks;
    // a host seen pushing it also re-reads them on reconnect, catching pushes missed offline.
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
      if (push.channel === 'maker:bot-delegation:changed') {
        taskRefreshes.add(push.deviceId);
        legacyDelegationHosts.add(push.deviceId);
      }
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
        for (const host of hosts) if (host.online) void refresh(host.deviceId, legacyDelegationHosts.has(host.deviceId));
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
        for (const host of hosts) if (host.online) void refresh(host.deviceId, legacyDelegationHosts.has(host.deviceId));
      } else publish(snapshot.map((bot) => ({ ...bot, online: false, connectionKnown: state.linkStatus === 'stopped' || !byId.get(bot.deviceId)?.online, generation: undefined })));
    }).catch(() => {
      if (current() && revision === statusRevision) publish(snapshot.map((bot) => ({ ...bot, online: false, connectionKnown: false, generation: undefined })));
    });
    return () => {
      disposed = true;
      offPush();
      offStatus();
      timers.forEach(clearTimeout);
      restoredCheckTimers.forEach(clearTimeout);
    };
  }, [dataOwnerId, isAuthenticated, devices, revoked, dataOwner]);
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

/** Hosts seen pushing `maker:bot-delegation:changed` (still running V1 tasks) since sign-in. */
const legacyDelegationHosts = new Set<string>();
/**
 * When an ordinary refresh may retry a failed attribution read: `deviceId\nbotId\nsessionId` after
 * a failure, or `deviceId` (the whole host) after a stalled read. Pushes and re-reads bypass it.
 * A per-teammate entry also marks that attribution unconfirmed until a read succeeds.
 */
const delegationRetryAt = new Map<string, number>();
const DELEGATION_READ_TIMEOUT_MS = 10_000;
const DELEGATION_RETRY_MS = 5 * 60_000;
/** The default 30 s invoke budget: an abandoned read can hold the host's slot that long. */
const DELEGATION_HOST_PAUSE_MS = 30_000;
/** `deviceId\nbotId` whose attribution came from the display cache and is not confirmed since sign-in. */
const restoredAttribution = new Set<string>();
/** Per host: when this sign-in's one delayed check of restored attribution becomes due. */
const restoredCheckAt = new Map<string, number>();
/** Past the startup burst of roster, session and status reads. */
const RESTORED_CHECK_DELAY_MS = 60_000;
const DELEGATION_READ_TIMEOUT = new Error('legacy delegation read timed out');

/**
 * The legacy task-card list is static on current hosts; stop waiting before the 30 s invoke budget
 * so a stalled host does not hold the roster refresh. The request itself is not cancelled.
 */
function readLegacyDelegations(deviceId: string, sessionId: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    window.electronAPI.deviceLink.invoke(deviceId, 'maker:bot-delegations:list', [sessionId]),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(DELEGATION_READ_TIMEOUT), DELEGATION_READ_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

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
