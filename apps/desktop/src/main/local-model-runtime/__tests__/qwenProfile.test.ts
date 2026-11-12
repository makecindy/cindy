import { describe, expect, it } from 'vitest';

import { applyQwen38NativeOverlay, shouldApplyQwen38Overlay } from '../qwenProfile.js';

describe('qwenProfile', () => {
  it('only matches Cindy-verified Qwen3.8 tags', () => {
    expect(shouldApplyQwen38Overlay('qwen3.8:27b-mxfp8')).toBe(true);
    expect(shouldApplyQwen38Overlay('qwen3.8:27b-mlx')).toBe(true);
    expect(shouldApplyQwen38Overlay('qwen3.8:latest')).toBe(false);
    expect(shouldApplyQwen38Overlay('llama3.2')).toBe(false);
  });

  it('exposes a single thinking level and clamps maxTokens', () => {
    const overlay = applyQwen38NativeOverlay({
      id: 'qwen3.8:27b-mlx',
      contextWindow: 32_768,
    });
    expect(overlay.reasoning).toBe(true);
    expect(overlay.thinkingLevelMap).toMatchObject({
      off: 'off',
      low: null,
      medium: null,
      xhigh: 'xhigh',
    });
    expect(overlay.maxTokens).toBe(16_000);
    expect(applyQwen38NativeOverlay({ id: 'qwen3.8:27b-mlx', contextWindow: 2048 }).maxTokens).toBe(
      2047,
    );
    expect(overlay.samplingParams).toMatchObject({ temperature: 1, top_p: 0.95 });
    expect(overlay.compat).toMatchObject({ thinkingFormat: 'qwen-chat-template' });
  });
});
