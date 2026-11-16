import { createTaskBadgeSync } from './notificationBadge';

export interface TaskBadgeSnapshot {
  schemaVersion: 1;
  accountId: string;
  version: string;
  waitingCount: number;
  unreadCount: number;
  runningCount: number;
  badgeCount: number;
  complete: boolean;
}

export function parseTaskBadgeSnapshot(value: unknown, accountId: string): TaskBadgeSnapshot | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as TaskBadgeSnapshot;
  if (data.schemaVersion !== 1 || data.accountId !== accountId || typeof data.complete !== 'boolean'
    || typeof data.version !== 'string' || !/^(0|[1-9]\d*)$/.test(data.version)
    || ![data.waitingCount, data.unreadCount, data.runningCount, data.badgeCount]
      .every(count => Number.isSafeInteger(count) && count >= 0)
    || data.badgeCount !== data.waitingCount + data.unreadCount) return;
  return data;
}

function compareVersion(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** Expo iOS keeps APNs custom fields under trigger.payload; Android uses content.data. */
export function readNotificationTaskBadge(notification: unknown, accountId: string): TaskBadgeSnapshot | undefined {
  const request = (notification as { request?: { content?: { data?: { taskActivity?: unknown } }; trigger?: { payload?: { taskActivity?: unknown } } } } | null)?.request;
  return parseTaskBadgeSnapshot(request?.content?.data?.taskActivity, accountId)
    ?? parseTaskBadgeSnapshot(request?.trigger?.payload?.taskActivity, accountId);
}

/** One account/realm lifetime. Push and REST reconcile by server revision, never Home rows. */
export function createServerTaskBadgeSync(
  fetchSnapshot: () => Promise<TaskBadgeSnapshot | undefined>,
  current: () => boolean,
  accountId: string,
  write?: (snapshot: TaskBadgeSnapshot) => Promise<unknown>,
) {
  let disposed = false;
  let snapshot: TaskBadgeSnapshot | undefined;
  let refreshing: Promise<void> | undefined;
  const writer = createTaskBadgeSync(() => snapshot && (snapshot.complete || write) ? snapshot.badgeCount : undefined, () => !disposed && current(),
    write ? () => write(snapshot!) : undefined);
  const accept = async (next: TaskBadgeSnapshot | undefined, force = false): Promise<void> => {
    if (disposed || !current() || !parseTaskBadgeSnapshot(next, accountId)
      || !next || (snapshot && compareVersion(next.version, snapshot.version) < 0)) return;
    if (!snapshot || compareVersion(next.version, snapshot.version) > 0) snapshot = next;
    // Native Android also records the version when the count stays the same or
    // a newer snapshot is incomplete, so later background deliveries cannot regress it.
    await writer.sync(force || !!write);
  };
  const refresh = (): Promise<void> => {
    if (disposed || !current()) return Promise.resolve();
    if (refreshing) return refreshing;
    // Equal revisions must still repair native badge changes made while JS was
    // suspended. Do not rewrite our cached value before the fresh request settles.
    refreshing = (async () => {
      try {
        const next = await fetchSnapshot();
        await accept(next, true);
      } finally { refreshing = undefined; }
    })();
    return refreshing;
  };
  return {
    accept,
    refresh,
    dispose: () => { disposed = true; writer.dispose(); },
  };
}
