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
});
