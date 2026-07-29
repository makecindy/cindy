/**
 * catalog → availableModels 派生契约(2026-07-19 模型列表统一重构后)。
 *
 * 历史:本文件曾是「迁移前硬编码清单的逐字快照」守卫(规则 10 no-break)。统一重构后
 * 静态清单**按设计**退役——anthropic/openai/xd 的清单运行时动态注入(SDK 发现 /
 * codex 注册表 / 网关下发,见 active-catalog + model-discovery),bundled 只剩 xai。
 * 冻结快照随之退役;本守卫改为守派生机制本身的契约:
 *   1. bundled 派生 = 仅 xai 静态清单(动态供应商零静态模型,不用假数据冒充);
 *   2. 注入后的目录按 provider 序 flatMap + id 首见去重,per-agent 分叉字段透传;
 *   3. refreshCatalogDerivedModels 原地 splice(已建会话持引用可见新目录)。
 */

import { describe, it, expect } from 'vitest';

import { BUNDLED_CATALOG } from '@cindy/model-providers';
import type { Catalog, CatalogModel } from '@cindy/model-providers';
import type { ModelDescriptor } from '@cindy/maker-core';

import { deriveAvailableModels, refreshCatalogDerivedModels } from '../catalog-to-descriptors.js';

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, contextWindow: 200_000, efforts: [], defaultEffort: null, ...extra };
}

