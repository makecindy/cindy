import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/makerTransport', () => ({
  makerApiFor: () => ({ input: { stop: vi.fn(async () => ({ queue: [], paused: false })) } }),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import type { ResponseSpeedSnapshot } from '@cindy/maker-shared/usage-format';

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
    responseSpeed?: ResponseSpeedSnapshot;
  },
): void {
  makerChatStore.__applyStatusUpdateForTest(sessionId, {
    sessionId,
    status: partial.status ?? (partial.isRunning ? 'Working' : 'Done'),
    tokenUsage: partial.tokenUsage ?? 0,
    contextTokens: 0,
    contextWindow: 0,
    isRunning: partial.isRunning,
    ...(partial.responseSpeed ? { responseSpeed: partial.responseSpeed } : {}),
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
  });
}

describe('makerChatStore live generation at turn start', () => {
  it('retains an interrupted measurement across stop and task switching, then resets on the next turn', () => {
    const sessionId = `live-gen-stop-${Math.random().toString(36).slice(2, 8)}`;
    const speed: ResponseSpeedSnapshot = { phase: 'generating', waitOrigin: 'turn', firstResponseMs: 1000,
      waitingMs: 0, outputTokens: 50, durationMs: 2000, estimated: true, recentRate: 30,
      averageRate: 25, samples: [{ durationMs: 2000, outputTokens: 50, rate: 30 }], sampledAt: Date.now() };
    try {
      applyStatus(sessionId, { isRunning: true, responseSpeed: speed });
      makerChatStore.stopSession(sessionId);
      makerChatStore.getSnapshot('another-task');
      expect(makerChatStore.getSnapshot(sessionId).agentStatus).toMatchObject({
        isRunning: false, generationActive: false,
        responseSpeed: { phase: 'complete', estimated: true, recentRate: null, outcome: 'cancelled', samples: speed.samples },
      });
      applyStatus(sessionId, { isRunning: true });
      expect(makerChatStore.getSnapshot(sessionId).agentStatus.responseSpeed).toBeUndefined();
    } finally {
      makerChatStore.purgeSession(sessionId);
      makerChatStore.purgeSession('another-task');
    }
  });
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
});

it('keeps a response speed failure through done/status tails and uses only actual retry events', () => {
  const id = 'speed-error-retry-lifecycle';
  const speed: ResponseSpeedSnapshot = { phase: 'generating', waitOrigin: 'turn', firstResponseMs: 1000,
    waitingMs: 0, outputTokens: 50, durationMs: 2000, estimated: true, recentRate: 30,
    averageRate: 25, samples: [{ durationMs: 2000, outputTokens: 50, rate: 30 }], sampledAt: Date.now() };
  const event = (type: 'error' | 'done' | 'text', data: Record<string, unknown>) =>
    makerChatStore.__applyStreamEventForTest(id, { sessionId: id, type, source: 'pi', data });
  try {
    applyStatus(id, { isRunning: true, responseSpeed: speed });
    event('error', { message: 'API unavailable', reason: 'api-error', isTerminal: false });
    expect(makerChatStore.getSnapshot(id).agentStatus.responseSpeed?.retrying).not.toBe(true);
    event('error', { message: 'API unavailable; retrying', reason: 'api-error', willRetry: true, isTerminal: false });
    expect(makerChatStore.getSnapshot(id).agentStatus.responseSpeed).toMatchObject({ retrying: true, recentRate: null });
    applyStatus(id, { isRunning: true, responseSpeed: speed });
    expect(makerChatStore.getSnapshot(id).agentStatus.responseSpeed?.retrying).toBe(true);
    event('text', { text: 'recovered', isFinal: false });
    expect(makerChatStore.getSnapshot(id).agentStatus.responseSpeed?.retrying).toBe(false);
    event('error', { message: 'API unavailable', reason: 'api-error', isTerminal: true });
    expect(makerChatStore.getSnapshot(id)).toMatchObject({ error: 'API unavailable', errorReason: 'api-error',
      agentStatus: { isRunning: false, responseSpeed: { phase: 'complete', outcome: 'failed', recentRate: null, samples: speed.samples } } });
    event('done', {});
    applyStatus(id, { isRunning: false, responseSpeed: { ...speed, phase: 'complete', estimated: false } });
    expect(makerChatStore.getSnapshot(id).agentStatus.responseSpeed?.outcome).toBe('failed');
    applyStatus(id, { isRunning: true });
    expect(makerChatStore.getSnapshot(id).agentStatus.responseSpeed).toBeUndefined();
    applyStatus(id, { isRunning: true, responseSpeed: speed });
    event('done', { type: 'pi/agent_settled', status: 'cancelled' });
    expect(makerChatStore.getSnapshot(id)).toMatchObject({ error: null,
      agentStatus: { responseSpeed: { outcome: 'cancelled', recentRate: null } } });
  } finally { makerChatStore.purgeSession(id); }
});
