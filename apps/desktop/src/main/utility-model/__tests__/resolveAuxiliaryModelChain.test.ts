import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  models: [] as string[],
}));

vi.mock('../auxiliary-model-settings-store.js', () => ({
  readAuxiliaryModelSettings: () => ({ models: h.models }),
  isAuxiliaryModelCustomized: () => h.models.length > 0,
}));

import { AUTO_AUXILIARY_MODEL_CHAIN } from '../../../shared/auxiliaryModelChain.js';
import { getEffectiveAuxiliaryModelChain } from '../resolveAuxiliaryModelChain.js';

const ENV_KEYS = [
  'XDT_UTILITY_MODEL_PROVIDER_CHAIN',
  'XDT_UTILITY_MODEL_PROVIDER',
  'XDT_UTILITY_MODEL',
  'XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN',
  'XDT_VOICE_INPUT_REFINER_PROVIDER',
  'XDT_VOICE_INPUT_REFINER_MODEL',
] as const;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
}

describe('getEffectiveAuxiliaryModelChain', () => {
  beforeEach(() => {
    h.models = [];
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('returns the frozen automatic chain when nothing is customized', () => {
    expect(getEffectiveAuxiliaryModelChain()).toEqual({
      source: 'auto',
      refs: [...AUTO_AUXILIARY_MODEL_CHAIN],
    });
  });

  it('uses the user custom list and never falls back to auto or env', () => {
    h.models = ['litellm-kimi-k2.6', 'codex-gpt-5.4-mini'];
    vi.stubEnv('XDT_UTILITY_MODEL_PROVIDER_CHAIN', 'litellm-gpt-5.4-mini,litellm-deepseek-v4-flash');

    expect(getEffectiveAuxiliaryModelChain()).toEqual({
      source: 'custom',
      refs: ['litellm-kimi-k2.6', 'codex-gpt-5.4-mini'],
    });
  });

  it('uses the env escape hatch only in automatic mode', () => {
    vi.stubEnv('XDT_UTILITY_MODEL_PROVIDER', 'kimi-k2.6');
    vi.stubEnv('XDT_UTILITY_MODEL_PROVIDER_CHAIN', 'litellm-gpt-5.4-mini,litellm-kimi-k2.6');

    expect(getEffectiveAuxiliaryModelChain()).toEqual({
      source: 'env',
      refs: ['litellm-kimi-k2.6', 'litellm-gpt-5.4-mini'],
    });
  });

  it('keeps legacy voice refiner env vars and model overrides working', () => {
    vi.stubEnv('XDT_VOICE_INPUT_REFINER_PROVIDER', 'litellm');
    vi.stubEnv('XDT_VOICE_INPUT_REFINER_MODEL', 'qwen/qwen3.6-plus');
    vi.stubEnv('XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN', 'litellm-deepseek-v4-flash');

    expect(getEffectiveAuxiliaryModelChain()).toEqual({
      source: 'env',
      refs: ['litellm-qwen3.6-plus', 'litellm-deepseek-v4-flash'],
    });
  });

  it('represents an unknown legacy model override as an exact catalog pin', () => {
    vi.stubEnv('XDT_UTILITY_MODEL_PROVIDER', 'litellm');
    vi.stubEnv('XDT_UTILITY_MODEL', 'qwen/qwen3.8-flash-local');

    expect(getEffectiveAuxiliaryModelChain()).toEqual({
      source: 'env',
      refs: ['cat:xd:codex:qwen/qwen3.8-flash-local'],
    });
  });
});
