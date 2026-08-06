import { BUNDLED_CATALOG, buildUserProvider, type Catalog } from '@cindy/model-providers';
import { describe, expect, it } from 'vitest';

import {
  mergeCodexModelsCache,
  mergeCodexModelCatalog,
  isCodexNativeDiscoverySlug,
  parseCodexModelsResponse,
  projectVerifiedCodexModels,
} from '../codex-model-catalog.js';

function catalogWithDeepSeek(options: {
  contextWindow?: number;
  verified?: boolean;
  duplicateContextWindow?: number;
  /** `null` = 目录从未登记过模态(未 resolve / 上游与知识库都没报)。 */
  modalities?: { input: string[]; output: string[] } | null;
} = {}): Catalog {
  const modalities = options.modalities === undefined
    ? { input: ['text'], output: ['text'] }
    : options.modalities;
  const models = [
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      ...(options.verified === false
        ? {}
        : { contextWindow: options.contextWindow ?? 1_000_000 }),
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high' as const,
      status: 'active' as const,
      ...(modalities ? { modalities } : {}),
      capabilities: { reasoning: true, toolCall: true },
    },
  ];
  const providers = [
    buildUserProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      auth: { method: 'apiKey' },
      runtimes: {
        codex: {
          baseUrl: 'https://api.deepseek.invalid/v1',
          models,
        },
      },
    }),
  ];
  if (options.duplicateContextWindow !== undefined) {
    providers.push(buildUserProvider({
      id: 'deepseek-secondary',
      name: 'DeepSeek Secondary',
      auth: { method: 'apiKey' },
      runtimes: {
        codex: {
          baseUrl: 'https://secondary.deepseek.invalid/v1',
          models: [{ ...models[0], contextWindow: options.duplicateContextWindow }],
        },
      },
    }));
  }
  return { ...BUNDLED_CATALOG, providers: [...BUNDLED_CATALOG.providers, ...providers] };
}

