import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { describe, expect, it, vi } from 'vitest';

import {
  gatewayPricingCatalog,
  registryPricingCatalog,
} from '../../../shared/modelPriceQuote.js';
import { gatewayMoney, usdMoney, type ModelPricingCatalog } from '../../../shared/regionalMoney.js';
import { buildTurnUsageDetails } from '../../../shared/turnUsageDetails.js';
import {
  adaptStoredTurnToSessionUsageTurn,
  buildConversationUsageFromStoredTurns,
  resolveConversationUsageSummary,
} from '../conversationUsageAdapter.js';

const REFERENCE_PRICING: ModelPricingCatalog = registryPricingCatalog(
  BUNDLED_CATALOG.modelRegistry,
);

const GATEWAY_PRICING: ModelPricingCatalog = gatewayPricingCatalog(
  [
    {
      id: 'openai/gpt-5.6-luna',
      currency: 'USD',
      inputCostPerToken: 0.000001,
      outputCostPerToken: 0.000004,
      cacheReadInputTokenCost: 0.0000001,
      costDiscount: 0.5,
    },
  ],
  'USD',
);

describe('conversationUsageAdapter (1.9b-2)', () => {
  it('prices a turn with recorded perModelCost money verbatim and wins over reference rates', () => {
    const details = buildTurnUsageDetails({
      inputTokens: 1_000,
      outputTokens: 500,
      model: 'claude-fable-5-1',
      provider: 'anthropic',
      perModelCost: [
        { model: 'claude-fable-5-1', money: usdMoney(0.03) },
        { model: 'claude-haiku-4-5', money: usdMoney(0.005) },
      ],
    })!;

    const summary = buildConversationUsageFromStoredTurns(
      [{ turnUsageDetails: details }],
      { referencePricing: REFERENCE_PRICING },
    );

    expect(summary.turns).toBe(1);
    expect(summary.totalTokens).toBe(1_500);
    expect(summary.costStatus).toBe('complete');
    // Recorded money (0.03 + 0.005 = 0.035) wins over the reference rate calculation.
    expect(summary.cost).toBe(0.035);
    expect(summary.currency).toBe('USD');
    expect(summary.unpricedModels).toEqual([]);
  });

  it('prices a Hermes turn without recorded money from the provider reference pricing catalog', () => {
    const details = buildTurnUsageDetails({
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheReadTokens: 5_000,
      cacheCreateTokens: 0,
      model: 'deepseek-flash',
      provider: 'deepseek',
    })!;

    const summary = buildConversationUsageFromStoredTurns(
      [{ turnUsageDetails: details, agent: 'hermes' }],
      { referencePricing: REFERENCE_PRICING },
    );

    // deepseek-flash in BUNDLED_CATALOG: USD 0.30/Mtok in, 1.20/Mtok out, 0.006/Mtok cacheRead.
    // 10_000 * 0.30/1e6 + 1_000 * 1.20/1e6 + 5_000 * 0.006/1e6 = 0.003 + 0.0012 + 0.00003 = 0.00423.
    expect(summary.turns).toBe(1);
    expect(summary.totalTokens).toBe(16_000);
    expect(summary.costStatus).toBe('complete');
    expect(summary.cost).toBe(0.00423);
    expect(summary.currency).toBe('USD');
    expect(summary.models[0]).toMatchObject({
      model: 'deepseek-flash',
      provider: 'deepseek',
      cost: 0.00423,
      currency: 'USD',
    });
  });

  it('prices a Gateway turn from gatewayPricing (including costDiscount) and never mixes reference prices into xd', () => {
    const details = buildTurnUsageDetails({
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheReadTokens: 20_000,
      model: 'openai/gpt-5.6-luna',
      provider: 'xd',
    })!;

    const summary = buildConversationUsageFromStoredTurns(
      [{ turnUsageDetails: details }],
      { gatewayPricing: GATEWAY_PRICING, referencePricing: REFERENCE_PRICING },
    );

    // Base: 0.1 * $1 + 0.01 * $4 + 0.02 * $0.1 = $0.142; with 50% discount = $0.071.
    expect(summary.costStatus).toBe('complete');
    expect(summary.cost).toBe(0.071);
    expect(summary.currency).toBe('USD');

    // A model present only in referencePricing must stay unpriced on the 'xd' route.
    const unpricedOnXd = buildConversationUsageFromStoredTurns(
      [
        {
          turnUsageDetails: buildTurnUsageDetails({
            inputTokens: 1_000,
            outputTokens: 500,
            model: 'deepseek-flash',
            provider: 'xd',
          })!,
        },
      ],
      { gatewayPricing: GATEWAY_PRICING, referencePricing: REFERENCE_PRICING },
    );
    expect(unpricedOnXd.costStatus).toBe('none');
    expect(unpricedOnXd.unpricedModels).toEqual(['deepseek-flash']);
  });

  it('leaves a turn unpriced when a non-zero token category has no rate (e.g. DeepSeek cache writes)', () => {
    const details = buildTurnUsageDetails({
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheCreateTokens: 500,
      model: 'deepseek-flash',
      provider: 'deepseek',
    })!;

    const summary = buildConversationUsageFromStoredTurns(
      [{ turnUsageDetails: details, agent: 'hermes' }],
      { referencePricing: REFERENCE_PRICING },
    );

    expect(summary.turns).toBe(1);
    expect(summary.totalTokens).toBe(11_500);
    expect(summary.costStatus).toBe('none');
    expect(summary.cost).toBe(0);
    expect(summary.unpricedModels).toEqual(['deepseek-flash']);
  });

  it('rolls a mixed conversation (recorded money + reference-priced Hermes + local + unpriced) into one honest summary', () => {
    const claudeRecorded = {
      turnUsageDetails: buildTurnUsageDetails({
        inputTokens: 2_000,
        outputTokens: 500,
        model: 'claude-fable-5-1',
        provider: 'anthropic',
        perModelCost: [{ model: 'claude-fable-5-1', money: usdMoney(0.025) }],
      })!,
    };
    const hermesReference = {
      turnUsageDetails: buildTurnUsageDetails({
        inputTokens: 10_000,
        outputTokens: 1_000,
        model: 'deepseek-v4-pro',
        provider: 'deepseek',
      })!,
      agent: 'hermes' as const,
    };
    const localTurn = {
      turnUsageDetails: buildTurnUsageDetails({
        inputTokens: 4_000,
        outputTokens: 800,
        model: 'qwen3-8b',
        provider: 'lmstudio-local',
      })!,
    };
    const unknownTurn = {
      turnUsageDetails: buildTurnUsageDetails({
        inputTokens: 1_000,
        outputTokens: 200,
        model: 'mystery-model-x',
        provider: 'deepseek',
      })!,
    };

    const summary = buildConversationUsageFromStoredTurns(
      [claudeRecorded, hermesReference, localTurn, unknownTurn],
      {
        referencePricing: REFERENCE_PRICING,
        localProviders: ['lmstudio-local'],
      },
    );

    // deepseek-v4-pro: 10_000 * 1.32/1e6 + 1_000 * 3.96/1e6 = 0.0132 + 0.00396 = 0.01716.
    // Total priced = 0.025 + 0.01716 = 0.04216.
    expect(summary.turns).toBe(4);
    expect(summary.totalTokens).toBe(2_500 + 11_000 + 4_800 + 1_200);
    expect(summary.costStatus).toBe('partial');
    expect(summary.cost).toBe(0.04216);
    expect(summary.currency).toBe('USD');
    expect(summary.unpricedModels).toEqual(['mystery-model-x']);
    expect(summary.models.find((m) => m.model === 'qwen3-8b')).toMatchObject({
      local: true,
      cost: null,
    });
  });

  it('strips context suffixes like [1m] before looking up pricing and preserves session fallbacks', () => {
    const turn = adaptStoredTurnToSessionUsageTurn(
      {
        turnUsageDetails: buildTurnUsageDetails({
          inputTokens: 1_000,
          outputTokens: 500,
          model: 'claude-fable-5-1[1m]',
        })!,
      },
      {
        referencePricing: REFERENCE_PRICING,
        defaultProvider: 'anthropic',
        agent: 'claude-code',
      },
    );

    expect(turn).not.toBeNull();
    expect(turn?.rates).toMatchObject({
      currency: 'USD',
      inputPerMtok: 10,
      outputPerMtok: 50,
    });
  });

  it('resolves gateway and reference catalogs asynchronously when not pre-supplied', async () => {
    const readGatewayPricing = vi.fn(async () => GATEWAY_PRICING);
    const readReferencePricing = vi.fn(() => REFERENCE_PRICING);

    const summary = await resolveConversationUsageSummary(
      [
        {
          turnUsageDetails: {
            inputTokens: 10_000,
            outputTokens: 1_000,
            model: 'deepseek-flash',
            provider: 'deepseek',
          },
          agent: 'hermes',
        },
        {
          turnUsageDetails: {
            inputTokens: 100_000,
            outputTokens: 10_000,
            model: 'openai/gpt-5.6-luna',
            provider: 'xd',
          },
        },
      ],
      {},
      { readGatewayPricing, readReferencePricing },
    );

    expect(readGatewayPricing).toHaveBeenCalledTimes(1);
    expect(readReferencePricing).toHaveBeenCalledTimes(1);
    expect(summary.turns).toBe(2);
    expect(summary.costStatus).toBe('complete');
    // 0.0042 (deepseek-flash without cache) + 0.070 (gpt-5.6-luna with 50% discount) = 0.0742
    expect(summary.cost).toBe(0.0742);
    expect(summary.currency).toBe('USD');
  });

  it('refuses mixed-currency perModelCost on a single turn rather than dropping one currency', () => {
    const summary = buildConversationUsageFromStoredTurns([
      {
        turnUsageDetails: {
          inputTokens: 1_000,
          outputTokens: 500,
          totalTokens: 1_500,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          cacheHitRate: 0,
          model: 'claude-fable-5-1',
          perModelCost: [
            { model: 'claude-fable-5-1', money: usdMoney(0.02) },
            { model: 'cny-subagent', money: gatewayMoney(0.14, 'CNY') },
          ],
        },
      },
    ]);

    expect(summary.costStatus).toBe('none');
    expect(summary.unpricedModels).toEqual(['claude-fable-5-1']);
  });
});
