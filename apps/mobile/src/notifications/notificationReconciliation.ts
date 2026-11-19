export interface PresentedNotification {
  request: { identifier: string; content: { data?: unknown }; trigger?: unknown };
}
export interface NotificationIdentity { identifier: string; id: string; recipientId: string; chat: boolean }
export function notificationIdentity(notification: PresentedNotification): NotificationIdentity | undefined {
  const request = notification.request;
  const trigger = request.trigger as { payload?: unknown } | null;
  for (const value of [request.content.data, trigger?.payload]) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (typeof row.notificationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(row.notificationId)
      || typeof row.recipientId !== 'string' || !row.recipientId) continue;
    if (!['chat-message', 'session-done', 'session-error', 'session-needs-reply'].includes(String(row.category))) continue;
    return { identifier: request.identifier, id: row.notificationId, recipientId: row.recipientId, chat: row.category === 'chat-message' };
  }
}
/** Responses may retire only identities in the captured request. New deliveries are untouched. */
export async function reconcileDeliveredNotifications(options: {
  presented: () => Promise<PresentedNotification[]>;
  current: () => boolean;
  resolve: (items: NotificationIdentity[]) => Promise<string[]>;
  retire: (items: NotificationIdentity[]) => Promise<void>;
}) {
  const items = (await options.presented()).flatMap(item => {
    const identity = notificationIdentity(item);
    return identity ? [identity] : [];
  });
  for (let offset = 0; offset < items.length && options.current(); offset += 50) {
    const batch = items.slice(offset, offset + 50);
    const resolved = new Set(await options.resolve(batch));
    if (!options.current()) return;
    const retired = batch.filter(item => resolved.has(`${item.recipientId}:${item.id}`));
    if (retired.length) await options.retire(retired);
  }
}
