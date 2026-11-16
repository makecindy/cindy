import { afterEach, describe, expect, it, vi } from 'vitest';

import { makerChatStore } from '@/lib/makerChatStore';
import { sessionAlertEventId } from '@/hooks/useSessionRunningStatus';

function applyStatus(
  sessionId: string,
  partial: {
    isRunning: boolean;
    status?: string;
    tokenUsage?: number;
    outputTokens?: number;
    generationDurationMs?: number;
    generationActive?: boolean;
    generationReliable?: boolean;
    tokenSpeed?: unknown;
  },
): void {
  makerChatStore.__applyStatusUpdateForTest(sessionId, {
    sessionId,
    status: partial.status ?? (partial.isRunning ? 'Working' : 'Done'),
    tokenUsage: partial.tokenUsage ?? 0,
    contextTokens: 0,
    contextWindow: 0,
    isRunning: partial.isRunning,
    ...(partial.outputTokens !== undefined ? { outputTokens: partial.outputTokens } : {}),
    ...(partial.generationDurationMs !== undefined
      ? { generationDurationMs: partial.generationDurationMs }
      : {}),
    ...(partial.generationActive !== undefined
      ? { generationActive: partial.generationActive }
      : {}),
    ...(partial.generationReliable !== undefined
      ? { generationReliable: partial.generationReliable }
      : {}),
    ...(partial.tokenSpeed !== undefined
      ? { tokenSpeed: partial.tokenSpeed as never }
      : {}),
  });
}

describe('makerChatStore live generation at turn start', () => {
  it('keeps live fields when the first running status already carries them', () => {
    const sessionId = `live-gen-keep-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyStatus(sessionId, {
        isRunning: true,
        status: 'Generating...',
        tokenUsage: 235,
        outputTokens: 40,
        generationDurationMs: 800,
        generationActive: true,
        generationReliable: true,
      });
      expect(makerChatStore.getSnapshot(sessionId).agentStatus).toMatchObject({
        outputTokens: 40,
        generationDurationMs: 800,
        generationActive: true,
        generationReliable: true,
      });
    } finally {
      makerChatStore.purgeSession(sessionId);
    }
  });

  it('does not flash the previous turn live metrics on a bare turn start', () => {
    const sessionId = `live-gen-reset-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyStatus(sessionId, {
        isRunning: true,
        outputTokens: 99,
        generationDurationMs: 5_000,
        generationActive: true,
        generationReliable: false,
      });
      applyStatus(sessionId, { isRunning: false, status: 'Done' });
      applyStatus(sessionId, { isRunning: true, status: 'Working' });
      expect(makerChatStore.getSnapshot(sessionId).agentStatus).toMatchObject({
        outputTokens: 0,
        generationDurationMs: 0,
        generationActive: false,
        generationReliable: true,
      });
    } finally {
      makerChatStore.purgeSession(sessionId);
    }
  });

  it('keeps the host speed across statuses without it and drops it on the next turn', () => {
    const sessionId = `live-gen-speed-${Math.random().toString(36).slice(2, 8)}`;
    const tokenSpeed = { rate: 42, average: 40, tokens: 120, elapsedMs: 3_000, streaming: true };
    try {
      applyStatus(sessionId, { isRunning: true, status: 'Generating...', tokenSpeed });
      applyStatus(sessionId, { isRunning: true, status: 'Running tool' });
      expect(makerChatStore.getSnapshot(sessionId).agentStatus.tokenSpeed).toEqual(tokenSpeed);
      applyStatus(sessionId, { isRunning: true, tokenSpeed: { rate: 'fast' } });
      expect(makerChatStore.getSnapshot(sessionId).agentStatus.tokenSpeed).toEqual(tokenSpeed);
      // The host withdrew the speed (suspended mid-generation): the stale reading goes too.
      applyStatus(sessionId, { isRunning: true, generationReliable: false });
      expect(makerChatStore.getSnapshot(sessionId).agentStatus.tokenSpeed).toBeUndefined();
      applyStatus(sessionId, { isRunning: false, status: 'Done' });
      applyStatus(sessionId, { isRunning: true, status: 'Working' });
      expect(makerChatStore.getSnapshot(sessionId).agentStatus.tokenSpeed).toBeUndefined();
    } finally {
      makerChatStore.purgeSession(sessionId);
    }
  });
});

