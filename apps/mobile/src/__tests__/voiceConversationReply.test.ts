import { describe, expect, it } from 'vitest';
import { HistoryViewController, projectHistoryView } from '@cindy/maker-shared/message-window';

import { buildMobileHistoryRenderItems } from '@/session/mobileHistoryRender';
import { buildMobileMessageRenderItems } from '@/session/messageRenderModel';
import { findVoiceConversationReply } from '@/session/voiceConversationReply';
import type { RemoteMessage } from '@/session/types';

/**
 * Test value: production render/history projections feed voice reply selection,
 * so only the completed answer to the voice message is read aloud. The turn
 * controller tests inject replies and cannot prove user-client-ID association or
 * exclusion of failed attempts, partial output and subagent/tool text. Minimal
 * failures are one preceding user/reply pair, or a terminal error following a
 * partial assistant response. Unit tier uses real projection code and in-memory
 * history transport; no native speech, remote service or real timer waits.
 */
function row(index: number, role: RemoteMessage['role'], content: unknown,
  agentMeta: RemoteMessage['agentMeta'] = null): RemoteMessage {
  return { id: `server-${index}`, clientId: `client-${index}`, sessionId: 'session',
    role, content, agentMeta, toolUseId: null,
    createdAt: new Date(Date.UTC(2026, 9, 20, 0, 0, index)).toISOString() };
}

function tool(index: number, name = 'Read'): RemoteMessage {
  return { ...row(index, 'tool_use', { toolUseId: `tool-${index}`, toolName: name, input: {} }),
    toolUseId: `tool-${index}` };
}

describe('voice conversation reply selection', () => {
  it.each([true, false])('uses only the latest answer to the exact sent client ID (sealed=%s)', (sealed) => {
    const messages = [row(0, 'user', 'Previous question'), row(1, 'assistant', 'Previous answer'),
      row(2, 'user', 'Voice question'), row(3, 'assistant', 'Let me check'), tool(4),
      row(5, 'assistant', 'Voice answer', sealed ? { turnCompleted: true } : null)];
    const items = buildMobileMessageRenderItems(messages);
    expect(findVoiceConversationReply(items, 'client-0', false)).toBeNull();
    expect(findVoiceConversationReply(items, 'missing-client', false)).toBeNull();
    expect(findVoiceConversationReply(items, 'client-2', false)).toEqual({ id: 'client-5', text: 'Voice answer' });
    expect(findVoiceConversationReply(buildMobileMessageRenderItems([
      ...messages, row(6, 'user', 'Another device takes over'), row(7, 'assistant', 'Unrelated answer'),
    ]), 'client-2', false)).toBeNull();
  });

  it('waits through running or streaming output even if a final-looking reply is present', () => {
    const messages = [row(0, 'user', 'Question'), row(1, 'assistant', 'Partial', { isStreaming: true })];
    expect(findVoiceConversationReply(buildMobileMessageRenderItems(messages), 'client-0', false)).toBeNull();
    const completed = buildMobileMessageRenderItems([
      messages[0], row(1, 'assistant', 'Answer', { turnCompleted: true }),
    ]);
    expect(findVoiceConversationReply(completed, 'client-0', true)).toBeNull();
    expect(findVoiceConversationReply(completed, 'client-0', false)).toEqual({ id: 'client-1', text: 'Answer' });
  });

  it.each(['failed-sample', 'stopped', 'error', 'tool-only'] as const)('does not read %s output as a successful voice reply', (failure) => {
    const messages = [row(0, 'user', 'Question')];
    if (failure === 'tool-only') {
      messages.push(row(1, 'thinking', { text: 'Private reasoning' }), tool(2));
    } else {
      messages.push(row(1, 'assistant', 'Incomplete answer', failure === 'failed-sample'
        ? { turnCompleted: true, failedSamplingAttempt: { threadId: 'thread', turnId: 'turn', attempt: 1, itemId: 'item' } }
        : failure === 'stopped' ? { turnCompleted: false, turnUsageDetails: { totalTokens: 20 } } : null));
      if (failure === 'error') messages.push(row(2, 'error', { message: 'Provider failed' }));
    }
    expect(findVoiceConversationReply(buildMobileMessageRenderItems(messages), 'client-0', false)).toBeNull();
  });

  it('reads the main reply without exposing reasoning, tool results or a child agent answer', () => {
    const messages = [row(0, 'user', 'Research'), row(1, 'thinking', { text: 'Private reasoning' }),
      tool(2, 'Agent'), row(3, 'assistant', 'Child answer', { parentUuid: 'tool-2', turnCompleted: true }),
      { ...row(4, 'tool_result', 'Child tool summary'), toolUseId: 'tool-2' },
      row(5, 'assistant', 'Main answer', { turnCompleted: true })];
    const items = buildMobileMessageRenderItems(messages);
    expect(items.some(item => item.type === 'subagent_group')).toBe(true);
    expect(findVoiceConversationReply(items, 'client-0', false)).toEqual({ id: 'client-5', text: 'Main answer' });
    expect(findVoiceConversationReply(buildMobileMessageRenderItems(messages.slice(0, -1)), 'client-0', false)).toBeNull();
  });

  it('accepts a completed recovery after an earlier error in the same user turn', () => {
    const items = buildMobileMessageRenderItems([
      row(0, 'user', 'Question'), row(1, 'assistant', 'Partial'),
      row(2, 'error', { message: 'Temporary failure' }),
      row(3, 'assistant', 'Recovered answer', { turnCompleted: true }),
    ]);
    expect(findVoiceConversationReply(items, 'client-0', false)).toEqual({ id: 'client-3', text: 'Recovered answer' });
  });

  it('selects the latest main reply from the real history view while previous answers stay folded', async () => {
    const messages = [row(0, 'user', 'Question'), row(1, 'assistant', 'Checking'), tool(2),
      row(3, 'assistant', 'Background work continues', { turnCompleted: true }), tool(4),
      row(5, 'assistant', 'Final result', { turnCompleted: true })];
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: projectHistoryView(messages, false, true), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    try {
      await view.refresh();
      const items = buildMobileHistoryRenderItems({ view, snapshot: view.getSnapshot(), messages: [],
        streaming: false, sessionId: 'session' });
      expect(items.some(item => item.type === 'work_group')).toBe(true);
      expect(findVoiceConversationReply(items, 'client-0', false)).toEqual({ id: 'client-5', text: 'Final result' });
    } finally {
      view.setActive(false);
    }
  });
});
