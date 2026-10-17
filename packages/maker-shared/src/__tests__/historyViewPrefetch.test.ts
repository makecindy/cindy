import { describe, expect, it } from 'vitest';
import { historyPrefetchVersion, historySnapshotCovers, historySnapshotForCache, historySnapshotFromPage, selectHistoryPrefetchSessions, mergeHistoryPrefetchRequest } from '../historyViewPrefetch.js';
import type { HistoryViewSnapshot } from '../historyViewController.js';
import type { HistoryMessageSource, HistoryViewItem, HistoryWorkSummary } from '../historyView.js';

const summary = (key: string, revision: string, endedAtMs = 0): HistoryWorkSummary => ({
  key, firstMessageId: `${key}-first`, lastMessageId: `${key}-last`, startedAtMs: 0, endedAtMs,
  isStreaming: false, messageCount: 1, toolCount: 1, revision,
});
const work = (key: string, revision: string, endedAtMs = 0): HistoryViewItem<HistoryMessageSource> =>
  ({ type: 'work', key, summary: summary(key, revision, endedAtMs) });
const detail = (revision: string) => ({ messages: [], revision, lastMessageId: 'x', loading: false, complete: true, error: null });

describe('history read ahead', () => {
  // The bridge and both in-flight queues use this union, so a reconnect cannot
  // erase a completion outside the five-task list budget in either arrival order.
  it.each([false, true])('selects recent tasks plus explicit completions (recent first=%s)', (recentFirst) => {
    let request = mergeHistoryPrefetchRequest(undefined, recentFirst ? undefined : new Set(['done']));
    request = mergeHistoryPrefetchRequest(request, recentFirst ? new Set(['done']) : undefined);
    const running = Array.from({ length: 5 }, (_, i) => ({ id: `running-${i}`, updatedAt: '2026-10-11T00:00:09Z', activeTurnStartedAt: 100 }));
    const picked = selectHistoryPrefetchSessions([...running,
      { id: 'done', updatedAt: '2026-10-11T00:00:01Z' }, { id: 'unrelated', updatedAt: '2026-10-11T00:00:02Z' }], {
      limit: request.recent ? undefined : 0, targets: request.targets, eligible: () => true, prefetchedAt: () => undefined,
    });
    expect(picked.map(s => s.id)).toEqual([...running.map(s => s.id), 'done']);
  });

  it('discards collapsed details before expanded ones and folds only if the latest page still cannot fit', () => {
    const page = { version: 1 as const, items: [work('collapsed', 'r1'), work('expanded', 'r1')], hasMore: false, nextCursor: null };
    const previous: HistoryViewSnapshot<HistoryMessageSource> = {
      ...page, details: new Map([['collapsed', detail('r1')], ['expanded', detail('r1')]]),
      expanded: new Set(['expanded']), loading: false, ready: true, error: null,
    };
    const expanded = historySnapshotForCache(page, previous, snapshot => snapshot.details.size <= 1)!;
    expect([...expanded.details.keys()]).toEqual(['expanded']);
    expect([...expanded.expanded]).toEqual(['expanded']);
    const folded = historySnapshotForCache(page, previous, snapshot => snapshot.details.size === 0)!;
    expect(folded.items).toEqual(page.items);
    expect(folded.expanded.size).toBe(0);
    expect(previous.details.size).toBe(2);
    expect(previous.expanded.size).toBe(1);
  });

  it('reads only the newest changed tasks it has not read at their current version', () => {
    const ms = (second: number) => Date.parse(`2026-10-11T00:00:0${second}Z`);
    const sessions = [
      { id: 'old', updatedAt: '2026-10-01T00:00:00Z' },
      { id: 'a', updatedAt: '2026-10-11T00:00:05Z' },
      // updatedAt stays at the turn start; the turn end is the newer activity.
      { id: 'ended', updatedAt: '2026-10-11T00:00:01Z', activeTurnStartedAt: ms(1), lastTurnEndedAt: ms(6) },
      { id: 'running', updatedAt: '2026-10-01T00:00:00Z', activeTurnStartedAt: ms(2), lastTurnEndedAt: ms(1) },
      { id: 'skip', updatedAt: '2026-10-11T00:00:09Z' },
      { id: 'done', updatedAt: '2026-10-11T00:00:04Z' },
    ];
    const pick = () => selectHistoryPrefetchSessions(sessions, {
      eligible: (session) => session.id !== 'skip',
      prefetchedAt: (id) => id === 'done' ? String(ms(4)) : id === 'running' ? 'any' : undefined,
      limit: 4,
    }).map((session) => session.id);
    expect(pick()).toEqual(['running', 'ended', 'a']);
    expect(historyPrefetchVersion(sessions[2])).toBe(String(ms(6)));
    expect(historyPrefetchVersion(sessions[3])).toBeUndefined();
  });

  it('treats a snapshot reaching the last activity as current, never a running turn', () => {
    const end = Date.parse('2026-10-11T00:00:05Z');
    const snapshot = { items: [work('w', 'r', end)] };
    expect(historySnapshotCovers(snapshot, { id: 's', updatedAt: '2026-10-11T00:00:05Z' })).toBe(true);
    expect(historySnapshotCovers(snapshot, { id: 's', updatedAt: '2026-10-11T00:00:01Z', lastTurnEndedAt: end + 1 })).toBe(false);
    expect(historySnapshotCovers(snapshot, { id: 's', updatedAt: '2026-10-11T00:00:01Z', activeTurnStartedAt: end - 1, lastTurnEndedAt: 0 })).toBe(false);
    expect(historySnapshotCovers(null, { id: 's', updatedAt: '2026-10-11T00:00:01Z' })).toBe(false);
  });

  it('keeps expanded work only while its range is unchanged', () => {
    const previous: HistoryViewSnapshot<HistoryMessageSource> = {
      items: [work('same', 'r1'), work('changed', 'r1')], expanded: new Set(['same', 'changed']),
      details: new Map([['same', detail('r1')], ['changed', detail('r1')]]),
      nextCursor: null, hasMore: false, loading: false, ready: true, error: null,
    };
    const next = historySnapshotFromPage({ version: 1, items: [work('same', 'r1'), work('changed', 'r2')],
      nextCursor: 'older', hasMore: true }, previous);
    expect([...next.expanded]).toEqual(['same']);
    expect([...next.details.keys()]).toEqual(['same']);
    expect(next).toMatchObject({ ready: true, loading: false, error: null, hasMore: true, nextCursor: 'older' });
  });

  it.each([true, false])('retains previously read pages and their pagination (hasMore=%s)', (hasMore) => {
    const previous: HistoryViewSnapshot<HistoryMessageSource> = {
      items: [work('earlier', 'r1'), work('latest', 'r1')],
      details: new Map([['earlier', detail('r1')], ['latest', detail('r1')]]),
      expanded: new Set(['earlier']), nextCursor: hasMore ? 'oldest' : null,
      hasMore, loading: false, ready: true, error: null,
    };
    const next = historySnapshotFromPage({ version: 1,
      items: [work('latest', 'r1'), work('new', 'r1')], hasMore: true, nextCursor: 'latest' }, previous);
    expect(next.items.map(item => item.key)).toEqual(['earlier', 'latest', 'new']);
    expect(next).toMatchObject({ hasMore, nextCursor: previous.nextCursor });
    expect([...next.details.keys()]).toEqual(['earlier', 'latest']);
    expect([...next.expanded]).toEqual(['earlier']);
  });

  it('keeps read details after collapse, but removes changed and absent ranges', () => {
    const previous: HistoryViewSnapshot<HistoryMessageSource> = {
      items: [work('same', 'r1'), work('changed', 'r1'), work('removed', 'r1')],
      details: new Map(['same', 'changed', 'removed'].map(key => [key, detail('r1')])),
      expanded: new Set(), nextCursor: null, hasMore: false, loading: false, ready: true, error: null,
    };
    const next = historySnapshotFromPage({ version: 1,
      items: [work('same', 'r1'), work('changed', 'r2')], hasMore: false, nextCursor: null }, previous);
    expect([...next.details.keys()]).toEqual(['same']);
    expect(next.expanded.size).toBe(0);
  });

  it('does not join disconnected history or restore rows removed by an authoritative full page', () => {
    const previous: HistoryViewSnapshot<HistoryMessageSource> = {
      items: [work('earlier', 'r1'), work('latest', 'r1')], details: new Map(), expanded: new Set(),
      nextCursor: 'oldest', hasMore: true, loading: false, ready: true, error: null,
    };
    for (const page of [
      { version: 1 as const, items: [work('unrelated', 'r1'), work('latest', 'r1')], hasMore: true, nextCursor: 'gap' },
      { version: 1 as const, items: [work('latest', 'r1')], hasMore: false, nextCursor: null },
    ]) {
      expect(historySnapshotFromPage(page, previous)).toMatchObject({
        items: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor,
      });
    }
  });
});
