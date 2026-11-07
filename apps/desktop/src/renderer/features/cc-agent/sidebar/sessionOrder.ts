import type { Session } from '@/lib/ccAgent.types';
import type { SidebarSessionEntry } from '../lib/automationSidebarGrouping';

const PREFIX = 'cc-agent.sidebar.manualSessionOrder:';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function storageKey(ownerId: string | null | undefined, projectKey: string): string {
  return PREFIX + (ownerId ?? 'signed-out') + ':' + projectKey;
}

export function loadManualSessionOrder(
  ownerId: string | null | undefined,
  projectKey: string,
): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(storageKey(ownerId, projectKey));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function persistManualSessionOrder(
  ownerId: string | null | undefined,
  projectKey: string,
  order: readonly string[],
): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(storageKey(ownerId, projectKey), JSON.stringify(order));
  } catch {
    // Storage can be unavailable in private or restricted renderer contexts.
  }
}

export function reconcileManualSessionOrder(
  previous: readonly string[],
  sessions: readonly Session[],
): string[] {
  const ids = sessions.map((session) => session.id);
  const seen = new Set<string>();
  const next = previous.filter((id) => !seen.has(id));
  next.forEach((id) => seen.add(id));
  ids.forEach((id) => {
    if (!seen.has(id)) next.push(id);
  });
  return next;
}

export function reorderSessionIds(
  previous: readonly string[],
  movedId: string,
  newIndex: number,
): string[] {
  const next = previous.filter((id) => id !== movedId);
  next.splice(Math.max(0, Math.min(newIndex, next.length)), 0, movedId);
  return next;
}

export function mergeVisibleSessionReorder(
  previous: readonly string[],
  visibleOrder: readonly string[],
): string[] {
  const visibleIds = new Set(visibleOrder);
  let visibleIndex = 0;
  return previous.map((id) =>
    visibleIds.has(id) ? visibleOrder[visibleIndex++] ?? id : id,
  );
}

export function orderManualSidebarEntries(
  entries: readonly SidebarSessionEntry[],
  manualOrder: readonly string[],
): SidebarSessionEntry[] {
  const rank = new Map(manualOrder.map((id, index) => [id, index]));
  return entries
    .map((entry, index) => ({
      entry,
      index,
      rank:
        entry.kind === 'session'
          ? rank.get(entry.session.id) ?? manualOrder.length
          : Math.min(
              ...entry.group.sessions.map(
                (session) => rank.get(session.id) ?? manualOrder.length,
              ),
            ),
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ entry }) => entry);
}

export function sessionIdsForSidebarEntry(entry: SidebarSessionEntry): string[] {
  return entry.kind === 'session'
    ? [entry.session.id]
    : entry.group.sessions.map((session) => session.id);
}
