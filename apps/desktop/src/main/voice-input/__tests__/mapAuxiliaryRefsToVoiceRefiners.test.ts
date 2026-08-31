import { describe, expect, it, vi } from 'vitest';

const activeCatalog = {
  providers: [
    {
      id: 'openai',
      source: 'builtin',
      agents: ['codex'],
      models: {
        codex: [
          { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', contextWindow: 272_000 },
        ],
      },
    },
    {
      id: 'xd',
      source: 'builtin',
      agents: ['codex'],
      models: {
        codex: [
          { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 272_000 },
          { id: 'tencent/hy3', name: 'Hy3', contextWindow: 272_000 },
          { id: 'qwen/qwen3.8-flash', name: 'Qwen3.8 Flash', contextWindow: 272_000 },
          { id: 'disabled-model', name: 'Disabled', contextWindow: 272_000, disabled: true },
          { id: 'paid-model', name: 'Paid', contextWindow: 272_000, availability: 'requires_payment' },
        ],
      },
    },
  ],
};

vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => activeCatalog,
}));

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

  it('skips catalog pins that are no longer active or selectable', () => {
    expect(mapAuxiliaryRefToVoiceRefiner('cat:openai:codex:gpt-5.4-mini')).toBe(
      'cat:openai:codex:gpt-5.4-mini',
    );
    expect(mapAuxiliaryRefToVoiceRefiner('cat:xd:codex:missing-model')).toBeNull();
    expect(mapAuxiliaryRefToVoiceRefiner('cat:xd:codex:disabled-model')).toBeNull();
    expect(mapAuxiliaryRefToVoiceRefiner('cat:xd:codex:paid-model')).toBeNull();
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
