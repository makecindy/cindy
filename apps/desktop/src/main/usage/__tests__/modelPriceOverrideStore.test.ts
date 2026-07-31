import { describe, expect, it } from 'vitest';

import { __testing } from '../modelPriceOverrideStore';

describe('model price override sparse persistence', () => {
  it('keys overrides by provider instance, runtime, and exact model id', () => {
    expect(
      __testing.overrideKey({
        providerId: 'custom-a',
        agent: 'codex',
        modelId: 'same-model',
      }),
    ).not.toBe(
      __testing.overrideKey({
        providerId: 'custom-b',
        agent: 'codex',
        modelId: 'same-model',
      }),
    );
    expect(
      __testing.overrideKey({
        providerId: 'custom-a',
        agent: 'codex',
        modelId: 'same-model',
      }),
    ).not.toBe(
      __testing.overrideKey({
        providerId: 'custom-a',
        agent: 'claude-code',
        modelId: 'same-model',
      }),
    );
  });

  it('stores only fields changed from the current remote reference', () => {
    expect(
      __testing.sparseValues(
        {
          currency: 'USD',
          inputPerMtok: 2,
          outputPerMtok: 8,
          cacheReadPerMtok: null,
          cacheCreatePerMtok: 2.5,
        },
        {
          currency: 'USD',
          inputPerMtok: 2,
          outputPerMtok: 6,
          cacheReadPerMtok: 0.2,
          cacheCreatePerMtok: 2.5,
        },
      ),
    ).toEqual({
      outputPerMtok: 8,
      cacheReadPerMtok: null,
    });
  });

  it('detects a later remote-price change against the saved base snapshot', () => {
    const original = {
      currency: 'USD' as const,
      inputPerMtok: 2,
      outputPerMtok: 6,
      cacheReadPerMtok: 0.2,
      cacheCreatePerMtok: null,
    };
    expect(__testing.sameComparable(original, { ...original })).toBe(true);
    expect(
      __testing.sameComparable(original, {
        ...original,
        outputPerMtok: 7,
      }),
    ).toBe(false);
    expect(
      __testing.sameComparable(original, {
        ...original,
        inputTokenPriceBands: [
          {
            minInputTokens: 200_001,
            inputPerMtok: 4,
            outputPerMtok: 12,
          },
        ],
      }),
    ).toBe(false);
  });

  it('drops malformed records instead of accepting poisoned local state', () => {
    expect(
      __testing.normalize({
        entries: {
          bad: {
            providerId: 'custom',
            agent: 'codex',
            modelId: 'm',
            values: { inputPerMtok: -1 },
            baseReference: null,
            updatedAt: '2026-07-31T00:00:00.000Z',
          },
        },
      }),
    ).toEqual({ version: 1, entries: {} });
  });
});