describe('projectVerifiedCodexModels', () => {
  it('projects verified Cindy models into Codex 0.145 ModelInfo metadata', () => {
    const result = projectVerifiedCodexModels(catalogWithDeepSeek());
    const deepseek = result.find((model) => model.slug === 'deepseek-v4-pro');

    expect(deepseek).toEqual(expect.objectContaining({
      slug: 'deepseek-v4-pro',
      display_name: 'DeepSeek V4 Pro',
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      effective_context_window_percent: 95,
      visibility: 'list',
      supported_in_api: true,
      input_modalities: ['text'],
      supports_parallel_tool_calls: true,
    }));
    expect(deepseek?.supported_reasoning_levels.map(({ effort }) => effort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('does not promote an unverified display fallback into Codex runtime metadata', () => {
    const result = projectVerifiedCodexModels(catalogWithDeepSeek({ verified: false }));
    expect(result.some((model) => model.slug === 'deepseek-v4-pro')).toBe(false);
  });

  it('uses the smallest verified window when multiple providers expose the same slug', () => {
    const result = projectVerifiedCodexModels(catalogWithDeepSeek({
      contextWindow: 1_000_000,
      duplicateContextWindow: 256_000,
    }));
    const matching = result.filter((model) => model.slug === 'deepseek-v4-pro');

    expect(matching).toHaveLength(1);
    expect(matching[0].context_window).toBe(256_000);
    expect(matching[0].max_context_window).toBe(256_000);
  });

  it('preserves provider-owned native metadata while overlaying verified Cindy facts', () => {
    const projected = projectVerifiedCodexModels(catalogWithDeepSeek());
    const native = {
      slug: 'deepseek-v4-pro',
      display_name: 'Native DeepSeek',
      base_instructions: 'native prompt',
      context_window: 272_000,
      max_context_window: 272_000,
      input_modalities: ['text', 'image'] as Array<'text' | 'image'>,
    };

    expect(mergeCodexModelCatalog([native], projected).models[0]).toEqual({
      ...native,
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      effective_context_window_percent: 95,
      input_modalities: ['text'],
    });
  });

  it('目录未登记模态时不投影该字段(避免把 text-only 猜测当事实)', () => {
    const projected = projectVerifiedCodexModels(catalogWithDeepSeek({ modalities: null }));
    const deepseek = projected.find((model) => model.slug === 'deepseek-v4-pro');

    expect(deepseek).toBeDefined();
    expect(deepseek).not.toHaveProperty('input_modalities');
    // 窗口仍然投影:它是已核实事实,与模态的「无证据」状态无关。
    expect(deepseek?.context_window).toBe(1_000_000);
  });

  it('目录未登记模态时保留原生模型自己的图片能力(不被压成纯文本)', () => {
    const projected = projectVerifiedCodexModels(catalogWithDeepSeek({ modalities: null }));
    const native = {
      slug: 'deepseek-v4-pro',
      display_name: 'Native DeepSeek',
      base_instructions: 'native prompt',
      context_window: 272_000,
      max_context_window: 272_000,
      input_modalities: ['text', 'image'] as Array<'text' | 'image'>,
    };

    expect(mergeCodexModelCatalog([native], projected).models[0]).toEqual({
      ...native,
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      effective_context_window_percent: 95,
      // 原生 ['text','image'] 原样保留 —— 目录没有相反证据就不许收窄。
      input_modalities: ['text', 'image'],
    });
  });

  it('目录登记了 image 时按登记值覆盖原生模态', () => {
    const projected = projectVerifiedCodexModels(catalogWithDeepSeek({
      modalities: { input: ['text', 'image'], output: ['text'] },
    }));
    const deepseek = projected.find((model) => model.slug === 'deepseek-v4-pro');
    expect(deepseek?.input_modalities).toEqual(['text', 'image']);

    const native = {
      slug: 'deepseek-v4-pro',
      base_instructions: 'native prompt',
      input_modalities: ['text'] as Array<'text' | 'image'>,
    };
    expect(mergeCodexModelCatalog([native], projected).models[0].input_modalities)
      .toEqual(['text', 'image']);
  });

  it('Cindy 独有 slug 缺模态证据时补纯文本,不继承模板的模态', () => {
    const projected = projectVerifiedCodexModels(catalogWithDeepSeek({ modalities: null }));
    const template = {
      slug: 'gpt-5.6',
      supported_in_api: true,
      base_instructions: 'native prompt',
      model_messages: null,
      input_modalities: ['text', 'image'] as Array<'text' | 'image'>,
    };

    const added = mergeCodexModelCatalog([template], projected).models
      .find((model) => model.slug === 'deepseek-v4-pro');

    expect(added).toBeDefined();
    // 模板的 image 能力属于 gpt-5.6,不能被未知第三方模型继承;缺键也不行(ModelInfo 要求该字段)。
    expect(added?.input_modalities).toEqual(['text']);
    expect(added?.base_instructions).toBe('native prompt');
  });

  it('builds a fresh Codex cache that model/list can load without network', () => {
    const native = {
      fetched_at: '2026-08-02T00:00:00.000Z',
      etag: 'native',
      client_version: '0.145.0',
      models: [{
        slug: 'gpt-template',
        base_instructions: 'native prompt',
        supported_in_api: true,
      }],
    };
    const cache = mergeCodexModelsCache(
      catalogWithDeepSeek(),
      native,
      42,
      new Date('2026-08-03T00:00:00.000Z'),
    );
    expect(cache).toEqual(expect.objectContaining({
      fetched_at: '2026-08-03T00:00:00.000Z',
      etag: '"cindy-catalog-42"',
      client_version: '0.145.0',
    }));
    expect(cache.models).toContainEqual(expect.objectContaining({
      slug: 'deepseek-v4-pro',
      base_instructions: 'native prompt',
      context_window: 1_000_000,
    }));
    expect(cache.cindy_injected_slugs).toContain('deepseek-v4-pro');
  });

  it('removes Cindy-only slugs that disappear from the next active catalog revision', () => {
    const native = {
      fetched_at: '2026-08-02T00:00:00.000Z',
      etag: 'native',
      client_version: '0.145.0',
      models: [{ slug: 'gpt-template', base_instructions: 'native prompt', supported_in_api: true }],
    };
    const injected = mergeCodexModelsCache(catalogWithDeepSeek(), native, 1);
    const next = mergeCodexModelsCache(BUNDLED_CATALOG, injected, 2);

    expect(next.models.some((model) => model.slug === 'deepseek-v4-pro')).toBe(false);
    expect(next.cindy_injected_slugs).not.toContain('deepseek-v4-pro');
  });

  it('rejects malformed upstream model responses', () => {
    expect(parseCodexModelsResponse({ models: [{ slug: 'valid' }] })).toEqual([{ slug: 'valid' }]);
    expect(parseCodexModelsResponse({ models: [{ id: 'missing-slug' }] })).toBeNull();
    expect(parseCodexModelsResponse({ data: [] })).toBeNull();
  });

  it('is deterministic across repeated projections', () => {
    const catalog = catalogWithDeepSeek();
    expect(projectVerifiedCodexModels(catalog)).toEqual(projectVerifiedCodexModels(catalog));
  });

  it('does not feed third-party synthetic slugs back into OpenAI discovery', () => {
    const catalog = catalogWithDeepSeek();
    expect(isCodexNativeDiscoverySlug(catalog, 'deepseek-v4-pro')).toBe(false);
    expect(isCodexNativeDiscoverySlug(catalog, 'gpt-5.6-sol')).toBe(true);
    expect(isCodexNativeDiscoverySlug(catalog, 'a-native-model-not-in-cindy')).toBe(true);
  });

  it('clears model-specific native policy when creating a Cindy-only descriptor', () => {
    const projected = projectVerifiedCodexModels(catalogWithDeepSeek());
    const native = {
      slug: 'gpt-template',
      base_instructions: 'native prompt',
      model_messages: { instructions_template: 'vendor-specific prompt' },
      availability_nux: { message: 'vendor nux' },
      upgrade: { id: 'newer' },
      supported_in_api: true,
    };
    const model = mergeCodexModelCatalog(native ? [native] : [], projected).models
      .find((candidate) => candidate.slug === 'deepseek-v4-pro');
    expect(model).toEqual(expect.objectContaining({
      base_instructions: 'native prompt',
      model_messages: null,
      availability_nux: null,
      upgrade: null,
      truncation_policy: { mode: 'bytes', limit: 10_000 },
      tool_mode: null,
      multi_agent_version: null,
    }));
  });
});
