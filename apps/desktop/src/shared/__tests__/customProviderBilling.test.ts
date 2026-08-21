import { describe, expect, it } from 'vitest';

import {
  resolveCustomProviderCostFlag,
  sdkEstimatedValuePart,
} from '../customProviderBilling.js';
import type { RegionalMoney } from '../regionalMoney.js';

const actualUsd = (amount: number): RegionalMoney => ({
  amount,
  currency: 'USD',
  approximate: false,
  kind: 'actual-cost',
});

describe('resolveCustomProviderCostFlag', () => {
  it('prefers the persisted per-turn flag over the session provider', () => {
    expect(resolveCustomProviderCostFlag(true, 'anthropic')).toBe(true);
    expect(resolveCustomProviderCostFlag(false, 'deleted-custom')).toBe(false);
  });

  it('fails closed for omitted flags on unknown non-builtin providers', () => {
    expect(resolveCustomProviderCostFlag(undefined, 'my-openrouter')).toBe(true);
    expect(resolveCustomProviderCostFlag(undefined, 'anthropic')).toBe(false);
    expect(resolveCustomProviderCostFlag(undefined, null)).toBe(false);
  });
});

describe('sdkEstimatedValuePart with legacy custom-provider rows', () => {
  it('projects omitted-flag custom-provider actuals as SDK estimates', () => {
    expect(
      sdkEstimatedValuePart(
        actualUsd(1.25),
        null,
        resolveCustomProviderCostFlag(undefined, 'legacy-custom'),
      ),
    ).toMatchObject({
      amount: 1.25,
      kind: 'value-estimate',
      estimateReasons: ['sdk-estimate'],
    });
  });

  it('keeps builtin actuals in the spend ledger when the flag is omitted', () => {
    expect(
      sdkEstimatedValuePart(
        actualUsd(0.4),
        null,
        resolveCustomProviderCostFlag(undefined, 'anthropic'),
      ),
    ).toBeNull();
  });
});
