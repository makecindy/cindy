import { historyWorkSummaries, retainHistoryViewPrefix, type HistoryMessageSource, type HistoryViewPage } from './historyView.js';
import type { HistoryViewSnapshot, HistoryWorkDetailState } from './historyViewController.js';
import { historyViewEndMs } from './historyViewHandoff.js';

/** Recently changed tasks read ahead after a list refresh; older tasks wait to be opened. */
export const HISTORY_PREFETCH_SESSION_LIMIT = 5;

export interface HistoryPrefetchRequest { recent: boolean; targets: Set<string> }

/** Recent tasks have a budget; explicit completion targets must survive that budget. */
export function mergeHistoryPrefetchRequest(
  previous: HistoryPrefetchRequest | undefined, targets?: ReadonlySet<string>, recent = targets === undefined,
): HistoryPrefetchRequest {
  return { recent: recent || previous?.recent === true, targets: new Set([...previous?.targets ?? [], ...targets ?? []]) };
}

export interface HistoryPrefetchSession {
  id: string;
  updatedAt: string;
  activeTurnStartedAt?: number | null;
  lastTurnEndedAt?: number | null;
}

/** Durable turn-end patches, rather than activity text, trigger read ahead. */
export function historyTurnEnded(previous: { lastTurnEndedAt?: number | null }, patch: { lastTurnEndedAt?: unknown }): boolean {
  return typeof patch.lastTurnEndedAt === 'number' && Number.isFinite(patch.lastTurnEndedAt)
    && patch.lastTurnEndedAt > (previous.lastTurnEndedAt ?? 0);
}

/** A turn that started after the last one ended keeps writing rows without touching `updatedAt`. */
function isTurnRunning(session: HistoryPrefetchSession): boolean {
  return typeof session.activeTurnStartedAt === 'number'
    && session.activeTurnStartedAt > (session.lastTurnEndedAt ?? 0);
}

/** `updatedAt` misses turn ends and is not bumped per message; the turn fields fill that gap. */
function activityMs(session: HistoryPrefetchSession): number {
  return Math.max(Date.parse(session.updatedAt) || 0, session.lastTurnEndedAt ?? 0, session.activeTurnStartedAt ?? 0);
}

/**
 * Version a read ahead is valid for. A running task has none: it changes until its turn ends,
 * so every refresh after a gap reads it again.
 */
export function historyPrefetchVersion(session: HistoryPrefetchSession): string | undefined {
  return isTurnRunning(session) ? undefined : String(activityMs(session));
}

/**
 * Pick the most recently active tasks not yet read ahead at their current version. Only the
 * newest `limit` eligible tasks are considered, so a quiet list never walks into older tasks.
 */
export function selectHistoryPrefetchSessions<S extends HistoryPrefetchSession>(
  sessions: readonly S[],
  options: { eligible(session: S): boolean; prefetchedAt(sessionId: string): string | undefined; limit?: number; targets?: ReadonlySet<string> },
): S[] {
  const rank = (session: S) => isTurnRunning(session) ? Number.POSITIVE_INFINITY : activityMs(session);
  return sessions
    .filter((session) => activityMs(session) > 0 && options.eligible(session))
    .sort((a, b) => rank(b) - rank(a) || activityMs(b) - activityMs(a))
    .filter((session, index) => index < (options.limit ?? HISTORY_PREFETCH_SESSION_LIMIT)
      || (options.targets?.has(session.id) && !isTurnRunning(session)))
    .filter((session) => {
      const version = historyPrefetchVersion(session);
      return version === undefined || options.prefetchedAt(session.id) !== version;
    });
}

/** A cached snapshot that already reaches the task's last activity needs no read ahead. */
export function historySnapshotCovers<T extends HistoryMessageSource>(
  snapshot: Pick<HistoryViewSnapshot<T>, 'items'> | null | undefined,
  session: HistoryPrefetchSession,
): boolean {
  return !!snapshot && !isTurnRunning(session) && historyViewEndMs(snapshot) >= activityMs(session);
}

/**
 * Read ahead uses the same continuous-prefix rule as an open view. Unchanged work keeps
 * its cached body even after collapse; expansion is a display preference, not retention.
 */
export function historySnapshotFromPage<T extends HistoryMessageSource>(
  page: HistoryViewPage<T>,
  previous: HistoryViewSnapshot<T> | null | undefined,
): HistoryViewSnapshot<T> {
  const retained = retainHistoryViewPrefix(page, previous);
  const details = new Map<string, HistoryWorkDetailState<T>>();
  const expanded = new Set<string>();
  for (const summary of historyWorkSummaries(retained.items)) {
    const detail = previous?.details.get(summary.key);
    if (!detail?.complete || detail.loading || detail.error
      || detail.revision !== summary.revision) continue;
    details.set(summary.key, detail);
    if (previous?.expanded.has(summary.key)) expanded.add(summary.key);
  }
  return {
    items: retained.items, details, expanded, nextCursor: retained.nextCursor, hasMore: retained.hasMore,
    loading: false, ready: true, error: null,
  };
}

/** Fit read-ahead to the existing platform budget before invoking a cache writer. */
export function historySnapshotForCache<T extends HistoryMessageSource>(
  page: HistoryViewPage<T>,
  previous: HistoryViewSnapshot<T> | null | undefined,
  fits: (snapshot: HistoryViewSnapshot<T>) => boolean,
  latestPage: HistoryViewPage<T> = page,
): HistoryViewSnapshot<T> | null {
  const merged = historySnapshotFromPage(page, previous);
  if (fits(merged)) return merged;
  const withoutCollapsed = (snapshot: HistoryViewSnapshot<T>): HistoryViewSnapshot<T> => ({
    ...snapshot, details: new Map([...snapshot.details].filter(([key]) => snapshot.expanded.has(key))),
  });
  const expandedOnly = withoutCollapsed(merged);
  if (fits(expandedOnly)) return expandedOnly;
  // A filled gap can itself exceed the cache. Restore the original latest page
  // and its cursor, so omitted rows stay reachable online; never slice a work range.
  const latest = withoutCollapsed(historySnapshotFromPage(latestPage, previous ? { ...previous, items: [] } : null));
  if (fits(latest)) return latest;
  const folded = { ...latest, details: new Map<string, HistoryWorkDetailState<T>>(), expanded: new Set<string>() };
  // A latest page that cannot fit even folded must not clear the existing mirror or
  // be recorded as successfully prefetched. The next normal refresh may try again.
  return fits(folded) ? folded : null;
}
