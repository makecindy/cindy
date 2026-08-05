import { describe, expect, it } from 'vitest';

import type { Catalog, CatalogModel, Provider } from '@cindy/model-providers';

import { deriveAvailableModels } from '../catalog-to-descriptors.js';
import {
  filterProviderCatalogForAccount,
  isProviderSelectable,
  projectProviderCatalogForBuildRegion,
} from '../provider-access-policy.js';

function model(id: string): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    efforts: [],
    defaultEffort: null,
  };
}

function provider(id: string, models: CatalogModel[]): Provider {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: id === 'xd' ? 'managed' : 'oauth' },
    routing: {},
    models: { 'claude-code': models },
  };
}

function catalog(): Catalog {
  const xd = provider('xd', [
    model('shared-model'),
    model('xd-only-model'),
    { ...model('gpt-image-2'), group: 'image' },
    { ...model('seedance-fast'), group: 'video' },
    { ...model('seedance-pro'), group: 'video' },
    { ...model('happyhorse'), group: 'video' },
  ]);
  xd.imageModels = [
    { id: 'gpt-image-2', name: 'GPT Image 2' },
    { id: 'gemini-image', name: 'Gemini Image' },
  ];
  xd.imageDefaults = { standard: 'gpt-image-2', draft: 'gemini-image' };
  xd.videoModels = [
    { id: 'seedance-fast', name: 'Seedance Fast' },
    { id: 'seedance-pro', name: 'Seedance Pro' },
    { id: 'happyhorse', name: 'HappyHorse' },
  ];
  xd.videoDefaults = {
    standard: 'seedance-fast',
    draft: 'happyhorse',
    best: 'seedance-pro',
  };
  return {
    version: 'test',
    providers: [
      provider('anthropic', [model('shared-model')]),
      xd,
    ],
  };
}

describe('provider access policy', () => {
  it('hides Cindy AI only for account-free local sessions', () => {
    expect(isProviderSelectable('xd', { canUseCindyGateway: false })).toBe(false);
    expect(isProviderSelectable('xd', { canUseCindyGateway: true })).toBe(true);
    expect(isProviderSelectable('xd', {})).toBe(true);
    expect(isProviderSelectable('anthropic', { canUseCindyGateway: false })).toBe(true);
  });

  it('removes the provider and its exclusive models from account-free capabilities', () => {
    const filtered = filterProviderCatalogForAccount(catalog(), { canUseCindyGateway: false });

    expect(filtered.providers.map((item) => item.id)).toEqual(['anthropic']);
    expect(deriveAvailableModels(filtered, 'claude-code').map((item) => item.id)).toEqual([
      'shared-model',
    ]);
  });

  it('preserves the original catalog for every Cindy account session', () => {
    const input = catalog();
    expect(filterProviderCatalogForAccount(input, { canUseCindyGateway: true })).toBe(input);
    expect(filterProviderCatalogForAccount(input, {})).toBe(input);
  });

  it('preserves the full media catalog and object identity for Global', () => {
    const input = catalog();
    expect(projectProviderCatalogForBuildRegion(input, 'global')).toBe(input);
  });

  it.each(['cn', 'dev'] as const)(
    'projects the Cindy AI media catalog to Mainland capabilities for %s',
    (region) => {
      const projected = projectProviderCatalogForBuildRegion(catalog(), region);
      const xd = projected.providers.find((item) => item.id === 'xd');

      expect(xd?.imageModels).toEqual([]);
      expect(xd?.imageDefaults).toBeUndefined();
      expect(xd?.videoModels?.map((item) => item.id)).toEqual([
        'seedance-fast',
        'seedance-pro',
      ]);
      expect(xd?.videoDefaults).toEqual({
        standard: 'seedance-fast',
        best: 'seedance-pro',
      });
      expect(xd?.models['claude-code']?.map((item) => item.id)).toEqual([
        'shared-model',
        'xd-only-model',
        'seedance-fast',
        'seedance-pro',
      ]);
    },
  );
});