/** 模拟 active-catalog 注入动态清单后的目录。 */
function injectedCatalog(): Catalog {
  const clone = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
  for (const p of clone.providers) {
    if (p.id === 'anthropic') {
      p.models['claude-code'] = [
        model('claude-opus-4-8', { name: 'Opus 4.8', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', supportsFastMode: true, group: 'anthropic', sortOrder: 1 }),
      ];
    }
    if (p.id === 'openai') {
      p.models.codex = [
        model('gpt-5.5', { name: 'GPT-5.5', contextWindow: 272_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true, group: 'gpt', sortOrder: 20 }),
      ];
      p.models['claude-code'] = [
        model('chatgpt/gpt-5.5', { name: 'GPT-5.5', contextWindow: 272_000, group: 'gpt', sortOrder: 20 }),
      ];
    }
    if (p.id === 'xd') {
      p.models['claude-code'] = [
        // 同 id 跨 provider:anthropic first-wins,xd 的这条在派生时被去重掉。
        model('claude-opus-4-8', { name: 'Opus 4.8', contextWindow: 1_000_000, supportsFastMode: false, group: 'anthropic', sortOrder: 1 }),
        // per-agent 分叉:同 id 在 cc=1M / codex=272k。
        model('gpt-5.5', { name: 'GPT-5.5', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', group: 'gpt', sortOrder: 20 }),
      ];
      p.models.codex = [
        model('gpt-5.5', { name: 'GPT-5.5', contextWindow: 272_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', group: 'gpt', sortOrder: 20 }),
      ];
    }
  }
  return clone;
}

describe('deriveAvailableModels — dynamic-first catalog contract', () => {
  it('bundled(未注入)派生 = 仅 xai 静态清单,动态供应商不贡献任何条目', () => {
    const cc = deriveAvailableModels(BUNDLED_CATALOG, 'claude-code');
    const codex = deriveAvailableModels(BUNDLED_CATALOG, 'codex');
    expect(cc.map((m) => m.id)).toEqual([
      'xai/grok-4.5', 'xai/grok-4.3', 'xai/grok-4.20', 'xai/grok-code-fast',
    ]);
    expect(codex.map((m) => m.id)).toEqual([
      'xai/grok-4.5', 'xai/grok-4.3', 'xai/grok-4.20', 'xai/grok-code-fast',
    ]);
  });

  it('xai 静态条目字段透传(窗口 / effort / 分组)', () => {
    const codex = deriveAvailableModels(BUNDLED_CATALOG, 'codex');
    expect(codex.find((m) => m.id === 'xai/grok-4.3')).toMatchObject({
      displayName: 'Grok 4.3',
      contextWindow: 1_000_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      group: 'grok',
    });
    expect(codex.find((m) => m.id === 'xai/grok-code-fast')).toMatchObject({
      efforts: [],
      defaultEffort: null,
    });
  });

  it('注入后:按 provider 序 union + id 首见去重(anthropic 先于 xd,fast 分叉取首见)', () => {
    const cc = deriveAvailableModels(injectedCatalog(), 'claude-code');
    const ids = cc.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // provider 序:anthropic → openai → xai → xd。
    expect(ids).toEqual([
      'claude-opus-4-8',
      'chatgpt/gpt-5.5',
      'xai/grok-4.5', 'xai/grok-4.3', 'xai/grok-4.20', 'xai/grok-code-fast',
      'gpt-5.5',
    ]);
    // 首见胜出:opus 取 anthropic 条目(supportsFastMode=true),不是 xd 的 false。
    expect(cc.find((m) => m.id === 'claude-opus-4-8')?.supportsFastMode).toBe(true);
  });

  it('per-agent 分叉透传:gpt-5.5 cc=1M / codex=272k', () => {
    const cat = injectedCatalog();
    expect(deriveAvailableModels(cat, 'claude-code').find((m) => m.id === 'gpt-5.5')?.contextWindow).toBe(1_000_000);
    expect(deriveAvailableModels(cat, 'codex').find((m) => m.id === 'gpt-5.5')?.contextWindow).toBe(272_000);
  });

  it('跳过 routing.disabled runtime，且不占用同模型的 first-wins', () => {
    const cat = injectedCatalog();
    const openai = cat.providers.find((provider) => provider.id === 'openai')!;
    const xd = cat.providers.find((provider) => provider.id === 'xd')!;
    const openaiCodexRoute = openai.routing.codex;
    if (!openaiCodexRoute) throw new Error('OpenAI Codex route fixture missing');
    openai.routing.codex = {
      ...openaiCodexRoute,
      disabled: true,
    };
    openai.models.codex = [
      model('disabled-only', { name: 'Disabled only' }),
      model('gpt-5.5', { name: 'Disabled first', contextWindow: 111 }),
    ];
    xd.models.codex = [
      model('gpt-5.5', { name: 'Enabled later', contextWindow: 222 }),
    ];

    const derived = deriveAvailableModels(cat, 'codex');
    expect(derived.some((candidate) => candidate.id === 'disabled-only')).toBe(false);
    expect(derived.find((candidate) => candidate.id === 'gpt-5.5')).toMatchObject({
      displayName: 'Enabled later',
      contextWindow: 222,
    });
  });

  it('非聊天模型(issue #882 第 3 点)不进任一 agent 的 availableModels,但仍留在完整 catalog 里', () => {
    const cat = injectedCatalog();
    const xd = cat.providers.find((provider) => provider.id === 'xd')!;
    xd.models['claude-code'] = [
      ...(xd.models['claude-code'] ?? []),
      model('gpt-image-2', { name: 'GPT Image 2', mode: 'image_generation', group: undefined }),
      model('text-embedding-3-large', { name: 'Embedding 3 Large' }), // 无 mode,靠 id 正则兜底判定为 embedding
    ];
    xd.models.codex = [
      ...(xd.models.codex ?? []),
      model('gpt-image-2', { name: 'GPT Image 2', mode: 'image_generation' }),
    ];

    const cc = deriveAvailableModels(cat, 'claude-code');
    const codex = deriveAvailableModels(cat, 'codex');
    expect(cc.some((m) => m.id === 'gpt-image-2')).toBe(false);
    expect(cc.some((m) => m.id === 'text-embedding-3-large')).toBe(false);
    expect(codex.some((m) => m.id === 'gpt-image-2')).toBe(false);
    // 完整 catalog(设置页消费的那份)不受 availableModels 派生过滤影响,模型仍在。
    expect(xd.models['claude-code']!.some((m) => m.id === 'gpt-image-2')).toBe(true);
    expect(xd.models['claude-code']!.some((m) => m.id === 'text-embedding-3-large')).toBe(true);
  });

  it('runtime refresh replaces both agent model lists in place so existing sessions keep the live reference', () => {
    const claudeModels: ModelDescriptor[] = [{ id: 'stale-claude', displayName: 'Stale', contextWindow: 1, efforts: [], defaultEffort: null }];
    const codexModels: ModelDescriptor[] = [{ id: 'stale-codex', displayName: 'Stale', contextWindow: 1, efforts: [], defaultEffort: null }];
    const claudeRef = claudeModels;
    const codexRef = codexModels;
    const target = {
      getCapabilities(agent: 'claude-code' | 'codex') {
        return { availableModels: agent === 'claude-code' ? claudeModels : codexModels };
      },
    };

    refreshCatalogDerivedModels(target, injectedCatalog());

    expect(claudeModels).toBe(claudeRef);
    expect(codexModels).toBe(codexRef);
    expect(claudeModels).toEqual(deriveAvailableModels(injectedCatalog(), 'claude-code'));
    expect(codexModels).toEqual(deriveAvailableModels(injectedCatalog(), 'codex'));
  });
});
