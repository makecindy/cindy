import { describe, expect, it } from 'vitest';

import type { RegionalMoney } from '../../../../../shared/regionalMoney';
import { subtractSdkEstimatedValue } from '../projectScheduleCost';

function estimate(
  amount: number,
  estimateReasons: RegionalMoney['estimateReasons'],
): RegionalMoney {
  return {
    amount,
    currency: 'USD',
    approximate: true,
    kind: 'value-estimate',
    estimateReasons,
  };
}

describe('subtractSdkEstimatedValue', () => {
  it('hides a pure SDK estimate when the opt-in is off', () => {
    const sdk = estimate(0.42, ['sdk-estimate']);
    expect(subtractSdkEstimatedValue(sdk, sdk, false)).toBeNull();
  });

  it('keeps the independent reference-price portion of a mixed estimate', () => {
    expect(
      subtractSdkEstimatedValue(
        estimate(0.61, ['reference-price', 'sdk-estimate']),
        estimate(0.42, ['sdk-estimate']),
        false,
      ),
    ).toEqual(estimate(0.19, ['reference-price']));
  });

  it('keeps the full estimate when the user opts in', () => {
    const total = estimate(0.61, ['reference-price', 'sdk-estimate']);
    expect(
      subtractSdkEstimatedValue(total, estimate(0.42, ['sdk-estimate']), true),
    ).toBe(total);
  });
});
