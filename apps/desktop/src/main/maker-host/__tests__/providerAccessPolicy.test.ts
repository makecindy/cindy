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
      expect(xd?.models.codex).toEqual([]);
    },
  );
});

describe('projectProviderCatalogForBuildRegion — 用户自有媒体来源', () => {
  it('非 global 区域只投影 Cindy AI,保留用户连接的图像来源', () => {
    const gemini: Provider = {
      id: 'gemini',
      name: 'Google Gemini',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'oauth' },
      routing: {},
      models: { 'claude-code': [] },
      imageModels: [{ id: 'gemini/gemini-3-pro-image', name: 'Gemini 3 Pro Image' }],
    };
    const openai: Provider = {
      id: 'openai',
      name: 'OpenAI',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'oauth' },
      routing: {},
      models: { 'claude-code': [] },
      imageModels: [{ id: 'openai/gpt-image-2', name: 'GPT Image 2' }],
      // 防御对象:即使未来用户来源声明 defaults,区域投影也不应改写它。
      imageDefaults: { standard: 'openai/gpt-image-2' },
    };
    const base = catalog();
    const projected = projectProviderCatalogForBuildRegion(
      { ...base, providers: [...base.providers, gemini, openai] },
      'cn',
    );
    expect(projected.providers.find((p) => p.id === 'gemini')).toBe(gemini);
    expect(projected.providers.find((p) => p.id === 'openai')).toBe(openai);
    const xd = projected.providers.find((p) => p.id === 'xd');
    expect(xd?.imageModels).toEqual([]);
    expect(xd?.imageDefaults).toBeUndefined();
    expect(xd?.videoModels?.map((m) => m.id)).toEqual(['seedance-fast', 'seedance-pro']);
  });

  it.each(['cn', 'dev'] as const)(
    '非 xd 供应商在 %s 保留图像与聊天能力,暂不暴露视频能力',
    (region) => {
      const thirdParty: Provider = {
        id: 'third',
        name: 'Third Party',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'oauth' },
        routing: {},
        models: {
          'claude-code': [
            { ...model('seedance-fast'), group: 'video' },
            { ...model('third/image'), group: 'image' },
            model('chat-model'),
          ],
          codex: undefined,
        },
        imageModels: [{ id: 'third/image', name: 'Third Image' }],
        imageDefaults: { standard: 'third/image' },
        videoModels: [{ id: 'seedance-fast', name: 'Seedance Fast' }],
        videoDefaults: { standard: 'seedance-fast' },
      };
      const base = catalog();
      const projected = projectProviderCatalogForBuildRegion(
        { ...base, providers: [...base.providers, thirdParty] },
        region,
      );
      const third = projected.providers.find((p) => p.id === 'third');
      expect(third).not.toBe(thirdParty);
      expect(third?.models['claude-code']?.map((m) => m.id)).toEqual(['third/image', 'chat-model']);
      expect(third?.models.codex).toEqual([]);
      expect(third?.imageModels).toBe(thirdParty.imageModels);
      expect(third?.imageDefaults).toBe(thirdParty.imageDefaults);
      expect(third?.videoModels).toEqual([]);
      expect(third?.videoDefaults).toBeUndefined();
    },
  );

  it('mode: image_generation 的用户模型在 cn 区域保持可用', () => {
    const modeOnly: Provider = {
      id: 'xai',
      name: 'xAI',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'oauth' },
      routing: {},
      models: {
        'claude-code': [
          { ...model('xai/aurora'), mode: 'image_generation' },
          model('xai/grok-chat'),
        ],
      },
    };
    const base = catalog();
    const projected = projectProviderCatalogForBuildRegion(
      { ...base, providers: [...base.providers, modeOnly] },
      'cn',
    );
    const xai = projected.providers.find((p) => p.id === 'xai');
    expect(xai).toBe(modeOnly);
    expect(xai?.models['claude-code']?.map((m) => m.id)).toEqual([
      'xai/aurora',
      'xai/grok-chat',
    ]);
  });

  it('global 区域原样返回(含新来源的媒体清单)', () => {
    const gemini: Provider = {
      id: 'gemini',
      name: 'Google Gemini',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'oauth' },
      routing: {},
      models: { 'claude-code': [] },
      imageModels: [{ id: 'gemini/gemini-3-pro-image', name: 'Gemini 3 Pro Image' }],
    };
    const base = catalog();
    const input = { ...base, providers: [...base.providers, gemini] };
    const projected = projectProviderCatalogForBuildRegion(input, 'global');
    expect(projected).toBe(input);
  });

  it('目录没有 Cindy AI 时非 global 也保持原对象', () => {
    const input: Catalog = { version: 'test', providers: [] };
    expect(projectProviderCatalogForBuildRegion(input, 'cn')).toBe(input);
  });
});
