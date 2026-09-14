import type { PiNativeModelSpec } from '@cindy/maker-core';

import { isCuratedQwen38Tag } from '../../shared/localModelRuntime.js';

export const QWEN38_THINKING_SAMPLING = {
  temperature: 1,
  top_p: 0.95,
  top_k: 20,
  min_p: 0,
  presence_penalty: 0,
} as const;

export function shouldApplyQwen38Overlay(modelId: string): boolean {
  return isCuratedQwen38Tag(modelId);
}

export function applyQwen38NativeOverlay(model: PiNativeModelSpec): PiNativeModelSpec {
  const contextWindow =
    model.contextWindow && model.contextWindow > 0 ? model.contextWindow : 32_768;
  const maxTokens = Math.max(1, Math.min(16_000, contextWindow - 1));
  return {
    ...model,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: {
      off: 'off',
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: 'xhigh',
      max: null,
    },
    contextWindow,
    maxTokens,
    compat: {
      ...(model.compat ?? {}),
      thinkingFormat: 'qwen-chat-template',
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
    samplingParams: { ...QWEN38_THINKING_SAMPLING },
  };
}
