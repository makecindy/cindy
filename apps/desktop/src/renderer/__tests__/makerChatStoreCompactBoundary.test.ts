/**
 * compact_boundary can arrive once from transcript replay and again from the
 * live stream. The renderer must treat a provider boundary id as idempotent so
 * the duplicate cannot finish work that started after the first boundary.
 */

import { describe, expect, it } from 'vitest';

import { EMPTY_SESSION_STATE, handleStreamEvent, type ChatMessage } from '@/lib/makerChatStore';

const SESSION_ID = 'compact-boundary-session';

function compactEvent(boundaryId: string) {
  return {
    sessionId: SESSION_ID,
    type: 'compact_boundary' as const,
    data: {
      boundaryId,
      trigger: 'auto' as const,
      preTokens: 100,
      postTokens: 20,
      durationMs: 50,
    },
  };
}

describe('handleStreamEvent compact boundary identity', () => {
  it('ignores a repeated boundary before it can finish newer streaming work', () => {
    const afterBoundary = handleStreamEvent(EMPTY_SESSION_STATE, compactEvent('boundary-1'));
    const streamingMessage: ChatMessage = {
      clientId: 'thinking-after-compact',
      role: 'thinking',
      content: '继续处理',
      isStreaming: true,
    };
    const withNewWork = {
      ...afterBoundary,
      messages: [...afterBoundary.messages, streamingMessage],
      streamingClientId: streamingMessage.clientId,
      isStreaming: true,
    };

    const replayed = handleStreamEvent(withNewWork, compactEvent('boundary-1'));

    expect(replayed).toBe(withNewWork);
    expect(
      replayed.messages.filter((message) => message.systemCardType === 'compact'),
    ).toHaveLength(1);
    expect(replayed.messages.at(-1)).toMatchObject({
      clientId: 'thinking-after-compact',
      isStreaming: true,
    });
    expect(replayed.streamingClientId).toBe('thinking-after-compact');
  });

  it('keeps distinct compact boundaries and finishes work before the new one', () => {
    const afterFirst = handleStreamEvent(EMPTY_SESSION_STATE, compactEvent('boundary-1'));
    const withNewWork = {
      ...afterFirst,
      messages: [
        ...afterFirst.messages,
        {
          clientId: 'thinking-before-second-compact',
          role: 'thinking' as const,
          content: '继续处理',
          isStreaming: true,
        },
      ],
      streamingClientId: 'thinking-before-second-compact',
      isStreaming: true,
    };

    const afterSecond = handleStreamEvent(withNewWork, compactEvent('boundary-2'));

    expect(
      afterSecond.messages.filter((message) => message.systemCardType === 'compact'),
    ).toHaveLength(2);
    expect(
      afterSecond.messages.find((message) => message.clientId === 'thinking-before-second-compact'),
    ).toMatchObject({ isStreaming: false });
    expect(afterSecond.streamingClientId).toBeNull();
    expect(afterSecond.messages.at(-1)?.clientId).toBe('compact:boundary-2');
  });

  it('does not finish a live turn when a background compact_boundary arrives', () => {
    const streaming = {
      ...EMPTY_SESSION_STATE,
      messages: [
        {
          clientId: 'live-after-idle-compact',
          role: 'assistant' as const,
          content: '正在回答',
          isStreaming: true,
        },
      ],
      streamingClientId: 'live-after-idle-compact',
      isStreaming: true,
    };
    const afterBackground = handleStreamEvent(streaming, {
      ...compactEvent('idle-compact'),
      turnScope: 'background',
    });

    expect(afterBackground.streamingClientId).toBe('live-after-idle-compact');
    expect(afterBackground.isStreaming).toBe(true);
    expect(
      afterBackground.messages.find((message) => message.clientId === 'live-after-idle-compact'),
    ).toMatchObject({ isStreaming: true });
    expect(afterBackground.messages.at(-1)?.systemCardType).toBe('compact');
  });
});
