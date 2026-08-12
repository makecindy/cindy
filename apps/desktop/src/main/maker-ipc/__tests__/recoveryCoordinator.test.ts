import { describe, expect, it } from 'vitest';

import {
  appendRecoveryCheckpointPrompt,
  buildRecoveryCheckpoint,
  decideRecoveryMode,
} from '../recoveryCoordinator.js';

describe('recoveryCoordinator', () => {
  it('keeps a first low-context recovery fast', () => {
    expect(
      decideRecoveryMode({
        contextTokens: 40_000,
        contextWindow: 200_000,
        previousAttempt: 0,
        progressCount: 4,
      }),
    ).toBe('fast');
  });

  it('switches to a checkpoint before the vendor compaction boundary', () => {
    expect(
      decideRecoveryMode({
        contextTokens: 145_000,
        contextWindow: 200_000,
        previousAttempt: 0,
        progressCount: 1,
      }),
    ).toBe('checkpoint');
  });

  it('uses the same stateful path for manual and automatic retries', () => {
    const snapshot = {
      contextTokens: 10_000,
      contextWindow: 200_000,
      progressCount: 3,
      recentProgress: [{ role: 'tool_use' as const, summary: 'tool check' }],
    };
    const manual = buildRecoveryCheckpoint('manual', 'failed-1', undefined, snapshot);
    const automatic = buildRecoveryCheckpoint('automatic', 'failed-1', undefined, snapshot);

    expect(manual.mode).toBe(automatic.mode);
    expect(manual.attempt).toBe(automatic.attempt);
    expect(manual.source).toBe('manual');
    expect(automatic.source).toBe('automatic');
  });

  it('adds a bounded handoff only in checkpoint mode', () => {
    const checkpoint = buildRecoveryCheckpoint('manual', 'failed-1', undefined, {
      contextTokens: 180_000,
      contextWindow: 200_000,
      progressCount: 2,
      recentProgress: [{ role: 'assistant', summary: 'finished the file write' }],
    });
    const prompt = appendRecoveryCheckpointPrompt('[UI_ACTION_TRIGGER] continue', checkpoint);

    expect(checkpoint.mode).toBe('checkpoint');
    expect(prompt).toContain('[CINDY_RECOVERY_CHECKPOINT v1]');
    expect(prompt).toContain('finished the file write');
    expect(
      appendRecoveryCheckpointPrompt('[UI_ACTION_TRIGGER] continue', {
        ...checkpoint,
        mode: 'fast',
      }),
    ).toBe('[UI_ACTION_TRIGGER] continue');
  });
});
