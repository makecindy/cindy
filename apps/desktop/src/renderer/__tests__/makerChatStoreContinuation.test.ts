import { describe, expect, it } from 'vitest';

import {
  EMPTY_SESSION_STATE,
  handleStreamEvent,
  makerChatStore,
  type SessionChatState,
} from '@/lib/makerChatStore';

describe('continuation SDK boundaries in the renderer', () => {
  it('seals only the current assistant segment and keeps product state running', () => {
    const before = {
      ...EMPTY_SESSION_STATE,
      isStreaming: true,
      streamingClientId: 'assistant-1',
      streamingText: 'partial answer',
      messages: [
        {
          clientId: 'assistant-1',
          role: 'assistant',
          content: 'partial answer',
          isStreaming: true,
          createdAt: '2026-08-04T00:00:00.000Z',
        },
      ],
      pendingPermission: { requestId: 'permission-1', toolName: 'Bash', input: {} },
      pendingAskUser: { requestId: 'ask-1', questions: [] },
      agentStatus: {
        ...EMPTY_SESSION_STATE.agentStatus,
        isRunning: true,
        startedAt: 100,
      },
    } as SessionChatState;

    const afterBoundary = handleStreamEvent(before, {
      sessionId: 's1',
      type: 'done',
      source: 'claude-code',
      data: {},
      turnContinuationId: 1,
    });

    expect(afterBoundary.isStreaming).toBe(true);
    expect(afterBoundary.streamingText).toBe('');
    expect(afterBoundary.streamingClientId).toBeNull();
    expect(afterBoundary.messages[0]?.isStreaming).toBe(false);
    expect(afterBoundary.agentStatus.isRunning).toBe(true);
    expect(afterBoundary.pendingPermission?.requestId).toBe('permission-1');
    expect(afterBoundary.pendingAskUser?.requestId).toBe('ask-1');

    const afterTerminal = handleStreamEvent(afterBoundary, {
      sessionId: 's1',
      type: 'done',
      source: 'claude-code',
      data: {},
    });
    expect(afterTerminal.isStreaming).toBe(false);
    expect(afterTerminal.agentStatus.isRunning).toBe(false);
    expect(afterTerminal.pendingPermission).toBeNull();
    expect(afterTerminal.pendingAskUser).toBeNull();
  });

  it('does not turn a claimed status(false) into renderer idle', () => {
    const sessionId = `continuation-status-${Math.random().toString(36).slice(2, 8)}`;
    try {
      makerChatStore.__applyStatusUpdateForTest(sessionId, {
        sessionId,
        status: 'Working',
        tokenUsage: 1,
        costUsd: 0,
        contextTokens: 1,
        contextWindow: 10,
        isRunning: true,
      });
      makerChatStore.__applyStatusUpdateForTest(sessionId, {
        sessionId,
        status: 'Done',
        tokenUsage: 1,
        costUsd: 0,
        contextTokens: 1,
        contextWindow: 10,
        isRunning: false,
        turnContinuationId: 1,
      });

      expect(makerChatStore.getSnapshot(sessionId).agentStatus.isRunning).toBe(true);
      expect(makerChatStore.getSnapshot(sessionId).isStreaming).toBe(true);
    } finally {
      makerChatStore.purgeSession(sessionId);
    }
  });
});
