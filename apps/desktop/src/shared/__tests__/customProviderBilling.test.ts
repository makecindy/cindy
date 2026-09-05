import { describe, expect, it } from 'vitest';

import { BUNDLED_CATALOG } from '@cindy/model-providers';

import {
  BUNDLED_XD_GATEWAY_MODEL_IDS,
  inferLegacyCustomProviderCostFlag,
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

describe('legacy bundled Gateway evidence', () => {
  it('stays aligned with the versioned model registry without bundling it in Renderer code', () => {
    const registryIds = BUNDLED_CATALOG.modelRegistry?.models.flatMap((entry) =>
      entry.routes
        .filter((route) => route.providerId === 'xd')
        .map((route) => route.modelId),
    ) ?? [];

    expect([...BUNDLED_XD_GATEWAY_MODEL_IDS].sort()).toEqual(
      [...new Set(registryIds)].sort(),
    );
  });

  it('does not use a cost-free closing segment model to classify a user-round total', () => {
    expect(
      inferLegacyCustomProviderCostFlag({
        hasPerTurnCost: false,
        modelCandidates: ['claude-sonnet-4-6'],
      }),
    ).toBe(true);
    expect(
      inferLegacyCustomProviderCostFlag({
        hasPerTurnCost: true,
        modelCandidates: ['claude-sonnet-4-6'],
      }),
    ).toBe(false);
    expect(
      inferLegacyCustomProviderCostFlag({
        hasPerTurnCost: true,
        modelCandidates: ['claude-sonnet-4-6[1m]'],
      }),
    ).toBe(false);
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
