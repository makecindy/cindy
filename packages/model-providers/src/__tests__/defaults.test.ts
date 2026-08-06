import { describe, expect, it } from 'vitest';

import { resolveDefaultModel } from '../defaults.js';
import type { Catalog, Provider } from '../types.js';

function provider(id: string, defaults?: Provider['defaults']): Provider {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['claude-code', 'codex'],
    auth: { method: 'none' },
    routing: {},
    defaults,
    models: {},
  };
}

describe('resolveDefaultModel', () => {
  it('prefers catalog-wide defaults over provider defaults', () => {
    const catalog: Catalog = {
      version: '3',
      defaults: { codex: { sessionModel: 'catalog-codex' } },
      providers: [provider('openai', { codex: { sessionModel: 'provider-codex' } })],
    };

    expect(resolveDefaultModel(catalog, 'codex', 'session', 'fallback-codex'))
      .toBe('catalog-codex');
  });

  it('uses the first provider default in catalog order when the top-level field is absent', () => {
    const catalog: Catalog = {
      version: '3',
      providers: [
        provider('first', { 'claude-code': { oneShotModel: 'provider-one-shot' } }),
        provider('second', { 'claude-code': { oneShotModel: 'later-one-shot' } }),
      ],
    };

    expect(resolveDefaultModel(catalog, 'claude-code', 'oneShot', 'fallback-one-shot'))
      .toBe('provider-one-shot');
  });

  it('accepts provider views and returns the caller fallback when metadata is missing', () => {
    expect(resolveDefaultModel([provider('none')], 'codex', 'title', 'fallback-title'))
      .toBe('fallback-title');
  });

  it('skips providers that do not support the requested agent', () => {
    const wrongAgent = provider('claude-only', { codex: { sessionModel: 'wrong' } });
    wrongAgent.agents = ['claude-code'];
    const correctAgent = provider('codex', { codex: { sessionModel: 'right' } });

    expect(resolveDefaultModel([wrongAgent, correctAgent], 'codex', 'session', 'fallback'))
      .toBe('right');
  });
});
