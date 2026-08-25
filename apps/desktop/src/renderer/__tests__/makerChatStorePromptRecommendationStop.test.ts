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
