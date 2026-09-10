import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';
import { providerReferencePriceQuote, getModelPriceQuote, modelPricingKey } from '../../../shared/modelPriceQuote.js';

vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => ({ ...BUNDLED_CATALOG, providers: [buildUserProvider({
    id: 'openai-account', name: 'Account', auth: { method: 'oauth', native: 'codex' },
    runtimes: { codex: { baseUrl: 'https://chatgpt.com/backend-api/codex', models: [{ id: 'gpt-5.6-luna', name: 'Luna' }] } },
  }), ...(['claude', 'xai'] as const).map(native => {
    const provider = buildUserProvider({
      id: `${native}-account`, name: 'Account', auth: { method: 'oauth', native }, runtimes: {},
    });
    // The active catalog fills Claude membership from account discovery.
    if (native === 'claude') provider.models.codex = [{ id: 'claude-sonnet-4-6', name: 'Sonnet', contextWindow: 200000, efforts: [], defaultEffort: null }];
    return provider;
  })] }),
}));
vi.mock('../modelPriceOverrideStore.js', () => ({
  applyModelPriceOverrides: (pricing: unknown) => pricing,
  mergeStoredModelPriceOverride: vi.fn(),
  readModelPriceOverridesSnapshot: vi.fn(),
}));

import { accountReferencePriceQuote } from '../accountReferencePrice.js';
import { getReferenceModelPricing, getCodexProviderSubscriptionValuePrice } from '../referenceModelPricing.js';

describe('independent subscription account reference prices', () => {
  it.each([
    ['claude', 'anthropic', 'claude-sonnet-4-6'],
    ['xai', 'xai', 'xai/grok-4.6'],
  ])('shares %s public tariffs without changing account attribution', (native, publicId, modelId) => {
    const options = { agent: 'codex' as const, at: '2026-09-09' };
    const base = providerReferencePriceQuote(publicId, modelId, BUNDLED_CATALOG.modelRegistry, options);
    expect(base).toBeDefined();
    const actual = accountReferencePriceQuote(`${native}-account`, modelId, BUNDLED_CATALOG.modelRegistry, options);
    expect(actual).toEqual({ ...base, providerId: `${native}-account`, modelId });
    expect(getCodexProviderSubscriptionValuePrice(`${native}-account`, modelId, {}, options.at)).toEqual(actual);
    expect(getModelPriceQuote(getReferenceModelPricing(), `${native}-account`, modelId, 'codex')).toMatchObject({
      providerId: `${native}-account`, modelId, source: 'provider-reference',
    });
  });
  it('shares historical public tariffs without changing account attribution', () => {
    const options = { agent: 'codex' as const, at: '2026-09-09' };
    const base = providerReferencePriceQuote('openai', 'gpt-5.6-luna', BUNDLED_CATALOG.modelRegistry, options);
    expect(base).toBeDefined();
    const actual = accountReferencePriceQuote('openai-account', 'gpt-5.6-luna', BUNDLED_CATALOG.modelRegistry, options);
    expect(actual).toEqual({ ...base, providerId: 'openai-account' });
    expect(getCodexProviderSubscriptionValuePrice('openai-account', 'gpt-5.6-luna', {}, options.at)).toEqual(actual);
    expect(accountReferencePriceQuote('unrelated', 'gpt-5.6-luna', BUNDLED_CATALOG.modelRegistry, options)).toBeUndefined();
  });
  it('publishes distinct model keys for Codex and Pi without borrowing default account overrides', () => {
    const pricing = getReferenceModelPricing();
    for (const [agent, model] of [['codex', 'gpt-5.6-luna'], ['pi', 'chatgpt/gpt-5.6-luna']] as const) {
      expect(getModelPriceQuote(pricing, 'openai-account', model, agent)).toMatchObject({
        providerId: 'openai-account', modelId: model, source: 'provider-reference',
      });
    }
  });
});

it.each(['pi', 'claude-code'] as const)('uses account overrides before public prices for %s', (agent) => {
  for (const [native, publicId, model] of [
    ['claude', 'anthropic', 'claude-sonnet-4-6'], ['xai', 'xai', 'xai/grok-4.6'],
  ]) {
    const providerId = `${native}-account`;
    const key = modelPricingKey(model, agent);
    const own = { providerId, modelId: model, currency: 'USD' as const,
      source: 'user-override' as const, approximate: false, inputPerMtok: 123, outputPerMtok: 456 };
    expect(getCodexProviderSubscriptionValuePrice(providerId, model, {
      [providerId]: { [key]: own },
      [publicId]: { [key]: { ...own, providerId: publicId, inputPerMtok: 999 } },
    }, undefined, undefined, agent)).toEqual(own);
    const base = providerReferencePriceQuote(publicId, model, BUNDLED_CATALOG.modelRegistry, { agent });
    expect(base).toBeDefined();
    expect(getCodexProviderSubscriptionValuePrice(providerId, model, {}, undefined, undefined, agent))
      .toEqual({ ...base, providerId, modelId: model });
  }
});
