import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  beginClaudeGeneration,
  finalizeClaudeGeneration,
  newClaudeGenerationState,
  pauseClaudeGeneration,
  resetClaudeGenerationTiming,
  resumeClaudeGeneration,
} from './generation-timing.js';

describe('claude generation timing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('excludes tool intervals from the generation denominator', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const state = newClaudeGenerationState();
    beginClaudeGeneration(state, 1_000);
    pauseClaudeGeneration(state, 'tool-1', 1_400);
    resumeClaudeGeneration(state, 'tool-1', 5_000);
    finalizeClaudeGeneration(state, 5_200);
    expect(state.reliable).toBe(true);
    expect(state.durationMs).toBe(600);
    expect(state.startedAt).toBeNull();
  });

  it('stops the heartbeat when the session is reset without a result event', () => {
    vi.useFakeTimers();
    try {
      const state = newClaudeGenerationState();
      beginClaudeGeneration(state, 1_000);
      expect(state.heartbeatTimer).not.toBeNull();
      resetClaudeGenerationTiming(state);
      expect(state.heartbeatTimer).toBeNull();
      expect(state.heartbeatAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
