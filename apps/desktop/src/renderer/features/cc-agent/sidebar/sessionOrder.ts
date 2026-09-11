import type { Session } from '@/lib/ccAgent.types';

const PREFIX = 'cc-agent.sidebar.manualSessionOrder:';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadManualSessionOrder(projectKey: string): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(`${PREFIX}${projectKey}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function persistManualSessionOrder(projectKey: string, order: readonly string[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(`${PREFIX}${projectKey}`, JSON.stringify(order));
  } catch {
    // Storage can be unavailable in private or restricted renderer contexts.
  }
}

export function reconcileManualSessionOrder(
  previous: readonly string[],
  sessions: readonly Session[],
): string[] {
  const ids = sessions.map((session) => session.id);
  const active = new Set(ids);
  const seen = new Set<string>();
  const next = previous.filter((id) => active.has(id) && !seen.has(id));
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
