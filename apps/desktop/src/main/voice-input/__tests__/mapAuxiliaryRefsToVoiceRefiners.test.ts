import { describe, expect, it } from 'vitest';

import {
  mapAuxiliaryRefToVoiceRefiner,
  mapAuxiliaryRefsToVoiceRefiners,
} from '../mapAuxiliaryRefsToVoiceRefiners.js';

describe('mapAuxiliaryRefsToVoiceRefiners', () => {
  it('maps profile keys 1:1 and skips Claude Messages catalog pins', () => {
    expect(mapAuxiliaryRefToVoiceRefiner('codex-gpt-5.4-mini')).toBe('codex-gpt-5.4-mini');
    expect(mapAuxiliaryRefToVoiceRefiner('litellm-kimi-k2.6')).toBe('litellm-kimi-k2.6');
    expect(mapAuxiliaryRefToVoiceRefiner('cat:anthropic:claude-code:claude-haiku-4-5')).toBeNull();
  });

  it('maps OpenAI and Cindy gateway catalog pins onto matching refiner transports', () => {
    expect(mapAuxiliaryRefToVoiceRefiner('cat:openai:codex:gpt-5.4-mini')).toBe(
      'cat:openai:codex:gpt-5.4-mini',
    );
    expect(mapAuxiliaryRefToVoiceRefiner('cat:xd:codex:deepseek/deepseek-v4-flash')).toBe(
      'cat:xd:codex:deepseek/deepseek-v4-flash',
    );
    expect(mapAuxiliaryRefToVoiceRefiner('cat:xd:codex:tencent/hy3')).toBe(
      'cat:xd:codex:tencent/hy3',
    );
    expect(mapAuxiliaryRefToVoiceRefiner('cat:xd:codex:qwen/qwen3.8-flash')).toBe(
      'cat:xd:codex:qwen/qwen3.8-flash',
    );
  });

  it('returns an empty chain when nothing in the list can refine speech', () => {
    expect(
      mapAuxiliaryRefsToVoiceRefiners([
        'cat:anthropic:claude-code:claude-haiku-4-5',
        'cat:anthropic:claude-code:claude-sonnet-4-6',
      ]),
    ).toEqual([]);
  });

  it('preserves order and drops unusable or duplicate refs', () => {
    expect(
      mapAuxiliaryRefsToVoiceRefiners([
        'cat:anthropic:claude-code:claude-haiku-4-5',
        'codex-gpt-5.4-mini',
        'cat:openai:codex:gpt-5.4-mini',
        'litellm-kimi-k2.6',
      ]),
    ).toEqual(['codex-gpt-5.4-mini', 'litellm-kimi-k2.6']);
  });
});
