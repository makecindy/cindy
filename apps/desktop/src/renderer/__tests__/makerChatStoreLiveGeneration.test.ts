import { describe, expect, it } from 'vitest';

import { makerChatStore } from '@/lib/makerChatStore';

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
