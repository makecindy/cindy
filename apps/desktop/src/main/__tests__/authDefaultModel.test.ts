import { describe, expect, it } from 'vitest';

import type { Catalog } from '@cindy/model-providers';

import { defaultAuthModel } from '../authDefaultModel.js';

describe('defaultAuthModel', () => {
  it('reads the catalog session default', () => {
    const catalog: Catalog = {
      version: '3',
      providers: [],
      defaults: { 'claude-code': { sessionModel: 'catalog-auth-model' } },
    };
    expect(defaultAuthModel(catalog)).toBe('catalog-auth-model');
  });

  it('retains the historical auth fallback when metadata is missing', () => {
    expect(defaultAuthModel({ providers: [] })).toBe('claude-sonnet-4-6');
  });
});
