import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';
import { providerReferencePriceQuote, getModelPriceQuote, modelPricingKey } from '../../../shared/modelPriceQuote.js';

vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => ({ ...BUNDLED_CATALOG, providers: [buildUserProvider({
    id: 'openai-account', name: 'Account', auth: { method: 'oauth', native: 'codex' },
    runtimes: { codex: { baseUrl: 'https://chatgpt.com/backend-api/codex', models: [{ id: 'gpt-5.6-luna', name: 'Luna' }] } },
  }), buildUserProvider({ id: 'router-account', name: 'Router', runtimes: {
    pi: { baseUrl: 'https://openrouter.ai/api/v1', wireProtocol: 'openai-chat', models: [
      { id: 'aion-labs/aion-3.0-mini', name: 'Aion' },
      { id: 'new/model', name: 'New', discoveredCost: { input: 0, output: 0.5 } },
    ] },
  } }), ...(['claude', 'xai'] as const).map(native => {
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
  it('publishes imported and discovered BYOK prices under the actual connection and engine', () => {
    const pricing = getReferenceModelPricing();
    expect(getModelPriceQuote(pricing, 'router-account', 'aion-labs/aion-3.0-mini', 'pi'))
      .toMatchObject({ currency: 'USD', source: 'provider-reference', inputPerMtok: 0.7, outputPerMtok: 1.4 });
    expect(getModelPriceQuote(pricing, 'router-account', 'new/model', 'pi'))
      .toMatchObject({ inputPerMtok: 0, outputPerMtok: 0.5 });
    expect(getModelPriceQuote(pricing, 'another-account', 'new/model', 'pi')).toBeUndefined();
    expect(getModelPriceQuote(pricing, 'router-account', 'new/model', 'codex')).toBeUndefined();
  });
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

it('values subscriptions from manufacturer prices even when the supplier publishes a different tariff', () => {
  const registry = BUNDLED_CATALOG.modelRegistry!;
  const entry = registry.models.find(model => model.id === 'openai/gpt-5.6-luna')!;
  const route = entry.routes[0];
  const original = route.referencePrices;
  const official = registry.baseModels!.find(model => model.id === entry.modelRef)!.referencePriceGroups![0].prices;
  try {
    route.referencePrices = official.map(price => ({ ...price, inputPerMtok: 999, cacheWritePerMtok: undefined }));
    expect(accountReferencePriceQuote('openai-account', 'gpt-5.6-luna', registry)?.inputPerMtok).toBe(999);
    for (const agent of ['codex', 'claude-code', 'pi'] as const) {
      expect(getCodexProviderSubscriptionValuePrice('openai-account', 'gpt-5.6-luna', {}, '2026-09-11', undefined, agent))
        .toMatchObject({ inputPerMtok: 0.2, cacheCreatePerMtok: 0.25, providerId: 'openai-account' });
    }
    expect(getCodexProviderSubscriptionValuePrice('xd', 'openai/gpt-5.6-luna', {})).toBeUndefined();
  } finally {
    if (original === undefined) delete route.referencePrices;
    else route.referencePrices = original;
  }
});
