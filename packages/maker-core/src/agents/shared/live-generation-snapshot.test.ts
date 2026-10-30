import { describe, expect, it, vi } from 'vitest';

import { attachLiveGeneration, sampleGenerationDuration } from './live-generation-snapshot.js';

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
        durationMs: 1_000,
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

  it('captures closed duration plus the open interval when usage arrives', () => {
    expect(
      attachLiveGeneration(base, {
        outputTokens: 50,
        durationMs: sampleGenerationDuration(1_000, 8_000, 8_250),
        openStartedAt: 8_000,
        reliable: true,
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
        durationMs: 0,
        openStartedAt: 5_000,
        reliable: true,
      }),
    ).toEqual({
      ...base,
      outputTokens: 0,
      generationReliable: true,
      generationActive: true,
    });
  });

  it('retains the paired usage duration while a later request is in flight', () => {
    const timing = {
      outputTokens: 100,
      durationMs: 1_000,
      openStartedAt: 8_000,
      reliable: true,
    };
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      for (const now of [8_000, 12_000, 18_000]) {
        nowSpy.mockReturnValue(now);
        expect(attachLiveGeneration(base, timing)).toMatchObject({
          outputTokens: 100,
          generationDurationMs: 1_000,
          generationActive: true,
        });
      }
    } finally {
      nowSpy.mockRestore();
    }
  });
});
