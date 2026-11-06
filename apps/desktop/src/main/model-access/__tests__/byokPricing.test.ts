import { describe, expect, it } from 'vitest';
import type { ByokModel, ByokProvider } from '@cindy/model-providers';
import { buildByokPricing } from '../byokPricing.js';
import { computePriceQuoteTurnMoney, resolveTurnCost } from '../../usage/turnCostCalculator.js';
import { gatewayModelPriceQuote, modelPricingKey } from '../../../shared/modelPriceQuote.js';
const model: ByokModel = {
  id: 'byok/a/chat',
  agents: ['pi', 'codex'],
  currency: 'CNY',
  perAgent: {
    pi: { wireProtocol: 'openai-completions' },
    codex: { wireProtocol: 'openai-responses' },
  },
  inputCostPerToken: 0.000002,
  outputCostPerToken: 0.000006,
  cacheReadInputTokenCost: 0,
  cacheCreationInputTokenCost: 0.000001,
  costDiscount: 0.5,
};
const provider = (entry: ByokModel, id = 'byok-a'): ByokProvider => ({
  id,
  name: 'Enterprise',
  connectionRevision: 1,
  models: [entry],
});
describe('enterprise reference price projection', () => {
  it('keeps provider and engine identity, currency and cache rates with the enterprise discount', () => {
    const catalog = buildByokPricing([
      provider(model),
      provider({ ...model, currency: 'USD' }, 'byok-b'),
    ]);
    const quote = catalog['byok-a'][modelPricingKey(model.id, 'pi')];
    expect(quote).toMatchObject({
      providerId: 'byok-a',
      currency: 'CNY',
      source: 'provider-reference',
      approximate: true,
      inputPerMtok: 2,
      outputPerMtok: 6,
      cacheReadPerMtok: 0,
      cacheCreatePerMtok: 1,
    });
    expect(quote.costDiscount).toBe(0.5);
    expect(catalog['byok-a'][modelPricingKey(model.id, 'codex')]).toEqual(quote);
    expect(catalog['byok-b'][modelPricingKey(model.id, 'pi')].currency).toBe('USD');
  });
  it('preserves explicit free models without changing the legacy gateway zero-price behavior', () => {
    const free = {
      ...model,
      inputCostPerToken: 0,
      outputCostPerToken: 0,
      cacheCreationInputTokenCost: 0,
    };
    expect(
      buildByokPricing([provider(free)])['byok-a'][modelPricingKey(model.id, 'pi')].inputPerMtok,
    ).toBe(0);
    expect(gatewayModelPriceQuote(free, 'CNY')).toBeUndefined();
  });
  it('does not infer currency or replace unknown prices with zero', () => {
    expect(buildByokPricing([provider({ ...model, currency: undefined })])['byok-a']).toEqual({});
    expect(
      buildByokPricing([provider({ ...model, outputCostPerToken: undefined })])['byok-a'],
    ).toEqual({});
  });
});

// Regression: the directory discount was discarded before reference money calculation.
// Existing tests asserted that loss. Public build -> resolve verifies money and its kind;
// two completed requests in different tiers expose both missing and double discounts. Tier: unit.
describe('enterprise discounted reference money', () => {
  const tokens = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheCreateTokens: 10 };
  const larger = { inputTokens: 200, outputTokens: 30, cacheReadTokens: 50, cacheCreateTokens: 20 };
  const pricedModel = (costDiscount?: number): ByokModel => ({
    ...model, currency: 'USD', costDiscount, agents: ['claude-code'],
    perAgent: { 'claude-code': { wireProtocol: 'anthropic-messages' } },
    cacheReadInputTokenCost: 0.0000005,
    tieredPricing: [
      { range: [0, 200], inputCostPerToken: 0.000002, outputCostPerToken: 0.000006 },
      { range: [200, 1000], inputCostPerToken: 0.000004, outputCostPerToken: 0.000012,
        cacheReadInputTokenCost: 0.000001, cacheCreationInputTokenCost: 0.000002 },
    ],
  });
  const context = { providerId: 'byok-a', billingRoute: 'provider-api', accessKind: 'managed', region: 'global' } as const;

  it.each([undefined, 0, 0.2, 1])('applies discount %s once across input, output, caches and request tiers', (discount) => {
    const pricing = buildByokPricing([provider(pricedModel(discount))]);
    const quote = pricing['byok-a'][modelPricingKey(model.id, 'claude-code')];
    const money = computePriceQuoteTurnMoney(tokens, quote, 'USD');
    expect(money?.amount).toBeCloseTo(0.00035 * (1 - (discount ?? 0)), 10);
    const resolved = resolveTurnCost({
      rawModel: model.id, tokens, pricing, context, sdkCostDelta: 99,
      segments: [tokens, larger],
    });
    expect(resolved.money).toMatchObject({ currency: 'USD', kind: 'value-estimate', approximate: true });
    expect(resolved.money?.amount).toBeCloseTo(0.0016 * (1 - (discount ?? 0)), 10);
    expect(resolved.source).toBe('reference');
    expect(quote.inputPerMtok).toBe(2);
  });

  it.each(['alias', 'missing-price'] as const)('keeps %s token-only even with a reported SDK amount', (scenario) => {
    const entry = pricedModel(0.2);
    const pricing = buildByokPricing([provider(scenario === 'missing-price' ? { ...entry, outputCostPerToken: undefined } : entry)]);
    expect(resolveTurnCost({ rawModel: scenario === 'alias' ? 'upstream-alias' : model.id,
      tokens, pricing, context, sdkCostDelta: 99 }).money).toBeNull();
  });
});

// Regression: Pi-only BYOK has no generic or Claude Code price key. Existing managed tests
// used Claude Code; resolveTurnCost must use the actual engine and preserve its old default. Tier: unit.
it('prices a Pi-only enterprise model using its Pi quote', () => {
  const piOnly: ByokModel = { ...model, currency: 'USD', costDiscount: 0.2,
    agents: ['pi'], perAgent: { pi: { wireProtocol: 'openai-completions' } } };
  const request = {
    rawModel: piOnly.id,
    tokens: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreateTokens: 0 },
    pricing: buildByokPricing([provider(piOnly)]),
    context: { providerId: 'byok-a', billingRoute: 'provider-api', accessKind: 'managed', region: 'global' } as const,
  };
  const money = resolveTurnCost({ ...request, agent: 'pi' }).money;
  expect(money?.amount).toBeCloseTo(6.4);
  expect(money).toMatchObject({ kind: 'value-estimate', currency: 'USD', approximate: true });
  expect(resolveTurnCost(request).money).toBeNull();
});
