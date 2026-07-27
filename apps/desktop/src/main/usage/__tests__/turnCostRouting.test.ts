import { describe, expect, it } from 'vitest';

import type { ModelUsageDeltaEntry } from '../modelUsageDelta';
import { resolveClaudeTurnCostSinks } from '../turnCostCalculator';
import type {
  ModelPriceQuote,
  ModelPricingCatalog,
} from '../../../shared/regionalMoney';

function delta(values: Partial<ModelUsageDeltaEntry> & { model: string }): ModelUsageDeltaEntry {
  return {
    costUsdDelta: 0,
    inputTokensDelta: 0,
    outputTokensDelta: 0,
    cacheReadTokensDelta: 0,
    cacheCreateTokensDelta: 0,
    ...values,
  };
}

function quote(modelId: string, inputPerMtok: number, outputPerMtok: number): ModelPriceQuote {
  return {
    providerId: 'xd',
    modelId,
    currency: 'USD',
    source: 'gateway',
    approximate: false,
    inputPerMtok,
    outputPerMtok,
  };
}

function pricing(...values: ModelPriceQuote[]): ModelPricingCatalog {
  return {
    xd: Object.fromEntries(values.map((value) => [value.modelId, value])),
  };
}

describe('turn cost routing regression', () => {
  it('XD route ignores the SDK model-family guess and prices every model from its gateway quote', () => {
    const result = resolveClaudeTurnCostSinks(
      [
        delta({
          model: 'gpt-5.5[1m]',
          costUsdDelta: 5.553085,
          inputTokensDelta: 1_099_022,
          outputTokensDelta: 2_319,
        }),
        delta({
          model: 'claude-opus-4-8[1m]',
          costUsdDelta: 99,
          inputTokensDelta: 1_000_000,
        }),
      ],
      pricing(
        quote('gpt-5.5', 2, 8),
        quote('claude-opus-4-8', 5, 25),
      ),
      {
        providerId: 'xd',
        billingRoute: 'xd-gateway',
      },
    );

    expect(result.perModel[0]).toMatchObject({
      model: 'gpt-5.5',
      source: 'gateway',
    });
    expect(result.perModel[0].money?.amount).toBeCloseTo(2.216596, 5);
    expect(result.perModel[1]).toMatchObject({
      model: 'claude-opus-4-8',
      source: 'gateway',
    });
    expect(result.perModel[1].money?.amount).toBe(5);
    expect(result.turnMoney?.amount).toBeCloseTo(7.216596, 5);
  });

  it('provider API route keeps the SDK USD total exact in USD', () => {
    const result = resolveClaudeTurnCostSinks(
      [
        delta({ model: 'claude-opus-4-8', costUsdDelta: 1.5 }),
        delta({ model: 'mystery-model', costUsdDelta: 2 }),
      ],
      null,
      {
        providerId: 'anthropic',
        billingRoute: 'provider-api',
      },
    );

    expect(result.turnMoney).toMatchObject({
      currency: 'USD',
      approximate: false,
    });
    expect(result.turnMoney?.amount).toBeCloseTo(3.5);
    expect(result.perModel.map((item) => item.source)).toEqual(['sdk', 'sdk']);
  });
});
