import { describe, expect, it } from 'vitest';
import { decodeRemoteAuxiliaryModelRef, encodeRemoteAuxiliaryModelRef, isRemoteAuxiliaryModelRef } from '../remoteAuxiliaryModelRef.js';
import { encodeCatalogModelPin } from '../catalogModelPin.js';
import { normalizeAuxiliaryModelList } from '../auxiliaryModelSettings.js';

import {
  AUTO_AUXILIARY_MODEL_CHAIN,
  AUTO_AUXILIARY_MODEL_CHAIN_I18N_KEYS,
  parseAuxiliaryModelRef,
} from '../auxiliaryModelChain.js';

describe('AUTO_AUXILIARY_MODEL_CHAIN', () => {
  it('is the frozen cross-tenant chain, never a live price ranking', () => {
    expect(AUTO_AUXILIARY_MODEL_CHAIN).toEqual([
      'cat:xd:codex:deepseek/deepseek-v4-flash',
      'cat:xd:codex:tencent/hy3',
      'cat:xd:codex:qwen/qwen3.8-flash',
    ]);
    expect(AUTO_AUXILIARY_MODEL_CHAIN_I18N_KEYS).toHaveLength(AUTO_AUXILIARY_MODEL_CHAIN.length);

  });

  // Unit: the old catalog container must preserve the device identity and unknown versions.
  it('round trips remote identities without losing unavailable future versions', () => {
    const route = { deviceId: 'device-a', providerId: 'same/provider', agentKind: 'pi' as const, model: 'model:1' };
    const pin = encodeRemoteAuxiliaryModelRef(route);
    expect(decodeRemoteAuxiliaryModelRef(pin)).toEqual(route);
    expect(normalizeAuxiliaryModelList([pin])).toEqual([pin]);
    const future = encodeCatalogModelPin({ providerId: 'cindy-remote-aux://v2/device-a/provider', agentKind: 'pi', model: 'm' });
    expect(isRemoteAuxiliaryModelRef(future)).toBe(true);
    expect(decodeRemoteAuxiliaryModelRef(future)).toBeNull();
    expect(normalizeAuxiliaryModelList([future])).toEqual([future]);
    expect(() => encodeRemoteAuxiliaryModelRef({ ...route, deviceId: 'share:foreign' })).toThrow();
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
