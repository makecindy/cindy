import { describe, expect, it } from 'vitest';
import { createUsageArtifact, USAGE_SCHEMA_VERSION } from './usage.js';

describe('usage artifact schema', () => {
  it('keeps provider usage and session snapshot separate', () => {
    const artifact = createUsageArtifact({
      rawProviderUsage: { input_tokens: 3 },
      normalizedUsage: { inputTokens: 3, cacheReadTokens: 10, cacheCreationTokens: 5, outputTokens: 7, costUsd: 0.25 },
      sessionSnapshot: { tokenUsage: 20, contextTokens: 18, contextWindow: 1000, costUsd: 0.25 },
    });
    expect(artifact.schemaVersion).toBe(USAGE_SCHEMA_VERSION);
    expect(artifact.usageStatus).toBe('COMPLETE');
    expect(artifact.usageCompleteness).toBe('exact');
    expect(artifact.normalizedUsage).toEqual({ inputTokens: 3, cacheReadTokens: 10, cacheCreationTokens: 5, outputTokens: 7, costUsd: 0.25 });
    expect(artifact.sessionSnapshot.contextTokens).toBe(18);
  });

  it('records incomplete usage without turning it into a precise zero', () => {
    const artifact = createUsageArtifact({
      rawProviderUsage: null,
      normalizedUsage: { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, costUsd: 0 },
      sessionSnapshot: { tokenUsage: 128, contextTokens: 128, contextWindow: 1000, costUsd: 0 },
      usageStatus: 'PARTIAL',
      usageSource: ['session-snapshot'],
      missingFields: ['inputTokens', 'outputTokens', 'costUsd'],
      termination: 'HEADLESS_DEADLINE',
      observedTokenTotal: 128,
    });
    expect(artifact.usageStatus).toBe('PARTIAL');
    expect(artifact.usageCompleteness).toBe('lower-bound');
    expect(artifact.observedTokenTotal).toBe(128);
    expect(artifact.missingFields).toContain('costUsd');
  });
});
