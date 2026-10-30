import type { HistoryMessageSource, HistoryViewItem, HistoryViewSnapshot } from './messageWindow.js';

/** Hide inherited reference history without changing the agent's transcript. */
export function historyAfter<T extends HistoryMessageSource>(
  snapshot: HistoryViewSnapshot<T> | null,
  boundary: number | undefined,
): HistoryViewSnapshot<T> | null {
  if (!snapshot || boundary === undefined) return snapshot;
  let reachedBoundary = false;
  const keepMessage = (message: T): boolean => new Date(message.createdAt).getTime() >= boundary;
  const filter = (items: readonly HistoryViewItem<T>[]): HistoryViewItem<T>[] => items.flatMap<HistoryViewItem<T>>(item => {
    if (item.type === 'messages') {
      const messages = item.messages.filter(keepMessage);
      if (messages.length !== item.messages.length) reachedBoundary = true;
      return messages.length ? [{ ...item, messages }] : [];
    }
    if (item.summary.endedAtMs < boundary) {
      reachedBoundary = true;
      return [];
    }
    return [{ ...item, children: item.children ? filter(item.children) : undefined }];
  });
  const items = filter(snapshot.items);
  return {
    ...snapshot, items,
    details: new Map([...snapshot.details].map(([key, detail]) => [key, { ...detail, messages: detail.messages.filter(keepMessage) }])),
    hasMore: snapshot.hasMore && !reachedBoundary,
    nextCursor: reachedBoundary ? null : snapshot.nextCursor,
  };
}
