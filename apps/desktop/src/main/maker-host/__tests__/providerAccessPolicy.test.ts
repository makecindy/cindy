import { describe, expect, it } from 'vitest';

import type { Catalog, CatalogModel, Provider } from '@cindy/model-providers';

import { deriveAvailableModels } from '../catalog-to-descriptors.js';
import {
  filterProviderCatalogForAccount,
  isProviderSelectable,
  projectUnverifiedCatalogFallbackForBuildRegion,
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
    { ...model('bytedance/seedance-2.5'), group: 'video' },
    { ...model('happyhorse'), group: 'video' },
    { ...model('voyage/voyage-4'), group: 'embedding' },
  ]);
  xd.imageModels = [
    { id: 'gpt-image-2', name: 'GPT Image 2' },
    { id: 'gemini-image', name: 'Gemini Image' },
  ];
  xd.imageDefaults = { standard: 'gpt-image-2', draft: 'gemini-image' };
  xd.videoModels = [
    { id: 'seedance-fast', name: 'Seedance Fast' },
    { id: 'seedance-pro', name: 'Seedance Pro' },
    { id: 'bytedance/seedance-2.5', name: 'Seedance 2.5' },
    { id: 'happyhorse', name: 'HappyHorse' },
  ];
  xd.videoDefaults = {
    standard: 'seedance-fast',
    draft: 'happyhorse',
    best: 'seedance-pro',
  };
  xd.embeddingModels = [
    { id: 'voyage/voyage-4', name: 'Voyage 4' },
    { id: 'text-embedding-3-small', name: 'OpenAI Embedding 3 Small' },
  ];
  xd.embeddingDefaults = { standard: 'voyage/voyage-4', draft: 'text-embedding-3-small' };
  xd.models.codex = undefined;
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

  it('keeps Gateway and locally connected xAI models verbatim; account-free mode only removes XD', () => {
    const xai: Provider = {
      id: 'xai',
      name: 'xAI',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'oauth' },
      routing: {},
      models: {
        'claude-code': [
          model('xai/grok-4'),
          { ...model('xai/grok-imagine-image'), group: 'image' },
          { ...model('xai/grok-imagine-video'), group: 'video' },
          { ...model('xai/grok-imagine-video-1.5'), group: 'video' },
        ],
      },
      imageModels: [{ id: 'xai/grok-imagine-image', name: 'Grok Imagine Image' }],
      videoModels: [
        { id: 'xai/grok-imagine-video', name: 'Grok Imagine Video' },
        { id: 'xai/grok-imagine-video-1.5', name: 'Grok Imagine Video 1.5' },
      ],
    };
    const base = catalog();
    const input: Catalog = { ...base, providers: [...base.providers, xai] };

    expect(filterProviderCatalogForAccount(input, { canUseCindyGateway: true })).toBe(input);

    const local = filterProviderCatalogForAccount(input, { canUseCindyGateway: false });
    expect(local.providers.map((item) => item.id)).toEqual(['anthropic', 'xai']);
    expect(local.providers.find((item) => item.id === 'xai')).toBe(xai);
    expect(xai.models['claude-code']?.map((item) => item.id)).toEqual([
      'xai/grok-4',
      'xai/grok-imagine-image',
      'xai/grok-imagine-video',
      'xai/grok-imagine-video-1.5',
    ]);
    expect(xai.imageModels?.map((item) => item.id)).toEqual(['xai/grok-imagine-image']);
    expect(xai.videoModels?.map((item) => item.id)).toEqual([
      'xai/grok-imagine-video',
      'xai/grok-imagine-video-1.5',
    ]);
  });

  it('projects only unverified XD fallback media in CN/dev and preserves xAI discovery verbatim', () => {
    const xai: Provider = {
      id: 'xai',
      name: 'xAI',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'oauth' },
      routing: {},
      models: {
        'claude-code': [
          { ...model('xai/grok-imagine-image'), group: 'image' },
          { ...model('xai/grok-imagine-video'), group: 'video' },
        ],
      },
      imageModels: [{ id: 'xai/grok-imagine-image', name: 'Grok Imagine Image' }],
      videoModels: [{ id: 'xai/grok-imagine-video', name: 'Grok Imagine Video' }],
    };
    const input = catalog();
    input.providers.push(xai);

    expect(projectUnverifiedCatalogFallbackForBuildRegion(input, 'global')).toBe(input);
    for (const region of ['cn', 'dev'] as const) {
      const projected = projectUnverifiedCatalogFallbackForBuildRegion(input, region);
      const xd = projected.providers.find((item) => item.id === 'xd');
      expect(xd?.imageModels).toEqual([]);
      expect(xd?.embeddingModels).toEqual([]);
      expect(xd?.videoModels?.map((item) => item.id)).toEqual([
        'seedance-fast',
        'seedance-pro',
        'bytedance/seedance-2.5',
      ]);
      expect(xd?.videoDefaults).toEqual({ standard: 'seedance-fast', best: 'seedance-pro' });
      expect(xd?.models['claude-code']?.map((item) => item.id)).toEqual([
        'shared-model',
        'xd-only-model',
        'seedance-fast',
        'seedance-pro',
        'bytedance/seedance-2.5',
      ]);
      expect(projected.providers.find((item) => item.id === 'xai')).toBe(xai);
    }
  });

  it('projects only the XD media fields that were inherited from bundled', () => {
    const input = catalog();
    const projected = projectUnverifiedCatalogFallbackForBuildRegion(
      input,
      'cn',
      new Set(['embedding']),
    );
    const originalXd = input.providers.find((provider) => provider.id === 'xd');
    const xd = projected.providers.find((provider) => provider.id === 'xd');

    expect(xd?.imageModels).toEqual(originalXd?.imageModels);
    expect(xd?.imageDefaults).toEqual(originalXd?.imageDefaults);
    expect(xd?.videoModels).toEqual(originalXd?.videoModels);
    expect(xd?.videoDefaults).toEqual(originalXd?.videoDefaults);
    expect(xd?.embeddingModels).toEqual([]);
    expect(xd?.embeddingDefaults).toBeUndefined();
    expect(xd?.models['claude-code']?.map((model) => model.id)).toEqual([
      'shared-model',
      'xd-only-model',
      'gpt-image-2',
      'seedance-fast',
      'seedance-pro',
      'bytedance/seedance-2.5',
      'happyhorse',
    ]);
  });
});
