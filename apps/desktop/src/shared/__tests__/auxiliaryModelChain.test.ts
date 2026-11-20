import { describe, expect, it } from 'vitest';
import { encodeCatalogModelPin, decodeCatalogModelPin } from '../catalogModelPin.js';
import { normalizeAuxiliaryModelList } from '../auxiliaryModelSettings.js';

import {
  AUTO_AUXILIARY_MODEL_CHAIN,
  AUTO_AUXILIARY_MODEL_CHAIN_I18N_KEYS,
  parseAuxiliaryModelRef,
} from '../auxiliaryModelChain.js';

describe('AUTO_AUXILIARY_MODEL_CHAIN', () => {
  // Unit: actual settings parser; remote pins must never become a local same-name source.
  it('round-trips remote/share identity through settings while preserving old local pins', () => {
    const route = { providerId: 'subscription:one', agentKind: 'codex' as const, model: 'model:variant', agentDeviceId: 'share:account:source' };
    const remote = encodeCatalogModelPin(route);
    const local = encodeCatalogModelPin({ ...route, agentDeviceId: undefined });
    expect(normalizeAuxiliaryModelList([remote, local])).toEqual([remote, local]);
    expect(decodeCatalogModelPin(remote)).toEqual(route);
    expect(parseAuxiliaryModelRef(remote)).toEqual({ kind: 'catalog', route });
    expect(decodeCatalogModelPin('remote-cat:%ZZ:cat:openai:codex:model')).toBeNull();
    expect(decodeCatalogModelPin('remote-cat:device:remote-cat:other:cat:openai:codex:model')).toBeNull();
  });
  it('is the frozen cross-tenant chain, never a live price ranking', () => {
    expect(AUTO_AUXILIARY_MODEL_CHAIN).toEqual([
      'cat:xd:codex:deepseek/deepseek-v4-flash',
      'cat:xd:codex:tencent/hy3',
      'cat:xd:codex:qwen/qwen3.8-flash',
    ]);
    expect(AUTO_AUXILIARY_MODEL_CHAIN_I18N_KEYS).toHaveLength(AUTO_AUXILIARY_MODEL_CHAIN.length);

  });

  it('parses profile keys and catalog pins', () => {
    expect(parseAuxiliaryModelRef('cat:xd:codex:deepseek/deepseek-v4-flash')).toEqual({
      kind: 'catalog',
      route: {
        providerId: 'xd',
        agentKind: 'codex',
        model: 'deepseek/deepseek-v4-flash',
      },
    });
    expect(parseAuxiliaryModelRef('codex-gpt-5.4-mini')).toEqual({
      kind: 'profile',
      id: 'codex-gpt-5.4-mini',
    });
    expect(parseAuxiliaryModelRef('cat:anthropic:claude-code:claude-haiku-4-5')).toEqual({
      kind: 'catalog',
      route: {
        providerId: 'anthropic',
        agentKind: 'claude-code',
        model: 'claude-haiku-4-5',
      },
    });
    expect(parseAuxiliaryModelRef('not-a-model')).toBeNull();
  });
});
