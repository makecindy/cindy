import { describe, expect, it } from 'vitest';

import { aggregateTurnUsageDetails, buildTurnUsageDetails } from '../turnUsageDetails';
import { DEFAULT_USAGE_CURRENCY, gatewayMoney, usdMoney } from '../regionalMoney';

describe('aggregateTurnUsageDetails', () => {
  it('sums token/cache fields and merges per-model costs across segments', () => {
    const first = buildTurnUsageDetails({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 100,
      cacheCreateTokens: 5,
      model: 'claude-fable-5[1m]',
      perModelCost: [{ model: 'claude-fable-5', money: usdMoney(2.5) }],
    });
    const second = buildTurnUsageDetails({
      inputTokens: 3,
      outputTokens: 7,
      cacheReadTokens: 50,
      cacheCreateTokens: 2,
      models: ['claude-fable-5[1m]', 'claude-opus-5[1m]'],
      perModelCost: [
        { model: 'claude-fable-5', money: usdMoney(1.25) },
        { model: 'claude-opus-5', money: usdMoney(4) },
      ],
    });

    const aggregated = aggregateTurnUsageDetails([first, second]);
    expect(aggregated).toMatchObject({
      inputTokens: 13,
      outputTokens: 27,
      cacheReadTokens: 150,
      cacheCreateTokens: 7,
      totalTokens: 197,
      models: ['claude-fable-5[1m]', 'claude-opus-5[1m]'],
    });
    expect(aggregated?.perModelCost).toEqual([
      { model: 'claude-fable-5', money: usdMoney(3.75) },
      { model: 'claude-opus-5', money: usdMoney(4) },
    ]);
    expect(aggregated?.cacheHitRate).toBeCloseTo(150 / 170);
  });

  it('uses the default usage currency when the same model has mixed segment currencies', () => {
    const staleCurrency = DEFAULT_USAGE_CURRENCY === 'USD' ? 'CNY' : 'USD';
    const first = buildTurnUsageDetails({
      inputTokens: 1,
      perModelCost: [{ model: 'claude-fable-5', money: gatewayMoney(4, staleCurrency) }],
    });
    const second = buildTurnUsageDetails({
      outputTokens: 1,
      perModelCost: [
        {
          model: 'claude-fable-5',
          money: gatewayMoney(6, DEFAULT_USAGE_CURRENCY),
        },
      ],
    });

    expect(aggregateTurnUsageDetails([first, second])?.perModelCost).toEqual([
      {
        model: 'claude-fable-5',
        money: gatewayMoney(6, DEFAULT_USAGE_CURRENCY),
      },
    ]);
  });

  it('ignores empty details and returns null when no segment has usage', () => {
    expect(aggregateTurnUsageDetails([null, undefined])).toBeNull();
    expect(
      aggregateTurnUsageDetails([
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          totalTokens: 0,
          cacheHitRate: null,
        },
      ]),
    ).toBeNull();
  });
});
