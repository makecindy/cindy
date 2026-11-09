import Notifications from './nativeNotifications';

export type VisibleNotificationRoute = { pathname: string; deviceId?: string; threadRootId?: string };

/** A notification belongs to a device and a thread, not just a pathname. */
export function isNotificationRouteVisible(route: string, visible: VisibleNotificationRoute): boolean {
  const [pathname, query] = route.split('?');
  const params = new URLSearchParams(query);
  return pathname === visible.pathname
    && (params.get('deviceId') ?? undefined) === visible.deviceId
    && (params.get('threadRootId') ?? undefined) === visible.threadRootId;
}

// Native writes are ordered across account changes; a slow previous write cannot
// land after the sign-out clear. Unknown counts never clear a known badge.
let tail: Promise<unknown> = Promise.resolve();
function update(operation: () => Promise<void>): Promise<void> {
  const next = tail.then(operation, operation);
  tail = next.catch(() => undefined);
  return next;
}

/** Coalesce store bursts and read the latest count only when its native turn starts. */
export function createTaskBadgeSync(read: () => number | undefined, current: () => boolean) {
  let disposed = false;
  let pending = false;
  let dirty = false;
  let last: number | undefined;
  const sync = async (force = false): Promise<void> => {
    if (disposed) return;
    if (force) last = undefined;
    dirty = true;
    if (pending) return;
    pending = true;
    try {
      while (dirty && !disposed) {
        dirty = false;
        await update(async () => {
          if (disposed || !current()) return;
          const count = read();
          if (count === undefined || count === last || !Number.isSafeInteger(count) || count < 0) return;
          await Notifications.setBadgeCountAsync(count);
          // Unsupported launchers/denied badge permission return false. Do not
          // hammer the same count; foreground/settings changes force a fresh try.
          if (!disposed) last = count;
        });
      }
    } finally { pending = false; }
  };
  return { sync, dispose: () => { disposed = true; } };
}

export function clearNotificationBadge(): Promise<void> {
  return update(async () => {
    try { await Notifications.dismissAllNotificationsAsync(); }
    finally { await Notifications.setBadgeCountAsync(0); }
  });
}
