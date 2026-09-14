import { describe, expect, it } from 'vitest';

import {
  EMPTY_SESSION_STATE,
  handleStreamEvent,
  type SessionChatState,
} from '@/lib/makerChatStore';

function doneState(
  turnStoppedByUser: boolean,
  data: Record<string, unknown>,
): SessionChatState {
  const before = {
    ...EMPTY_SESSION_STATE,
    turnStoppedByUser,
    agentStatus: {
      ...EMPTY_SESSION_STATE.agentStatus,
      isRunning: true,
      startedAt: 100,
    },
  } as SessionChatState;
  return handleStreamEvent(before, {
    sessionId: 'session-1',
    type: 'done',
    source: 'claude-code',
    data,
  });
}

describe('prompt recommendation cross-window Stop projection', () => {
  it('真实或合成的 cancelled terminal 会在所有窗口投影 Stop', () => {
    expect(doneState(false, { cancelled: true }).turnStoppedByUser).toBe(true);
    expect(
      doneState(false, { reason: 'turn_continuation_cancelled' }).turnStoppedByUser,
    ).toBe(true);
    expect(
      doneState(false, { reason: 'user_stop_unconfirmed_wake_tasks' }).turnStoppedByUser,
    ).toBe(true);
    expect(doneState(false, {}).turnStoppedByUser).toBe(false);
    expect(doneState(true, {}).turnStoppedByUser).toBe(true);
  });
});

describe('private reply completion attribution', () => {
  it('projects private provenance into visible streaming and final replies', () => {
    const before = { ...EMPTY_SESSION_STATE } as SessionChatState;
    const streaming = handleStreamEvent(before, {
      sessionId: 'private', type: 'text', source: 'claude-code', persistId: 'reply',
      data: { text: 'Acknowledged', isFinal: false }, agentMeta: { botPrivateReply: true },
    });
    expect(streaming.messages.at(-1)?.botPrivateReply).toBe(true);
    const final = handleStreamEvent(streaming, {
      sessionId: 'private', type: 'text', source: 'claude-code', persistId: 'reply',
      data: { text: 'Acknowledged', isFinal: true }, agentMeta: { botPrivateReply: false },
    });
    expect(final.messages.at(-1)?.botPrivateReply).toBe(false);
  });

  it('captures private provenance before clearing turn metadata and leaves normal replies visible', () => {
    const before = { ...EMPTY_SESSION_STATE, lastAgentMeta: { botPrivateReply: true } } as SessionChatState;
    const after = handleStreamEvent(before, {
      sessionId: 'private', type: 'done', source: 'claude-code', data: {},
    });
    expect(after.lastAgentMeta).toBeNull();
    expect(after.lastStopWasPrivateReply).toBe(true);
    const normal = handleStreamEvent({ ...before, lastAgentMeta: null }, {
      sessionId: 'private', type: 'done', source: 'claude-code', data: {},
    });
    expect(normal.lastStopWasPrivateReply).toBe(false);
  });
});
