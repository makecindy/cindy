import { describe, expect, it } from 'vitest';
import type { ByokModel, ByokProvider } from '@cindy/model-providers';
import { buildByokPricing } from '../byokPricing.js';
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
  it('keeps provider and engine identity, currency and cache rates without the retail discount', () => {
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
    expect(quote).not.toHaveProperty('costDiscount');
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
