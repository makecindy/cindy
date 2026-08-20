import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  beginClaudeGeneration,
  finalizeClaudeGeneration,
  newClaudeGenerationState,
  pauseClaudeGeneration,
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
});
