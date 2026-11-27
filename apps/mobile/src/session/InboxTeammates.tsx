/**
 * Teammates in the phone's inbox (docs/product-rules/task-inbox.md, 2026-11-20 user decision):
 * each teammate's main conversation is one row, placed by whose turn it is. Pending while it waits
 * for the user, failed or has an unread reply; Working while it runs; Snoozed until its wake time;
 * left out while idle and read (the teammate section above the list still lists everyone).
 *
 * Done only marks the conversation read through the existing teammate read path; Snooze writes the
 * conversation Session's own snooze on the teammate's computer. Nothing is archived or stored here.
 *
 * The home screen keeps the classification (`useInboxTeammates`); the rows read the live roster
 * through a context so the list's renderItem stays stable while a row's content changes.
 */
import { createContext, memo, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { Alert, Keyboard } from 'react-native';
import { useTranslation } from 'react-i18next';
import { taskSnoozeUntil, type TaskInboxSection } from '@cindy/maker-shared/live-task-priority';
import { projectTeammateSnoozeWithOfflineInboxIntent } from '@cindy/maker-shared/offline-inbox-intent';
import { useAuth } from '@/auth/AuthContext';
import { CLOUD_ROW_REVISION, cloudActorForRow, cloudCompanionRows } from '@/chat/cloudCompanion';
import type { useCloudCompanionHome } from '@/chat/useCloudCompanion';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import {
  getMobileOfflineInboxIntent,
  isOfflineInboxTransientError,
  queueMobileOfflineInboxSnooze,
  useMobileOfflineInboxIntentsRevision,
} from './offlineInboxIntents';
import { isRemoteResourceUnread, markRemoteResourceRead, subscribeRemoteResourceCache } from '@/device-link/remoteResourceCache';
import { invokeRemoteResourceAction, type HostedRemoteCollectionItem, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import type { useGuardedPush } from '@/utils/useGuardedPush';
import { useStableValue } from '@/utils/useStableValue';
import type { InboxTeammateEntry } from './homeSections';
import type { useHomeTeammatesSectionContext } from './HomeTeammatesSection';
import { MountOnFirstOpen } from './MountOnFirstOpen';
import { SwipeableSessionRow } from './SwipeableSessionRow';
import type { SwipeRowRegistry } from './swipeRowRegistry';
import { TaskSnoozeSheet } from './TaskSnoozeSheet';
import { conversationSessionId, teammateRowState, useTeammateRowRenderer, type TeammateRowActions } from './TeammateList';
import { cloudCompanionRoute, orderedTeammates } from './teammateNavigation';
import type { RemoteSession } from './types';
import { useRosterActivities } from './useTeammateStatus';
import { useTeammateNavigation } from './useTeammateNavigation';

const NO_ROWS: HostedRemoteCollectionItem[] = [];
const NO_ENTRIES: InboxTeammateEntry[] = [];
const noop = () => undefined;

type Snooze = NonNullable<HostedRemoteCollectionItem['item']['display']['inboxSnooze']>;

/** A snooze this phone just wrote, shown until the teammate's roster row is re-read. */
interface PendingSnooze { revision: string; snooze: Snooze }

interface InboxTeammatesValue {
  rows: ReadonlyMap<string, HostedRemoteCollectionItem>;
  items: readonly HostedRemoteCollectionItem[];
  activities: ReadonlyMap<string, string>;
  entries: ReadonlyMap<string, InboxTeammateEntry>;
  registry: SwipeRowRegistry;
  isOnline(host: RemoteResourceHostTarget): boolean;
  connectionState?(host: RemoteResourceHostTarget): boolean | null;
  quietPresence(row: HostedRemoteCollectionItem): boolean;
  open(row: HostedRemoteCollectionItem): void;
  /** Opens the snooze sheet, or wakes a snoozed conversation. */
  snooze(key: string): void;
  complete(key: string): void;
}

const InboxTeammatesContext = createContext<InboxTeammatesValue | null>(null);
/** Wraps the home list; the rows may be drawn outside the route (Android's resident home list). */
export const InboxTeammatesProvider = InboxTeammatesContext.Provider;

function sameEntries(a: readonly InboxTeammateEntry[], b: readonly InboxTeammateEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => {
    const other = b[index];
    return entry.key === other.key && entry.status === other.status && entry.activityAt === other.activityAt
      && entry.snooze?.snoozedUntil === other.snooze?.snoozedUntil && entry.snooze?.snoozedAt === other.snooze?.snoozedAt
      && entry.snooze?.userSendAt === other.snooze?.userSendAt && entry.pendingSync === other.pendingSync;
  });
}

/** The earliest wake time after `nowMs` among the listed teammates; Infinity when none is due. */
export function nextInboxTeammateWake(entries: readonly InboxTeammateEntry[], nowMs: number): number {
  return Math.min(Infinity, ...entries.map(entry => taskSnoozeUntil(entry.snooze ?? {})).filter(at => at > nowMs));
}

/** Which inbox actions a teammate row offers in its section (none: the row does not swipe). */
export function inboxTeammateActions(entry: InboxTeammateEntry, section: TaskInboxSection): { snooze: boolean; complete: boolean } | null {
  // Reading cannot dismiss a pending question or a failure, and a running reply is not done yet.
  const complete = section === 'inbox' && (entry.status === 'done' || entry.status === 'unread');
  // Only a host that publishes the conversation's snooze accepts one.
  const snooze = entry.snooze !== null && section !== 'archived';
  return snooze || complete ? { snooze, complete } : null;
}

/**
 * Classifies the roster for the inbox and owns the row actions. `enabled` is false outside inbox
 * mode and wherever the teammate section itself is hidden (content filters, archived view).
 */
export function useInboxTeammates({ context, cloud, enabled, query, push: hostPush, registry }: {
  context: ReturnType<typeof useHomeTeammatesSectionContext>;
  cloud: ReturnType<typeof useCloudCompanionHome>;
  enabled: boolean;
  query: string;
  push: ReturnType<typeof useGuardedPush>;
  registry: SwipeRowRegistry;
}) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { invoke } = useDeviceLink();
  const userId = user?.id ?? '';
  const roster = context.shared?.roster;
  const navigation = useTeammateNavigation(hostPush);
  const rosterItems = roster?.items ?? NO_ROWS;
  // One row per companion, as in the teammate section (cloud-companions.md).
  const items = useMemo(() => !enabled ? NO_ROWS
    : cloud.supported ? cloudCompanionRows(rosterItems, cloud.actors, cloud.deviceNames) : rosterItems,
  [enabled, cloud.supported, cloud.actors, cloud.deviceNames, rosterItems]);
  const listed = useMemo(() => orderedTeammates(items, query.trim(), i18n.language), [items, query, i18n.language]);
  const activities = useRosterActivities(listed);
  // Only an unread flag flipping re-renders the home, not every cache write.
  const unreadSnapshot = useCallback(() => listed.map(row =>
    isRemoteResourceUnread(userId, row.host.deviceId, row.item.ref.id, row.item.display.lastReplyAt) ? '1' : '0').join(''), [listed, userId]);
  useSyncExternalStore(subscribeRemoteResourceCache, unreadSnapshot, unreadSnapshot);
  const offlineInboxRevision = useMobileOfflineInboxIntentsRevision();
  void offlineInboxRevision;
  const [pending, setPending] = useState<ReadonlyMap<string, PendingSnooze>>(() => new Map());
  const isOnline = roster?.isOnline;
  const connectionState = roster?.connectionState;
  const entries = useStableValue(!listed.length || !isOnline ? NO_ENTRIES : listed.map((row): InboxTeammateEntry => {
    const online = isOnline(row.host);
    const { status } = teammateRowState(row, { online, connected: connectionState ? connectionState(row.host) : online,
      quiet: true, activities, userId, language: i18n.language });
    const local = pending.get(row.key);
    const baseSnooze = (local?.revision === row.item.revision ? local.snooze : row.item.display.inboxSnooze) ?? null;
    const sessionId = conversationSessionId(row);
    const offlineIntent = sessionId ? getMobileOfflineInboxIntent(row.host.deviceId, sessionId) : undefined;
    const snooze = sessionId
      ? projectTeammateSnoozeWithOfflineInboxIntent(baseSnooze, offlineIntent)
      : baseSnooze;
    return {
      key: row.key,
      status,
      activityAt: row.item.display.timestamp ?? 0,
      snooze,
      ...(offlineIntent?.kind === 'snooze' ? { pendingSync: true } : {}),
    };
  }), sameEntries);

  const latest = useRef({ listed, entries, userId, language: i18n.language });
  latest.current = { listed, entries, userId, language: i18n.language };
  const find = useCallback((key: string) => {
    const row = latest.current.listed.find(item => item.key === key);
    const entry = latest.current.entries.find(item => item.key === key);
    return row && entry ? { row, entry } : null;
  }, []);

  const writeSnooze = useCallback(async (key: string, until: string | null) => {
    const found = find(key);
    const sessionId = found ? conversationSessionId(found.row) : null;
    if (!found || !sessionId || !found.entry.snooze) throw new Error('UNSUPPORTED_CAPABILITY');
    const { row } = found;
    const hostSnooze = row.item.display.inboxSnooze;
    const hostOffline = isOnline ? !isOnline(row.host) : false;
    if (hostOffline) {
      await queueMobileOfflineInboxSnooze(
        latest.current.userId,
        row.host.deviceId,
        sessionId,
        {
          snoozedUntil: hostSnooze?.snoozedUntil ?? null,
          snoozedAt: hostSnooze?.snoozedAt ?? null,
          userSendAt: hostSnooze?.userSendAt ?? null,
          title: typeof row.item.display.title === 'string' ? row.item.display.title : null,
          deviceLinkDeviceName: row.host.deviceName,
        },
        until,
      );
      return;
    }
    const revision = row.item.revision;
    const show = (snooze: Snooze | null) => setPending(previous => {
      const next = new Map(previous);
      if (snooze) next.set(key, { revision, snooze }); else next.delete(key);
      return next;
    });
    show({ snoozedUntil: until, snoozedAt: until === null ? null : new Date().toISOString(), userSendAt: found.entry.snooze.userSendAt ?? null });
    try {
      const updated = await invoke<Partial<RemoteSession> | null>(row.host.deviceId, 'local-db:sessions:patch-meta', [sessionId, { snoozedUntil: until }]);
      // An older host ignores the field: never show a snooze it did not keep.
      if ((updated?.snoozedUntil ?? null) !== until) throw new Error('UNSUPPORTED_CAPABILITY');
      show({ snoozedUntil: until, snoozedAt: updated?.snoozedAt ?? null, userSendAt: updated?.userSendAt ?? null });
    } catch (error) {
      show(null);
      if (isOfflineInboxTransientError(error)) {
        await queueMobileOfflineInboxSnooze(
          latest.current.userId,
          row.host.deviceId,
          sessionId,
          {
            snoozedUntil: hostSnooze?.snoozedUntil ?? null,
            snoozedAt: hostSnooze?.snoozedAt ?? null,
            userSendAt: hostSnooze?.userSendAt ?? null,
            title: typeof row.item.display.title === 'string' ? row.item.display.title : null,
            deviceLinkDeviceName: row.host.deviceName,
          },
          until,
        );
        return;
      }
      throw error;
    }
  }, [find, invoke, isOnline]);
  const reportSnoozeFailure = useCallback(() => {
    Alert.alert(t('devices.list.alert.actionFailed'), t('devices.list.menu.inbox.snoozeFailed'));
  }, [t]);

  const [snoozeTarget, setSnoozeTarget] = useState<string | null>(null);
  const afterSheet = useRef<(() => void) | null>(null);
  const snooze = useCallback((key: string) => {
    registry.closeOpenRow();
    const found = find(key);
    if (!found?.entry.snooze) return;
    if (taskSnoozeUntil(found.entry.snooze) > Date.now()) void writeSnooze(key, null).catch(reportSnoozeFailure);
    else setSnoozeTarget(key);
  }, [find, registry, reportSnoozeFailure, writeSnooze]);
  const confirmSnooze = useCallback((until: string) => {
    const key = snoozeTarget;
    if (!key) return;
    setSnoozeTarget(null);
    // Present any save error only after the native sheet has finished dismissing.
    afterSheet.current = () => { void writeSnooze(key, until).catch(reportSnoozeFailure); };
  }, [reportSnoozeFailure, snoozeTarget, writeSnooze]);
  const closeSnooze = useCallback(() => setSnoozeTarget(null), []);
  const snoozeClosed = useCallback(() => {
    const run = afterSheet.current;
    afterSheet.current = null;
    run?.();
  }, []);

  const complete = useCallback((key: string) => {
    registry.closeOpenRow();
    const found = find(key);
    const display = found?.row.item.display;
    const at = display?.lastReplyAt;
    if (!found || !display || typeof at !== 'number' || at <= 0) return;
    const { row } = found;
    const { userId: readOwner, language } = latest.current;
    // Keep the unread row until the owning computer accepts the shared read position.
    // A failed/offline write remains retryable from the same row.
    void (async () => {
      try {
        if (typeof display.lastReadAt === 'number' && at > display.lastReadAt) {
          await invokeRemoteResourceAction(invoke, row.host, { collectionId: row.item.ref.collectionId, actionId: 'read',
            resourceRef: row.item.ref, input: { at: Math.floor(at) } }, language);
        }
        await markRemoteResourceRead(readOwner, row.host.deviceId, row.item.ref.id, at);
      } catch {
        Alert.alert(t('devices.list.alert.actionFailed'));
      }
    })();
  }, [find, invoke, registry, t]);

  const openTeammate = navigation.openTeammate;
  const open = useCallback((row: HostedRemoteCollectionItem) => {
    const actor = cloud.supported && row.item.revision === CLOUD_ROW_REVISION ? cloudActorForRow(cloud.actors, row) : null;
    if (actor) { Keyboard.dismiss(); hostPush(cloudCompanionRoute(row, actor.id, i18n.language)); }
    else void openTeammate(row);
  }, [cloud.actors, cloud.supported, hostPush, i18n.language, openTeammate]);
  // Inbox classification and rendering both keep offline companions quiet.
  const quietPresence = useCallback(() => true, []);

  // The roster hands out fresh presence readers on every render: rows read them through stable
  // wrappers and redraw only when a listed computer's presence actually changes.
  const presence = useRef({ isOnline, connectionState });
  presence.current = { isOnline, connectionState };
  const readOnline = useCallback((host: RemoteResourceHostTarget) => presence.current.isOnline?.(host) ?? false, []);
  const readConnection = useCallback((host: RemoteResourceHostTarget) => {
    const current = presence.current;
    return current.connectionState ? current.connectionState(host) : current.isOnline?.(host) ?? false;
  }, []);
  const presenceKey = !isOnline ? '' : listed.map(row => `${isOnline(row.host)}:${connectionState?.(row.host)}`).join(',');
  const hasRoster = !!isOnline;
  const value = useMemo<InboxTeammatesValue | null>(() => !hasRoster ? null : {
    rows: new Map(listed.map(row => [row.key, row])), items, activities, registry,
    entries: new Map(entries.map(entry => [entry.key, entry])),
    isOnline: readOnline, connectionState: readConnection, quietPresence, open, snooze, complete,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- presenceKey stands for what the stable readers return
  }, [activities, complete, entries, hasRoster, items, listed, open, presenceKey, quietPresence, readConnection, readOnline, registry, snooze]);
  const sheet = <MountOnFirstOpen open={snoozeTarget !== null}>{() => <TaskSnoozeSheet visible={snoozeTarget !== null}
    onClose={closeSnooze} onClosed={snoozeClosed} onConfirm={confirmSnooze} />}</MountOnFirstOpen>;
  return { entries, value, sheet };
}

