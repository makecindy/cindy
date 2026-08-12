import { describe, expect, it } from 'vitest';

import type { CatalogModel } from '@cindy/model-providers';

import {
  findCatalogModel,
  modelCanSuppressReasoning,
  resolveAutoReviewBudget,
} from '../auto-review-budget.js';

const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'm1',
  name: 'M1',
  contextWindow: 200_000,
  efforts: [],
  defaultEffort: null,
  ...over,
} as CatalogModel);

describe('modelCanSuppressReasoning', () => {
  it('treats an explicit low/minimal tier as suppressible', () => {
    expect(modelCanSuppressReasoning(model({ efforts: ['low', 'medium', 'high'] }))).toBe(true);
    expect(modelCanSuppressReasoning(model({ efforts: ['minimal', 'high', 'max'] }))).toBe(true);
  });

  it('treats a model with no effort switch as suppressible', () => {
    // Kimi K2.6 这类:不支持切档,但也不会强制长思考,紧凑额度够用。
    expect(modelCanSuppressReasoning(model({ efforts: [] }))).toBe(true);
  });

  it('treats a forced-reasoning model as NOT suppressible', () => {
    // DeepSeek V4 Pro/Flash:档位只有 high/max,传 low 会被上调 —— 384 token
    // 会被思考烧光、正文为空,正是审核静默失效的根因。
    expect(modelCanSuppressReasoning(model({ efforts: ['high', 'max'] }))).toBe(false);
  });

  it('is conservative when the model is unknown', () => {
    // 目录里查不到(自定义供应商未声明能力)时宁可多给额度,也不要重演 384 token
    // 判不出来的静默失败。
    expect(modelCanSuppressReasoning(undefined)).toBe(false);
  });
});

describe('resolveAutoReviewBudget', () => {
  it('keeps the compact budget for models that can turn reasoning down', () => {
    const budget = resolveAutoReviewBudget(model({ efforts: ['low', 'high'] }));
    expect(budget.maxTokens).toBe(384);
    expect(budget.timeoutMs).toBe(12_000);
    expect(budget.reasoningEffort).toBe('low');
  });

  it('widens the budget for forced-reasoning models and drops the ineffective effort hint', () => {
    const budget = resolveAutoReviewBudget(model({ efforts: ['high', 'max'] }));
    expect(budget.maxTokens).toBeGreaterThan(384);
    expect(budget.timeoutMs).toBeGreaterThan(12_000);
    // 传 low 会被上调成模型支持的最低档,平白带一个不生效的字段;个别上游还会
    // 因为不认的值直接 400。
    expect(budget.reasoningEffort).toBeUndefined();
  });

  it('widens the budget when the model is unknown', () => {
    const budget = resolveAutoReviewBudget(undefined);
    expect(budget.maxTokens).toBeGreaterThan(384);
    expect(budget.reasoningEffort).toBeUndefined();
  });

  it('sends minimal — not low — when that is the lowest tier the model declares', () => {
    // 回归 PR #2474 review P1:目录里 z-ai/glm-5.2 是 ['minimal','high','max'],
    // 固定发 low 会被上游拒绝或悄悄提到更高档,反而烧掉 384 token 的正文空间。
    const budget = resolveAutoReviewBudget(model({ efforts: ['minimal', 'high', 'max'] }));
    expect(budget.maxTokens).toBe(384);
    expect(budget.reasoningEffort).toBe('minimal');
  });

  it('omits the effort field entirely for models with no effort tiers', () => {
    // efforts: [] 的模型目录里有 10 个(Haiku 4.5 / Kimi K2.6 / grok 系 / qwen3.7-max
    // 等)。它们不强制长思考,所以照常走紧凑额度,但带一个不认的字段是白冒 400 的险。
    const budget = resolveAutoReviewBudget(model({ efforts: [] }));
    expect(budget.maxTokens).toBe(384);
    expect(budget.timeoutMs).toBe(12_000);
    expect(budget.reasoningEffort).toBeUndefined();
  });

  it('prefers low over minimal when the model declares both', () => {
    const budget = resolveAutoReviewBudget(model({ efforts: ['minimal', 'low', 'high'] }));
    expect(budget.reasoningEffort).toBe('low');
  });
});

describe('findCatalogModel', () => {
  const providers = [
    { id: 'xd', models: { 'claude-code': [model({ id: 'shared' })], pi: [model({ id: 'shared' })] } },
    { id: 'other', models: { 'claude-code': [model({ id: 'only-here', efforts: ['high'] })] } },
  ];

  it('prefers the named provider', () => {
    expect(findCatalogModel(providers, 'xd', 'pi', 'shared')?.id).toBe('shared');
  });

  it('falls back to a catalog-wide lookup when no provider is named', () => {
    // Pi 的 providerId=null 表示走默认网关路由;这里只读能力元数据,不参与路由。
    expect(findCatalogModel(providers, null, 'claude-code', 'only-here')?.efforts)
      .toEqual(['high']);
  });

  it('returns undefined for an unknown model instead of guessing', () => {
    expect(findCatalogModel(providers, 'xd', 'pi', 'nope')).toBeUndefined();
    expect(findCatalogModel(providers, 'xd', 'pi', '   ')).toBeUndefined();
  });

  it('never borrows another provider capability when a provider is named', () => {
    // 回归 PR #2474 review:同一个模型 id 在两家目录下能力不同时,跨家借用会把
    // 强制思考的路由误判成"能关思考",于是又拿回��凑额度 —— 正是本 PR 要修的故障。
    const crossProvider = [
      { id: 'xd', models: { 'claude-code': [model({ id: 'dual', efforts: ['high'] })] } },
      { id: 'other', models: { 'claude-code': [model({ id: 'dual', efforts: ['low', 'high'] })] } },
    ];
    // 点名 'nowhere' 这家没有该模型 → 返回 undefined,由调用方走保守宽裕档;
    // 绝不落到 'other' 的 low 档。
    expect(findCatalogModel(crossProvider, 'nowhere', 'claude-code', 'dual')).toBeUndefined();
    // 点名 'xd' 时只认 xd 自己的声明。
    expect(findCatalogModel(crossProvider, 'xd', 'claude-code', 'dual')?.efforts).toEqual(['high']);
  });
});
