import { describe, expect, it } from 'vitest';

import { BUNDLED_CATALOG, type Catalog } from '@cindy/model-providers';

import { buildOneShotOptions } from '../help.js';

const EMPTY_CATALOG: Catalog = { version: '3', providers: [] };

describe('buildOneShotOptions catalog defaults', () => {
  it('reads one-shot defaults from catalog metadata', () => {
    const catalog: Catalog = {
      ...EMPTY_CATALOG,
      defaults: {
        'claude-code': { oneShotModel: 'catalog-claude-one-shot' },
        codex: { oneShotModel: 'catalog-codex-one-shot' },
      },
    };

    expect(buildOneShotOptions('claude-code', catalog)).toMatchObject({
      model: 'catalog-claude-one-shot',
      maxTokens: 220,
    });
    expect(buildOneShotOptions('codex', catalog)).toMatchObject({
      model: 'catalog-codex-one-shot',
    });
  });

  it('preserves the previous hardcoded defaults when catalog metadata is missing', () => {
    expect(buildOneShotOptions('claude-code', EMPTY_CATALOG).model).toBe('claude-haiku-4-5');
    expect(buildOneShotOptions('codex', EMPTY_CATALOG).model).toBe('gpt-5.4-mini');
  });

  it('does not route native Codex help through an earlier provider bridge default', () => {
    const catalog: Catalog = {
      ...EMPTY_CATALOG,
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          source: 'builtin',
          agents: ['codex'],
          auth: { method: 'apiKey' },
          routing: {
            codex: {
              upstream: 'https://api.anthropic.com',
              authStrategy: 'api-key-header',
            },
          },
          models: { codex: [] },
          defaults: { codex: { oneShotModel: 'claude-haiku-4-5' } },
        },
      ],
    };

    expect(buildOneShotOptions('codex', catalog).model).toBe('gpt-5.4-mini');
  });

  it('keeps bundled Codex help on GPT while Claude Code uses Haiku', () => {
    expect(buildOneShotOptions('codex', BUNDLED_CATALOG).model).toBe('gpt-5.4-mini');
    expect(buildOneShotOptions('claude-code', BUNDLED_CATALOG).model).toBe('claude-haiku-4-5');
  });
});
