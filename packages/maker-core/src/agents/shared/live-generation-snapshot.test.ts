import { describe, expect, it } from 'vitest';

import { attachLiveGeneration } from './live-generation-snapshot.js';

const base = {
  tokenUsage: 120,
  contextTokens: 100,
  contextWindow: 200_000,
  costUsd: 0,
};

describe('attachLiveGeneration', () => {
  it('includes output tokens even when timing is unreliable', () => {
    expect(
      attachLiveGeneration(base, {
        outputTokens: 40,
        closedDurationMs: 1_000,
        openStartedAt: 10_000,
        reliable: false,
      }),
    ).toEqual({
      ...base,
      outputTokens: 40,
      generationReliable: false,
      generationActive: false,
    });
  });

  it('adds closed duration plus the open interval', () => {
    expect(
      attachLiveGeneration(base, {
        outputTokens: 50,
        closedDurationMs: 1_000,
        openStartedAt: 8_000,
        reliable: true,
        now: 8_250,
      }),
    ).toEqual({
      ...base,
      outputTokens: 50,
      generationReliable: true,
      generationActive: true,
      generationDurationMs: 1_250,
    });
  });

  it('omits duration when nothing has been generated yet', () => {
    expect(
      attachLiveGeneration(base, {
        outputTokens: 0,
        closedDurationMs: 0,
        openStartedAt: 5_000,
        reliable: true,
        now: 5_000,
      }),
    ).toEqual({
      ...base,
      outputTokens: 0,
      generationReliable: true,
      generationActive: true,
    });
  });
});
