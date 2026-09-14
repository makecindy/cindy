import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AUTO_AUXILIARY_MODEL_CHAIN,
  AUTO_AUXILIARY_MODEL_CHAIN_I18N_KEYS,
  parseAuxiliaryModelRef,
} from '../auxiliaryModelChain.js';

const SOURCE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../auxiliaryModelChain.ts',
);

describe('AUTO_AUXILIARY_MODEL_CHAIN', () => {
  it('is the frozen cross-tenant chain, never a live price ranking', () => {
    expect(AUTO_AUXILIARY_MODEL_CHAIN).toEqual([
      'cat:xd:codex:deepseek/deepseek-v4-flash',
      'cat:xd:codex:tencent/hy3',
      'cat:xd:codex:qwen/qwen3.8-flash',
    ]);
    expect(AUTO_AUXILIARY_MODEL_CHAIN_I18N_KEYS).toHaveLength(AUTO_AUXILIARY_MODEL_CHAIN.length);

    const source = readFileSync(SOURCE_PATH, 'utf8');
    expect(source).not.toMatch(/\bsort\s*\(/);
    expect(source).not.toMatch(/price/i);
    expect(source).not.toMatch(/cheapest/i);
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
