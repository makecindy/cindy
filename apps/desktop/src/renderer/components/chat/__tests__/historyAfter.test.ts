import { describe, expect, it } from 'vitest';
import type { HistoryMessageSource, HistoryViewSnapshot, HistoryWorkSummary } from '@cindy/maker-shared/message-window';
import { historyAfter } from '../historyAfter';

// Unit regression: real side-chat UI showed copied parent rows through the history projection,
// even with an empty filtered raw transcript. Cover both prose and deferred tool groups.
describe('fork history display boundary', () => {
  const row = (id: string, time: number): HistoryMessageSource => ({ id, clientId: id, role: 'assistant', content: id, createdAt: new Date(time).toISOString() });
  const old = row('parent-answer', 99);
  const current = row('follow-up-answer', 100);
  const summary: HistoryWorkSummary = { key: 'parent-work', firstMessageId: old.id, lastMessageId: old.id, startedAtMs: 50, endedAtMs: 99, isStreaming: false, messageCount: 1, toolCount: 1, revision: '1' };
  const source: HistoryViewSnapshot<HistoryMessageSource> = {
    items: [{ type: 'work', key: summary.key, summary }, { type: 'messages', key: 'answers', messages: [old, current] }],
    details: new Map([[summary.key, { messages: [old], revision: '1', lastMessageId: old.id, loading: false, complete: true, error: null }]]),
    expanded: new Set(), hasMore: true, nextCursor: 'older', ready: true, loading: false, error: null,
  };

  it('shows only the child answer and stops paging at inherited history without changing stored context', () => {
    const visible = historyAfter(source, 100)!;
    expect(visible.items).toEqual([{ type: 'messages', key: 'answers', messages: [current] }]);
    expect(visible.details.get(summary.key)?.messages).toEqual([]);
    expect(visible.hasMore).toBe(false);
    expect(visible.nextCursor).toBeNull();
    expect(source.items).toHaveLength(2);
    expect(source.details.get(summary.key)?.messages).toEqual([old]);
  });

  it('keeps pagination when all loaded messages belong to the child, and leaves ordinary tasks unchanged', () => {
    const later = { ...source, items: [{ type: 'messages' as const, key: 'later', messages: [current] }] };
    expect(historyAfter(later, 100)).toMatchObject({ hasMore: true, nextCursor: 'older' });
    expect(historyAfter(source, undefined)).toBe(source);
  });
});
