import { describe, expect, it } from 'vitest';
import type { HistoryViewSnapshot } from '@cindy/maker-shared/message-window';
import type { RemoteMessage } from '@/session/types';
import { hasSessionEntryPreviewMismatch } from '@/session/sessionEntrySyncIndicator';

const message = (content: string, role: RemoteMessage['role'] = 'assistant', time = 1): RemoteMessage => ({
  id: String(time), clientId: String(time), sessionId: 's', role, content,
  toolUseId: null, agentMeta: null, createdAt: new Date(time).toISOString(),
});
const history: HistoryViewSnapshot<RemoteMessage> = {
  items: [], details: new Map(), expanded: new Set(), nextCursor: null,
  hasMore: false, loading: true, ready: false, error: null,
};

describe('immediate entry synchronization', () => {
  it('shows immediately for a known different Home preview and stops when aligned', () => {
    expect(hasSessionEntryPreviewMismatch('s', 'New answer', null, [message('Old answer')], history)).toBe(true);
    expect(hasSessionEntryPreviewMismatch('s', 'New answer', null, [message('New\nanswer')], history)).toBe(false);
  });
  it('shows missing content immediately only when Home already has a preview', () => {
    expect(hasSessionEntryPreviewMismatch('s', undefined, 'Known content', [], history)).toBe(true);
    expect(hasSessionEntryPreviewMismatch('s', undefined, undefined, [], history)).toBe(false);
  });
  it('handles plain server previews without mistaking truncation or rich formatting for stale content', () => {
    expect(hasSessionEntryPreviewMismatch('s', undefined, 'New answer', [message('Old answer')], history)).toBe(true);
    expect(hasSessionEntryPreviewMismatch('s', undefined, 'Long answer', [message('Long answer continued')], history)).toBe(false);
    expect(hasSessionEntryPreviewMismatch('s', undefined, 'Answer continued', [message('Answer')], history)).toBe(true);
    expect(hasSessionEntryPreviewMismatch('s', undefined, 'Answer', [message('**Answer**')], history)).toBe(false);
    expect(hasSessionEntryPreviewMismatch('s', undefined, 'Answer', [message('- Answer')], history)).toBe(false);
  });
  it('does not mistake deferred work prose for missing messages even with a later tool row', () => {
    const folded: HistoryViewSnapshot<RemoteMessage> = { ...history, ready: true, items: [{
      type: 'work', key: 'w', summary: {
        key: 'w', firstMessageId: '2', lastMessageId: '2', startedAtMs: 2, endedAtMs: 2,
        isStreaming: false, messageCount: 1, toolCount: 0, revision: 'r',
      },
    }] };
    expect(hasSessionEntryPreviewMismatch('s', 'Folded answer', null,
      [message('Earlier answer'), message('tool', 'tool_result', 3)], folded)).toBe(false);
  });
});
