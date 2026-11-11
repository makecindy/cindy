import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';
import { providerReferencePriceQuote, getModelPriceQuote, modelPricingKey } from '../../../shared/modelPriceQuote.js';

// Match the production catalog's stable snapshot: rebuilding these providers on every
// lookup makes each historical projection pay for the same account expansion repeatedly.
const accountCatalog = { ...BUNDLED_CATALOG, providers: [buildUserProvider({
    id: 'openai-account', name: 'Account', auth: { method: 'oauth', native: 'codex' },
    runtimes: { codex: { baseUrl: 'https://chatgpt.com/backend-api/codex', models: [{ id: 'gpt-5.6-luna', name: 'Luna' }] } },
  }), buildUserProvider({ id: 'router-account', name: 'Router', runtimes: {
    pi: { baseUrl: 'https://openrouter.ai/api/v1', wireProtocol: 'openai-chat', models: [
      { id: 'aion-labs/aion-3.0-mini', name: 'Aion' },
      { id: 'new/model', name: 'New', discoveredCost: { input: 0, output: 0.5 } },
    ] },
  } }), buildUserProvider({
    id: 'openrouter-oauth', name: 'OpenRouter',
    auth: { method: 'oauth', oauth: { authorizeUrl: 'https://openrouter.ai/auth', tokenUrl: 'https://openrouter.ai/api/v1/auth/keys', clientId: 'cindy', scopes: '' } },
    runtimes: { pi: { baseUrl: 'https://openrouter.ai/api/v1', wireProtocol: 'openai-chat', models: [
      { id: 'oauth/new', name: 'OAuth New', discoveredCost: { input: 0.1, output: 0.2 } },
    ] } },
  }), ...['mimo-account', 'mimo-second'].map(id => buildUserProvider({
    id, name: 'MiMo', runtimes: Object.fromEntries(
      (['claude-code', 'codex', 'pi'] as const).map(agent => [agent, {
        baseUrl: `https://token-plan-cn.xiaomimimo.com/${agent === 'claude-code' ? 'anthropic' : 'v1'}`,
        catalogPresetId: 'xiaomi-mimo-token-plan-cn',
        models: [{ id: 'mimo-v2.6-pro', name: 'MiMo' }],
      }]),
    ),
  })), ...(['claude', 'xai'] as const).map(native => {
    const provider = buildUserProvider({
      id: `${native}-account`, name: 'Account', auth: { method: 'oauth', native }, runtimes: {},
    });
    // The active catalog fills Claude membership from account discovery.
    if (native === 'claude') provider.models.codex = [{ id: 'claude-sonnet-4-6', name: 'Sonnet', contextWindow: 200000, efforts: [], defaultEffort: null }];
    return provider;
  })] };

vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => accountCatalog,
}));
vi.mock('../modelPriceOverrideStore.js', () => ({
  applyModelPriceOverrides: (pricing: unknown) => pricing,
  mergeStoredModelPriceOverride: vi.fn(),
  readModelPriceOverridesSnapshot: vi.fn(),
}));

import { accountReferencePriceQuote } from '../accountReferencePrice.js';
import { getReferenceModelPricing, getCodexProviderSubscriptionValuePrice } from '../referenceModelPricing.js';

describe('independent subscription account reference prices', () => {
  it.each(['claude-code', 'codex', 'pi'] as const)(
    'resolves MiMo %s prices through the preset while retaining account ownership', (agent) => {
      const model = 'mimo-v2.6-pro';
      const base = providerReferencePriceQuote('xiaomi-mimo-token-plan-cn', model,
        BUNDLED_CATALOG.modelRegistry, { agent, officialOnly: true });
      expect(base).toBeDefined();
      const own = { ...base!, providerId: 'mimo-account', source: 'user-override' as const,
        inputPerMtok: 123, outputPerMtok: 456 };
      const pricing = { 'mimo-account': { [modelPricingKey(model, agent)]: own } };
      expect(getCodexProviderSubscriptionValuePrice('mimo-account', model, {}, undefined, undefined, agent))
        .toEqual({ ...base, providerId: 'mimo-account', modelId: model });
      expect(getCodexProviderSubscriptionValuePrice('mimo-account', model, pricing, undefined, undefined, agent))
        .toEqual(own);
      expect(getCodexProviderSubscriptionValuePrice('mimo-second', model, pricing, undefined, undefined, agent))
        .toEqual({ ...base, providerId: 'mimo-second', modelId: model });
      expect(getCodexProviderSubscriptionValuePrice('mimo-account', 'unknown-model', {}, undefined, undefined, agent))
        .toBeUndefined();
    },
  );
  it('publishes imported and discovered BYOK prices under the actual connection and engine', () => {
    const pricing = getReferenceModelPricing();
    expect(getModelPriceQuote(pricing, 'router-account', 'aion-labs/aion-3.0-mini', 'pi'))
      .toMatchObject({ currency: 'USD', source: 'provider-reference', inputPerMtok: 0.7, outputPerMtok: 1.4 });
    expect(getModelPriceQuote(pricing, 'router-account', 'new/model', 'pi'))
      .toMatchObject({ inputPerMtok: 0, outputPerMtok: 0.5 });
    expect(getModelPriceQuote(pricing, 'another-account', 'new/model', 'pi')).toBeUndefined();
    expect(getModelPriceQuote(pricing, 'router-account', 'new/model', 'codex')).toBeUndefined();
    expect(getModelPriceQuote(pricing, 'openrouter-oauth', 'oauth/new', 'pi'))
      .toMatchObject({ inputPerMtok: 0.1, outputPerMtok: 0.2, source: 'provider-reference' });
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

// PR #8489 review: provider-share usage history values each day with that day's catalog.
// It must keep route tariffs (not the subscription-only manufacturer price), resolve a tariff
// that has expired by today, and leave gaps unpriced instead of borrowing another interval.
it('resolves the reference catalog for a historical day with route tariffs', () => {
  const registry = BUNDLED_CATALOG.modelRegistry!;
  const route = registry.models.find(model => model.id === 'openai/gpt-5.6-luna')!.routes[0];
  const original = route.referencePrices;
  const source = { kind: 'provider-official' as const, url: 'https://example.com', verifiedAt: '2026-01-01' };
  try {
    route.referencePrices = [
      { currency: 'USD', variant: 'standard', inputPerMtok: 111, outputPerMtok: 1,
        effectiveFrom: '2026-01-01', effectiveUntil: '2026-06-01', source },
      { currency: 'USD', variant: 'standard', inputPerMtok: 222, outputPerMtok: 1,
        effectiveFrom: '2026-06-01', effectiveUntil: '2026-08-01', source },
    ];
    const quote = (at?: string) => getModelPriceQuote(getReferenceModelPricing({ at }), 'openai', 'gpt-5.6-luna');
    expect(quote('2026-03-01')?.inputPerMtok).toBe(111);
    expect(quote('2026-07-01')?.inputPerMtok).toBe(222);
    expect(quote('2025-12-01')).toBeUndefined();
    expect(quote()).toBeUndefined();
    // Native subscription accounts in the same dated catalog still value from manufacturer prices.
    expect(getModelPriceQuote(getReferenceModelPricing({ at: '2026-07-15' }), 'openai-account', 'gpt-5.6-luna', 'codex'))
      .toMatchObject({ providerId: 'openai-account', inputPerMtok: 1 });
  } finally {
    if (original === undefined) delete route.referencePrices;
    else route.referencePrices = original;
  }
});
