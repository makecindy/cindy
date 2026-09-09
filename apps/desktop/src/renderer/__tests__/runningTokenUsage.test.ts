import { describe, expect, it } from 'vitest';

import {
  formatLiveOutputTokenRate,
  formatRunningTokenCount,
  resolveRunningUsageMeta,
} from '@/features/cc-agent/lib/runningTokenUsage';

describe('formatRunningTokenCount', () => {
  it('keeps authoritative completed and positive usage values', () => {
    expect(formatRunningTokenCount(0)).toBe('0');
    expect(formatRunningTokenCount(999)).toBe('999');
    expect(formatRunningTokenCount(1250)).toBe('1.3k');
  });
});

describe('formatLiveOutputTokenRate', () => {
  it('reuses the post-turn TPS formatter', () => {
    expect(formatLiveOutputTokenRate(235, 8_954, true)).toBe('26.2');
  });

  it('hides the rate when timing is unreliable', () => {
    expect(formatLiveOutputTokenRate(235, 8_954, false)).toBeNull();
  });
});

describe('resolveRunningUsageMeta', () => {
  it('shows rate when output and generation duration are both proven', () => {
    expect(
      resolveRunningUsageMeta({
        outputTokens: 235,
        generationDurationMs: 8_954,
        generationReliable: true,
        tokenUsage: 400,
      }),
    ).toEqual({ kind: 'rate', rate: '26.2' });
  });

  it('falls back to cumulative tokens once usage exists', () => {
    expect(
      resolveRunningUsageMeta({
        outputTokens: 0,
        generationDurationMs: 1_200,
        generationReliable: true,
        tokenUsage: 84_400,
      }),
    ).toEqual({ kind: 'tokens' });
  });

  it('falls back to cumulative tokens when timing is unreliable', () => {
    expect(
      resolveRunningUsageMeta({
        outputTokens: 235,
        generationDurationMs: 8_954,
        generationReliable: false,
        tokenUsage: 400,
      }),
    ).toEqual({ kind: 'tokens' });
  });

  it('hides the usage slot before any rate or tokens exist', () => {
    expect(
      resolveRunningUsageMeta({
        outputTokens: 0,
        generationDurationMs: 1_200,
        generationReliable: true,
        tokenUsage: 0,
      }),
    ).toEqual({ kind: 'none' });
  });
});
