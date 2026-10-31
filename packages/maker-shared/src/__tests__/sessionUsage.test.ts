import { describe, expect, it } from 'vitest';

import {
  buildSessionUsage,
  type SessionUsageTurn,
} from '../sessionUsage.js';

const PRO_RATES = { inputPerMtok: 0.5, outputPerMtok: 1.5, currency: 'USD' };

describe('buildSessionUsage', () => {
  it('sums tokens and priced cost across turns of one model', () => {
    const summary = buildSessionUsage([
      { model: 'deepseek-v4-pro', provider: 'DeepSeek', inputTokens: 1200, outputTokens: 300, rates: PRO_RATES },
      {
        model: 'deepseek-v4-pro',
        inputTokens: 800,
        outputTokens: 200,
        cacheReadTokens: 5000,
        rates: { ...PRO_RATES, cacheReadPerMtok: 0.1 },
      },
    ]);

    expect(summary.turns).toBe(2);
    expect(summary.inputTokens).toBe(2000);
    expect(summary.outputTokens).toBe(500);
    expect(summary.cacheReadTokens).toBe(5000);
    expect(summary.totalTokens).toBe(7500);
    expect(summary.tokensLabel).toBe('7.5k');
    expect(summary.costStatus).toBe('complete');
    expect(summary.cost).toBe(0.00225);
    expect(summary.currency).toBe('USD');
    expect(summary.unpricedModels).toEqual([]);
    expect(summary.models).toHaveLength(1);
    expect(summary.models[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      provider: 'DeepSeek',
      local: false,
      turns: 2,
      totalTokens: 7500,
      cost: 0.00225,
      currency: 'USD',
    });
  });

  it('never prices a local turn, even when rates are supplied', () => {
    const summary = buildSessionUsage([
      {
        model: 'qwen3-8b',
        local: true,
        inputTokens: 1000,
        outputTokens: 500,
        rates: { inputPerMtok: 99, outputPerMtok: 99, currency: 'USD' },
      },
    ]);

    expect(summary.totalTokens).toBe(1500);
    expect(summary.cost).toBe(0);
    expect(summary.costStatus).toBe('none');
    expect(summary.currency).toBeUndefined();
    expect(summary.models[0]).toMatchObject({ local: true, cost: null, totalTokens: 1500 });
    expect(summary.unpricedModels).toEqual([]);
  });

  it('keeps the cost complete when local turns sit alongside priced ones', () => {
    const summary = buildSessionUsage([
      { model: 'deepseek-v4-pro', inputTokens: 1200, outputTokens: 300, rates: PRO_RATES },
      { model: 'qwen3-8b', local: true, inputTokens: 1000, outputTokens: 500 },
    ]);

    expect(summary.costStatus).toBe('complete');
    expect(summary.cost).toBe(0.00105);
    // Equal token totals: the tie breaks on model id, so the order is stable.
    expect(summary.models.map((model) => model.model)).toEqual(['deepseek-v4-pro', 'qwen3-8b']);
  });

  it('reports a partial cost when one remote model has no rates', () => {
    const summary = buildSessionUsage([
      { model: 'deepseek-v4-pro', inputTokens: 1200, outputTokens: 300, rates: PRO_RATES },
      { model: 'gpt-5.4', inputTokens: 4000, outputTokens: 1000 },
    ]);

    expect(summary.costStatus).toBe('partial');
    expect(summary.cost).toBe(0.00105);
    expect(summary.unpricedModels).toEqual(['gpt-5.4']);
    expect(summary.models.find((model) => model.model === 'gpt-5.4')?.cost).toBeNull();
    expect(summary.totalTokens).toBe(6500);
  });

  it('leaves a turn unpriced when a category with tokens has no rate', () => {
    const summary = buildSessionUsage([
      {
        model: 'deepseek-v4-pro',
        inputTokens: 1000,
        outputTokens: 10,
        rates: { inputPerMtok: 0.5, currency: 'USD' },
      },
    ]);

    expect(summary.costStatus).toBe('none');
    expect(summary.cost).toBe(0);
    expect(summary.unpricedModels).toEqual(['deepseek-v4-pro']);
  });

  it('prices a turn whose empty categories carry no rate', () => {
    const summary = buildSessionUsage([
      { model: 'deepseek-v4-pro', inputTokens: 1000, rates: { inputPerMtok: 2, currency: 'USD' } },
    ]);

    expect(summary.costStatus).toBe('complete');
    expect(summary.cost).toBe(0.002);
  });

  it('leaves rates without a currency unpriced', () => {
    const summary = buildSessionUsage([
      { model: 'deepseek-v4-pro', inputTokens: 1000, rates: { inputPerMtok: 0.5 } },
    ]);

    expect(summary.costStatus).toBe('none');
    expect(summary.currency).toBeUndefined();
    expect(summary.unpricedModels).toEqual(['deepseek-v4-pro']);
  });

  it('refuses to sum across currencies and says the cost is partial', () => {
    const summary = buildSessionUsage([
      { model: 'deepseek-v4-pro', inputTokens: 1000, rates: { inputPerMtok: 2, currency: 'USD' } },
      { model: 'eur-model', inputTokens: 1000, rates: { inputPerMtok: 2, currency: 'EUR' } },
    ]);

    expect(summary.currency).toBe('USD');
    expect(summary.cost).toBe(0.002);
    expect(summary.costStatus).toBe('partial');
    expect(summary.unpricedModels).toEqual(['eur-model']);
  });

  it('rounds the summed cost to six decimals', () => {
    const summary = buildSessionUsage(
      Array.from({ length: 3 }, (): SessionUsageTurn => ({
        model: 'deepseek-v4-pro',
        inputTokens: 1,
        rates: { inputPerMtok: 0.7, currency: 'USD' },
      })),
    );

    expect(Number.isInteger(summary.cost * 1_000_000)).toBe(true);
    expect(summary.cost).toBe(0.000002);
  });

  it('skips blank models and clamps bad token counts', () => {
    const summary = buildSessionUsage([
      { model: '   ' },
      { model: 'deepseek-v4-pro', inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: Infinity },
    ]);

    expect(summary.turns).toBe(1);
    expect(summary.totalTokens).toBe(0);
    expect(summary.tokensLabel).toBe('0');
    expect(summary.costStatus).toBe('none');
  });

  it('marks a model local only when every turn of it was local', () => {
    const summary = buildSessionUsage([
      { model: 'qwen3-8b', local: true, inputTokens: 100 },
      { model: 'qwen3-8b', inputTokens: 100, rates: { inputPerMtok: 1, currency: 'USD' } },
    ]);

    expect(summary.models[0]).toMatchObject({ local: false, turns: 2, cost: 0.0001 });
    expect(summary.costStatus).toBe('complete');
  });

  it('returns an empty summary for missing input', () => {
    const summary = buildSessionUsage(undefined as unknown as SessionUsageTurn[]);

    expect(summary).toMatchObject({
      turns: 0,
      totalTokens: 0,
      tokensLabel: '0',
      cost: 0,
      costStatus: 'none',
      unpricedModels: [],
      models: [],
    });
  });
});