/** One teammate row of an inbox section. `timeLabel` is the wake time of a snoozed row. */
export const InboxTeammateRow = memo(function InboxTeammateRow({ rowKey, section, last, timeLabel }: {
  rowKey: string; section: TaskInboxSection; last: boolean; timeLabel?: string;
}): ReactElement | null {
  const value = useContext(InboxTeammatesContext);
  const render = useTeammateRowRenderer({
    items: value?.items ?? NO_ROWS, activities: value?.activities,
    isOnline: value?.isOnline ?? (() => false), connectionState: value?.connectionState,
    quietPresence: value?.quietPresence, onSelect: value?.open ?? noop,
  });
  const row = value?.rows.get(rowKey);
  const entry = value?.entries.get(rowKey);
  const snooze = entry?.snooze ?? null;
  // The swipe row is keyed and labelled by a task-shaped stand-in for the conversation.
  const session = useMemo(() => ({ id: `teammate:${rowKey}`, status: 'active', pinnedAt: null,
    snoozedUntil: snooze?.snoozedUntil ?? null, snoozedAt: snooze?.snoozedAt ?? null, userSendAt: snooze?.userSendAt ?? null,
  } as unknown as RemoteSession), [rowKey, snooze?.snoozedUntil, snooze?.snoozedAt, snooze?.userSendAt]);
  const onSnooze = useCallback(() => value?.snooze(rowKey), [rowKey, value]);
  const onComplete = useCallback(() => value?.complete(rowKey), [rowKey, value]);
  const { t } = useTranslation();
  const actions = entry ? inboxTeammateActions(entry, section) : null;
  const canSnooze = !!actions?.snooze;
  const canComplete = !!actions?.complete;
  const snoozed = taskSnoozeUntil(snooze ?? {}) > Date.now();
  // The swipe is the only visible entry to these actions; screen readers get them on the row.
  const rowActions = useMemo<TeammateRowActions | undefined>(() => !canSnooze && !canComplete ? undefined : {
    list: [
      ...(canSnooze ? [{ name: 'snooze', label: t(snoozed ? 'devices.list.menu.inbox.wake' : 'devices.list.menu.inbox.snooze') }] : []),
      ...(canComplete ? [{ name: 'complete', label: t('devices.list.menu.inbox.complete') }] : []),
    ],
    run: name => { if (name === 'snooze') onSnooze(); else if (name === 'complete') onComplete(); },
  }, [canSnooze, canComplete, snoozed, onSnooze, onComplete, t]);
  if (!value || !row || !entry) return null;
  const content = render({ kind: 'bot', row }, last, timeLabel, rowActions);
  if (!actions) return content;
  return <SwipeableSessionRow inboxMode only={actions} session={session} registry={value.registry}
    onSnooze={onSnooze} onComplete={onComplete} onArchive={noop} onMarkRead={noop} onShowOptions={noop} onTogglePin={noop}
    testID={`home.inboxTeammate.${row.host.deviceId}.${row.item.ref.id}.swipe`}>
    {content}
  </SwipeableSessionRow>;
});
