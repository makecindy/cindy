import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG } from '@cindy/model-providers';

import { providerReferencePriceQuote } from '../../../shared/modelPriceQuote';
import type { ModelPriceQuote } from '../../../shared/regionalMoney';
import { __testing } from '../modelPriceOverrideStore';
import { computeGatewayTurnCost } from '../turnCostCalculator';

describe('standard overrides preserve independent Fast reference prices', () => {
  const target = { providerId: 'openai', agent: 'pi' as const, modelId: 'gpt-6-astra' };
  const reference = providerReferencePriceQuote(
    'openai',
    target.modelId,
    BUNDLED_CATALOG.modelRegistry,
    {
      at: '2026-09-04',
    },
  )!;
  const savedBase = {
    currency: reference.currency,
    inputPerMtok: reference.inputPerMtok,
    outputPerMtok: reference.outputPerMtok,
    cacheReadPerMtok: reference.cacheReadPerMtok ?? null,
    cacheCreatePerMtok: reference.cacheCreatePerMtok ?? null,
    inputTokenPriceBands: reference.inputTokenPriceBands,
  };
  const tokens = {
    inputTokens: 200_000,
    outputTokens: 1_000,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
  };

  it('keeps Astra Fast prices and window bounds separate from saved standard edits', () => {
    const merged = __testing.mergedQuote(
      target,
      reference,
      {
        inputPerMtok: 3,
        outputPerMtok: 7,
        cacheReadPerMtok: null,
        cacheCreatePerMtok: null,
      },
      savedBase,
    );
    expect(merged).toMatchObject({ source: 'user-override', inputPerMtok: 3, outputPerMtok: 7 });
    expect(merged?.priority).toEqual(reference.priority);
    expect(computeGatewayTurnCost(tokens, merged, 'fast')).toBeCloseTo(4.1);
    expect(computeGatewayTurnCost(tokens, merged)).toBeCloseTo(0.607);
    expect(computeGatewayTurnCost({ ...tokens, inputTokens: 272_001 }, merged, 'fast')).toBeNull();
    expect(__testing.mergedQuote(target, reference, undefined)).toBe(reference);
  });

  it.each([true, false])(
    'follows live Fast updates while standard reference bands exist: %s',
    (keepBands) => {
      const updated: ModelPriceQuote = {
        ...reference,
        outputPerMtok: 60,
        inputTokenPriceBands: keepBands ? reference.inputTokenPriceBands : undefined,
        priority: { inputPerMtok: 30, outputPerMtok: 120 },
      };
      const merged = __testing.mergedQuote(target, updated, { inputPerMtok: 3 }, savedBase);
      expect(merged?.outputPerMtok).toBe(60);
      expect(merged?.priority).toEqual(updated.priority);
      expect(computeGatewayTurnCost(tokens, merged, 'fast')).toBeCloseTo(6.12);
      expect(
        computeGatewayTurnCost({ ...tokens, cacheCreateTokens: 1 }, merged, 'fast'),
      ).toBeNull();
    },
  );

  it('does not relabel USD Fast prices when the user enters CNY prices', () => {
    const values = __testing.sparseValues(
      { currency: 'CNY', inputPerMtok: 3, outputPerMtok: 7 },
      savedBase,
    );
    const merged = __testing.mergedQuote(target, reference, values, savedBase);
    expect(merged?.currency).toBe('CNY');
    expect(merged?.priority).toBeUndefined();
    expect(computeGatewayTurnCost(tokens, merged, 'fast')).toBeNull();
  });

  it.each(['currency-change', 'missing-reference', 'missing-fast'] as const)(
    'does not invent Fast prices after %s',
    (scenario) => {
      const live =
        scenario === 'missing-reference'
          ? undefined
          : {
              ...reference,
              ...(scenario === 'currency-change'
                ? { currency: 'CNY' as const }
                : { priority: undefined }),
            };
      const merged = __testing.mergedQuote(target, live, { inputPerMtok: 3 }, savedBase);
      expect(merged?.currency).toBe('USD');
      expect(merged?.inputPerMtok).toBe(3);
      expect(merged?.priority).toBeUndefined();
      expect(computeGatewayTurnCost(tokens, merged, 'fast')).toBeNull();
    },
  );
});

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

  it('preserves remote long-context multipliers when applying a sparse local override', () => {
    const inputTokenPriceBands = [
      {
        minInputTokens: 200_001,
        inputPerMtok: 4,
        outputPerMtok: 12,
      },
    ];
    expect(
      __testing.mergedQuote(
        { providerId: 'custom', agent: 'codex', modelId: 'model' },
        {
          providerId: 'custom',
          modelId: 'model',
          currency: 'USD',
          source: 'provider-reference',
          approximate: true,
          inputPerMtok: 2,
          outputPerMtok: 6,
          inputTokenPriceBands,
        },
        { outputPerMtok: 8 },
      ),
    ).toMatchObject({
      source: 'user-override',
      outputPerMtok: 8,
      inputTokenPriceBands: [
        {
          minInputTokens: 200_001,
          inputPerMtok: 4,
          outputPerMtok: 16,
        },
      ],
    });
  });

  it('rewrites every inherited price when the user changes quote currency', () => {
    const reference = {
      currency: 'USD' as const,
      inputPerMtok: 2,
      outputPerMtok: 6,
      cacheReadPerMtok: 0.2,
      cacheCreatePerMtok: null,
      inputTokenPriceBands: [
        {
          minInputTokens: 200_001,
          inputPerMtok: 4,
          outputPerMtok: 12,
          cacheReadPerMtok: 0.4,
        },
      ],
    };
    const values = __testing.sparseValues(
      {
        currency: 'CNY',
        inputPerMtok: 3,
        outputPerMtok: 9,
        cacheReadPerMtok: 0.3,
        cacheCreatePerMtok: null,
      },
      reference,
    );
    expect(values).toEqual({
      currency: 'CNY',
      inputPerMtok: 3,
      outputPerMtok: 9,
      cacheReadPerMtok: 0.3,
      cacheCreatePerMtok: null,
    });
    expect(
      __testing.mergedQuote(
        { providerId: 'custom', agent: 'codex', modelId: 'model' },
        {
          providerId: 'custom',
          modelId: 'model',
          source: 'provider-reference',
          approximate: true,
          currency: reference.currency,
          inputPerMtok: reference.inputPerMtok,
          outputPerMtok: reference.outputPerMtok,
          cacheReadPerMtok: reference.cacheReadPerMtok,
          inputTokenPriceBands: reference.inputTokenPriceBands,
        },
        values,
      ),
    ).toMatchObject({
      currency: 'CNY',
      inputTokenPriceBands: [
        {
          minInputTokens: 200_001,
          inputPerMtok: 6,
          outputPerMtok: 18,
          cacheReadPerMtok: 0.6,
        },
      ],
    });
  });

  it('keeps sparse numeric overrides in their saved base currency after a remote currency change', () => {
    const savedBase = {
      currency: 'USD' as const,
      inputPerMtok: 2,
      outputPerMtok: 6,
      cacheReadPerMtok: 0.2,
      cacheCreatePerMtok: null,
      inputTokenPriceBands: [
        {
          minInputTokens: 200_001,
          inputPerMtok: 4,
          outputPerMtok: 12,
        },
      ],
    };
    expect(
      __testing.mergedQuote(
        { providerId: 'custom', agent: 'codex', modelId: 'model' },
        {
          providerId: 'custom',
          modelId: 'model',
          source: 'provider-reference',
          approximate: true,
          currency: 'CNY',
          inputPerMtok: 1,
          outputPerMtok: 3,
        },
        { inputPerMtok: 4 },
        savedBase,
      ),
    ).toMatchObject({
      currency: 'USD',
      inputPerMtok: 4,
      outputPerMtok: 6,
      cacheReadPerMtok: 0.2,
      inputTokenPriceBands: [
        {
          minInputTokens: 200_001,
          inputPerMtok: 8,
          outputPerMtok: 12,
        },
      ],
    });
  });

  it('re-anchors saved long-context bands when a same-currency remote update drops them', () => {
    const savedBase = {
      currency: 'USD' as const,
      inputPerMtok: 2,
      outputPerMtok: 6,
      cacheReadPerMtok: 0.2,
      cacheCreatePerMtok: null,
      inputTokenPriceBands: [
        {
          minInputTokens: 200_001,
          inputPerMtok: 4,
          outputPerMtok: 12,
        },
      ],
    };
    const merged = __testing.mergedQuote(
      { providerId: 'custom', agent: 'codex', modelId: 'model' },
      {
        providerId: 'custom',
        modelId: 'model',
        source: 'provider-reference',
        approximate: true,
        currency: 'USD',
        inputPerMtok: 3,
        outputPerMtok: 9,
        cacheReadPerMtok: 0.3,
      },
      { inputPerMtok: 4 },
      savedBase,
    );
    // 未覆盖的基础价跟随远端;分段价保留保存基底的相对倍率(输入 2×、输出 2×),
    // 锚回远端新基础价后再按覆盖投影:输入档 2×4=8,输出档 2×9=18。
    expect(merged).toMatchObject({
      source: 'user-override',
      currency: 'USD',
      inputPerMtok: 4,
      outputPerMtok: 9,
      cacheReadPerMtok: 0.3,
      inputTokenPriceBands: [
        {
          minInputTokens: 200_001,
          inputPerMtok: 8,
          outputPerMtok: 18,
        },
      ],
    });
  });

  it('follows a same-currency remote update that keeps its long-context bands', () => {
    const savedBase = {
      currency: 'USD' as const,
      inputPerMtok: 2,
      outputPerMtok: 6,
      cacheReadPerMtok: null,
      cacheCreatePerMtok: null,
      inputTokenPriceBands: [
        {
          minInputTokens: 200_001,
          inputPerMtok: 4,
          outputPerMtok: 12,
        },
      ],
    };
    expect(
      __testing.mergedQuote(
        { providerId: 'custom', agent: 'codex', modelId: 'model' },
        {
          providerId: 'custom',
          modelId: 'model',
          source: 'provider-reference',
          approximate: true,
          currency: 'USD',
          inputPerMtok: 3,
          outputPerMtok: 9,
          inputTokenPriceBands: [
            {
              minInputTokens: 200_001,
              inputPerMtok: 6,
              outputPerMtok: 18,
            },
          ],
        },
        { inputPerMtok: 4 },
        savedBase,
      ),
    ).toMatchObject({
      source: 'user-override',
      currency: 'USD',
      inputPerMtok: 4,
      outputPerMtok: 9,
      inputTokenPriceBands: [
        {
          minInputTokens: 200_001,
          inputPerMtok: 8,
          outputPerMtok: 18,
        },
      ],
    });
  });

  it('keeps sparse overrides when the remote reference price disappears', () => {
    const savedBase = {
      currency: 'USD' as const,
      inputPerMtok: 2,
      outputPerMtok: 6,
      cacheReadPerMtok: 0.2,
      cacheCreatePerMtok: null,
      inputTokenPriceBands: [
        {
          minInputTokens: 200_001,
          inputPerMtok: 4,
          outputPerMtok: 12,
        },
      ],
    };
    expect(
      __testing.mergedQuote(
        { providerId: 'custom', agent: 'codex', modelId: 'model' },
        undefined,
        { inputPerMtok: 4 },
        savedBase,
      ),
    ).toMatchObject({
      source: 'user-override',
      currency: 'USD',
      inputPerMtok: 4,
      outputPerMtok: 6,
      cacheReadPerMtok: 0.2,
      inputTokenPriceBands: [
        {
          minInputTokens: 200_001,
          inputPerMtok: 8,
          outputPerMtok: 12,
        },
      ],
    });
  });

  it('only accepts currencies that can project into the active ledger', () => {
    expect(__testing.currencyCanProjectToLedger('USD', 'USD')).toBe(true);
    expect(__testing.currencyCanProjectToLedger('USD', 'CNY')).toBe(true);
    expect(__testing.currencyCanProjectToLedger('CNY', 'CNY')).toBe(true);
    expect(__testing.currencyCanProjectToLedger('CNY', 'USD')).toBe(false);
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

  it('reloads a persisted Pi override instead of discarding it after restart', () => {
    const target = { providerId: 'custom-pi', agent: 'pi' as const, modelId: 'grok-4' };
    const key = __testing.overrideKey(target);
    expect(
      __testing.normalize({
        version: 1,
        entries: {
          [key]: {
            ...target,
            values: { inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3 },
            baseReference: null,
            updatedAt: '2026-08-02T00:00:00.000Z',
          },
        },
      }),
    ).toEqual({
      version: 1,
      entries: {
        [key]: {
          ...target,
          values: { inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3 },
          baseReference: null,
          updatedAt: '2026-08-02T00:00:00.000Z',
        },
      },
    });
  });
});