describe('makerChatStore turn clock used by alert ids', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // #9317 review / unit: lastStartedAt is the start clock of the turn that is
  // current. It used to survive the previous turn and get copied into the next
  // one, so two turns that each failed produced the same alert id and main
  // dropped the second toast. One turn keeps one clock; the next turn gets
  // another. The clock stays after the turn stops, which is what a following
  // error or needs-reply reads.
  it('gives consecutive turns different clocks and keeps one clock inside a turn', () => {
    const sessionId = `turn-clock-${Math.random().toString(36).slice(2, 8)}`;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z'));
      applyStatus(sessionId, { isRunning: true, status: 'Working' });
      applyStatus(sessionId, { isRunning: true, status: 'Still working' });
      const first = makerChatStore.getSnapshot(sessionId).agentStatus.lastStartedAt;
      makerChatStore.__applyStreamEventForTest(sessionId, {
        sessionId, type: 'error', data: { message: 'first boom', isTerminal: true },
      });
      const afterFirstFailure = makerChatStore.getSnapshot(sessionId).agentStatus.lastStartedAt;

      vi.setSystemTime(new Date('2026-11-01T00:05:00.000Z'));
      applyStatus(sessionId, { isRunning: true, status: 'Working' });
      const second = makerChatStore.getSnapshot(sessionId).agentStatus.lastStartedAt;
      makerChatStore.__applyStreamEventForTest(sessionId, {
        sessionId, type: 'error', data: { message: 'second boom', isTerminal: true },
      });
      const afterSecondFailure = makerChatStore.getSnapshot(sessionId).agentStatus.lastStartedAt;

      expect(first).toBe(afterFirstFailure);
      expect(second).toBe(afterSecondFailure);
      expect(second).not.toBe(first);
      expect(sessionAlertEventId('error', afterFirstFailure)).not.toBe(
        sessionAlertEventId('error', afterSecondFailure),
      );
    } finally {
      makerChatStore.purgeSession(sessionId);
    }
  });

  // #9575 review: the previous turn already failed and was alerted. The next
  // attempt never gets a running status frame, and its clock sample lands on
  // that same millisecond. Reusing the stamp rebuilds the alert id main already
  // saw, so the new failure must get its own clock.
  it('alerts a new failure after the previous turn was already alerted, even without a running frame', () => {
    const sessionId = `turn-clock-retry-${Math.random().toString(36).slice(2, 8)}`;
    vi.useFakeTimers();
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      applyStatus(sessionId, { isRunning: true, status: 'Working' });
      makerChatStore.__applyStreamEventForTest(sessionId, {
        sessionId, type: 'error', data: { message: 'first boom', isTerminal: true },
      });
      const alreadyAlerted = sessionAlertEventId(
        'error',
        makerChatStore.getSnapshot(sessionId).agentStatus.lastStartedAt,
      );
      expect(alreadyAlerted).toBe('turn:1000:error');

      // Same millisecond as the turn that was already alerted. Keeping that
      // stamp would rebuild `turn:1000:error` and main would drop the toast.
      now.mockReturnValue(1_000);
      makerChatStore.__applyStreamEventForTest(sessionId, {
        sessionId, type: 'error', data: { message: 'still trying', isTerminal: false },
      });
      const midAttempt = makerChatStore.getSnapshot(sessionId).agentStatus;
      expect(midAttempt.isRunning).toBe(true);
      expect(midAttempt.startedAt).toBe(1_001);

      now.mockReturnValue(1_400);
      makerChatStore.__applyStreamEventForTest(sessionId, {
        sessionId, type: 'error', data: { message: 'second boom', isTerminal: true },
      });
      const stopped = makerChatStore.getSnapshot(sessionId).agentStatus;
      expect(stopped.startedAt).toBeNull();
      expect(stopped.lastStartedAt).toBe(1_001);
      expect(sessionAlertEventId('error', stopped.lastStartedAt)).not.toBe(alreadyAlerted);
    } finally {
      now.mockRestore();
      makerChatStore.purgeSession(sessionId);
    }
  });
});
