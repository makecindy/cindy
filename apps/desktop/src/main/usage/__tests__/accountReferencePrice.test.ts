import { setActiveLedgerCurrency, __resetActiveLedgerCurrencyForTesting } from '../ledgerCurrency.js';
import { applyModelPriceOverrides } from '../modelPriceOverrideStore.js';
import { resolveTurnCost } from '../turnCostCalculator.js';
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
        wireProtocol: agent === 'claude-code' ? 'anthropic-messages' : 'openai-chat',
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
vi.mock('../modelPriceOverrideStore.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modelPriceOverrideStore.js')>(),
  applyModelPriceOverrides: vi.fn((pricing: unknown) => pricing),
  mergeStoredModelPriceOverride: vi.fn(),
  readModelPriceOverridesSnapshot: vi.fn(),
}));

import { accountReferencePriceQuote } from '../accountReferencePrice.js';
import { BrowserWindow } from 'electron';
import type { CatalogModel } from '@cindy/model-providers';
import { projectSubscriptionPoolCatalog } from '../../maker-host/subscriptionPoolCatalog.js';
import {
  broadcastReferenceModelPricing, followReferenceModelPricingAfterProviderChange,
  getReferenceModelPricing, getCodexProviderSubscriptionValuePrice, REFERENCE_MODEL_PRICING_CHANGED_CHANNEL,
  setReferencePricingDisplayProviders,
} from '../referenceModelPricing.js';

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

// Unit: an independent ChatGPT account page showed no price tier for the models its own
// account discovery added (GPT-6.2 Sol / Astra, 2026-11-18). Those models are not in the active
// catalog: projectSubscriptionPoolCatalog adds them for the lists the renderer shows, and the
// broadcast must quote that same membership. Entry: the main-side broadcast the renderer
// subscribes to, through the real pool projection.
it('quotes models added by an account\'s own discovery, once per burst and only when prices change', async () => {
  const sent: Array<Record<string, Record<string, unknown>>> = [];
  const windows = vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([{
    isDestroyed: () => false,
    webContents: { send: (channel: string, pricing: never) => {
      if (channel === REFERENCE_MODEL_PRICING_CHANGED_CHANNEL) sent.push(pricing);
    } },
  } as never]);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const known = accountCatalog.providers.find(provider => provider.id === 'openai-account')!.models.codex![0]!;
  let discovered: CatalogModel[] = [];
  setReferencePricingDisplayProviders(() => projectSubscriptionPoolCatalog(accountCatalog, {
    readPool: () => ({ legacyCodexAccounts: { 'openai-account': 'pool-account' }, accounts: [{ id: 'pool-account' }] }) as never,
    codexAccountState: () => ({ authenticated: true }),
    readSubscriptionPoolCodexModels: providerId => providerId === 'openai-account' ? discovered : null,
    getActiveCatalogWithCodexModels: models => ({ ...accountCatalog, providers: [{
      ...accountCatalog.providers[0]!, id: 'openai', models: { codex: [...models] },
    }] }),
    readSubscriptionPoolClaudeModels: () => null,
    getActiveCatalogWithClaudeModels: () => accountCatalog,
    readMergedProviderAccount: () => undefined,
    accountProviderId: () => 'openai-account',
    readProviderBoundAccountIds: () => new Set<string>(),
  }, true).providers);
  const key = modelPricingKey('gpt-5.6-sol', 'codex');
  try {
    broadcastReferenceModelPricing();
    expect(sent).toHaveLength(1);
    expect(sent[0]['openai-account'][modelPricingKey(known.id, 'codex')]).toBeDefined();
    expect(sent[0]['openai-account'][key]).toBeUndefined();

    // Provider changed, prices did not: nothing is sent.
    followReferenceModelPricingAfterProviderChange();
    await tick();
    expect(sent).toHaveLength(1);

    // The account discovers a model the active catalog does not list for it.
    discovered = [{ ...known, id: 'gpt-5.6-sol', name: 'Sol' }];
    expect(getReferenceModelPricing()['openai-account'][key]).toBeUndefined();
    for (let i = 0; i < 5; i++) followReferenceModelPricingAfterProviderChange();
    expect(sent).toHaveLength(1);
    await tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]['openai-account'][key]).toMatchObject({ providerId: 'openai-account', modelId: 'gpt-5.6-sol' });

    await tick();
    expect(sent).toHaveLength(2);
  } finally {
    setReferencePricingDisplayProviders(null);
    windows.mockRestore();
  }
});

// Unit: the follow-up runs in setImmediate, where an escaping error becomes an
// uncaughtException and the main process shuts down (review on #11203). A closing window
// or a failing account read must cost one price update, not the app.
it('keeps a failing window or account read inside the deferred follow-up', async () => {
  const received: unknown[] = [];
  const windows = vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([
    { isDestroyed: () => false, webContents: { send: () => { throw new Error('Object has been destroyed'); } } },
    { isDestroyed: () => false, webContents: { send: (_channel: string, pricing: unknown) => received.push(pricing) } },
  ] as never);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const account = accountCatalog.providers.find(provider => provider.id === 'openai-account')!;
  const before = account.models.codex!;
  try {
    broadcastReferenceModelPricing();
    expect(received).toHaveLength(1);

    account.models.codex = [...before, { ...before[0]!, id: 'gpt-5.6-sol', name: 'Sol' }];
    followReferenceModelPricingAfterProviderChange();
    await tick();
    expect(received).toHaveLength(2);

    setReferencePricingDisplayProviders(() => { throw new Error('pool unreadable'); });
    followReferenceModelPricingAfterProviderChange();
    await tick();
    expect(received).toHaveLength(2);
  } finally {
    account.models.codex = before;
    setReferencePricingDisplayProviders(null);
    windows.mockRestore();
  }
});

// Unit: dated, tiered Model Registry tariffs must win over static provider-models.json
// `model.cost` on preset-backed API-key connections (default and custom multi-account IDs),
// deprecation cutoffs must not fall back to static costs, and non-Registry providers
// (such as OpenRouter) keep imported `model.cost` including tiered long-context bands.
describe('API-key preset reference prices and static cost precedence', () => {
  const geminiAccount = buildUserProvider({
    id: 'gemini-work',
    name: 'Gemini Work',
    runtimes: {
      pi: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        catalogPresetId: 'google-gemini-api',
        models: [
          { id: 'gemini-4-neon', name: 'Gemini 4 Neon', api: 'google-generative-ai' },
          { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', api: 'google-generative-ai' },
          { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', api: 'google-generative-ai' },
          { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', api: 'google-generative-ai' },
        ],
      },
    },
  });
  const openaiApiAccount = buildUserProvider({
    id: 'openai-api-work',
    name: 'OpenAI API Work',
    runtimes: {
      codex: {
        baseUrl: 'https://api.openai.com/v1',
        catalogPresetId: 'openai-api',
        models: [{ id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }],
      },
    },
  });
  const xaiApiAccount = buildUserProvider({
    id: 'xai-api-work',
    name: 'xAI API Work',
    runtimes: {
      pi: {
        baseUrl: 'https://api.x.ai/v1',
        wireProtocol: 'openai-responses',
        catalogPresetId: 'xai-api',
        models: [{ id: 'grok-4.7', name: 'Grok 4.7' }],
      },
    },
  });
  const openrouterGemini = buildUserProvider({
    id: 'openrouter-work',
    name: 'OpenRouter Work',
    runtimes: {
      pi: {
        baseUrl: 'https://openrouter.ai/api/v1',
        wireProtocol: 'openai-chat',
        models: [{ id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' }],
      },
    },
  });
  it.each([['USD', 1.9437], ['CNY', 13]] as const)(
    'estimates Kimi usage with a price supported by the %s ledger', async (currency, amount) => {
      const realStore = await vi.importActual<typeof import('../modelPriceOverrideStore.js')>('../modelPriceOverrideStore.js');
      vi.mocked(applyModelPriceOverrides).mockImplementationOnce(realStore.applyModelPriceOverrides);
      setActiveLedgerCurrency(currency);
      try {
        const provider = buildUserProvider({ id: 'moonshot-kimi-cn', name: 'Kimi', runtimes: { pi: {
          baseUrl: 'https://api.moonshot.cn/v1', wireProtocol: 'openai-chat', catalogPresetId: 'moonshot-kimi-cn',
          models: [{ id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro' }],
        } } });
        const pricing = getReferenceModelPricing({ at: '2026-11-20', providers: [provider], overrides: {} });
        expect(resolveTurnCost({
          agent: 'pi', rawModel: 'kimi-k3.1-pro', pricing,
          tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
          context: { providerId: provider.id, billingRoute: 'provider-api', region: 'global' },
        })).toMatchObject({ source: 'reference', money: { currency, amount, kind: 'value-estimate' } });
      } finally {
        __resetActiveLedgerCurrencyForTesting();
      }
    },
  );
  it.each([
    ['https://api.deepseek.com/v1', undefined],
    ['https://api.deepseek.com', '/chat/completions'],
    ['https://api.deepseek.com/v1/', '/chat/completions'],
  ] as const)('estimates cached DeepSeek tokens on the official route %s %s', (baseUrl, requestPath) => {
    for (const currentModel of ['deepseek-v4-pro', 'deepseek-flash']) {
      const provider = buildUserProvider({ id: 'deepseek', name: 'DeepSeek', runtimes: { pi: {
        baseUrl, wireProtocol: 'openai-chat', requestPath, catalogPresetId: 'deepseek',
        models: [{ id: currentModel, name: currentModel }],
      } } });
      const pricing = getReferenceModelPricing({ at: '2026-11-20', providers: [provider] });
      for (const sdkCostDelta of [1.32, undefined]) {
        expect(resolveTurnCost({
          agent: 'pi', rawModel: 'deepseek-v4-pro', sdkCostDelta, pricing,
          tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreateTokens: 0 },
          context: { providerId: 'deepseek', billingRoute: 'provider-api', region: 'global' },
        })).toMatchObject({ source: 'reference', money: { amount: 0.044, currency: 'USD', kind: 'value-estimate' } });
      }
    }
  });
  it('prices removed DeepSeek models only on an official historical route', () => {
    const runtime = { baseUrl: 'https://api.deepseek.com', wireProtocol: 'openai-chat' as const,
      catalogPresetId: 'deepseek', models: [{ id: 'deepseek-flash', name: 'Flash' }] };
    const relay = { ...runtime, baseUrl: 'https://relay.example/v1' };
    const project = (runtimes: Parameters<typeof buildUserProvider>[0]['runtimes']) =>
      getReferenceModelPricing({ at: '2026-11-20', providers: [buildUserProvider({
        id: 'deepseek', name: 'DeepSeek', runtimes,
      })] });
    const model = 'deepseek-v4-pro';
    const expected = { inputPerMtok: 1.32, outputPerMtok: 3.96 };
    const official = project({ pi: runtime });
    expect(getModelPriceQuote(official, 'deepseek', model, 'pi')).toMatchObject(expected);
    expect(getModelPriceQuote(official, 'deepseek', model)).toMatchObject(expected);
    const mixed = project({ pi: runtime, codex: relay });
    expect(getModelPriceQuote(mixed, 'deepseek', model, 'pi')).toMatchObject(expected);
    expect(getModelPriceQuote(mixed, 'deepseek', model, 'codex')).toBeUndefined();
    expect(getModelPriceQuote(mixed, 'deepseek', model)).toBeUndefined();
    expect(getModelPriceQuote(project({ pi: { ...runtime, requestPath: '/custom' } }), 'deepseek', model, 'pi')).toBeUndefined();
  });
  it('retains removed Gemini models on the declared native endpoint until the tariff expires', () => {
    const provider = buildUserProvider({ id: 'google-gemini-api', name: 'Native', runtimes: { pi: {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta', wireProtocol: 'google-generative-ai',
      models: [{ id: 'gemini-4-carbon', name: 'Carbon' }],
    } } });
    const quote = (at: string) => getModelPriceQuote(getReferenceModelPricing({ at, providers: [provider] }),
      provider.id, 'gemini-2.5-pro', 'pi');
    expect(quote('2026-11-20')).toMatchObject({ inputPerMtok: 1.25, outputPerMtok: 10 });
    expect(quote('2026-12-01')).toBeUndefined();
  });
  it.each([true, false])('keeps relay estimates local when a discovered price is present: %s', hasCost => {
    const relay = buildUserProvider({ id: 'openai-api', name: 'Relay', runtimes: { pi: {
      baseUrl: 'https://relay.example/v1', catalogPresetId: 'openai-api',
      models: [{ id: 'gpt-6.2-sol', name: 'Sol', ...(hasCost ? { discoveredCost: { input: 0.5, output: 1 } } : {}) }],
    } } });
    const pricing = getReferenceModelPricing({ at: '2026-11-20', providers: [relay] });
    const quote = getModelPriceQuote(pricing, relay.id, 'gpt-6.2-sol', 'pi');
    if (hasCost) expect(quote).toMatchObject({ inputPerMtok: 0.5, outputPerMtok: 1 });
    else expect(quote).toBeUndefined();
  });
  it.each([
    { wireProtocol: 'openai-responses' as const, requestPath: '/custom' },
    { wireProtocol: 'anthropic-messages' as const },
  ])('preserves discovered prices on a custom request path or protocol', route => {
    const account = buildUserProvider({ id: 'custom-openai', name: 'Custom', runtimes: { pi: {
      baseUrl: 'https://api.openai.com/v1', catalogPresetId: 'openai-api',
      models: [{ id: 'gpt-6.2-sol', name: 'Sol', api: route.wireProtocol,
        route: { baseUrl: 'https://api.openai.com/v1', ...route }, discoveredCost: { input: 0.5, output: 1 } }],
    } } });
    const pricing = getReferenceModelPricing({ at: '2026-11-20', providers: [account] });
    expect(getModelPriceQuote(pricing, account.id, 'gpt-6.2-sol', 'pi')).toMatchObject({ inputPerMtok: 0.5, outputPerMtok: 1 });
  });
  const constructorIdAccount = buildUserProvider({
    id: 'constructor',
    name: 'Constructor',
    runtimes: {
      pi: {
        baseUrl: 'https://openrouter.ai/api/v1',
        wireProtocol: 'openai-chat',
        models: [{ id: 'new/model', name: 'New', discoveredCost: { input: 0.4, output: 1.6 } }],
      },
    },
  });

  it('prefers dated, tiered Registry tariffs over static model.cost on custom API-key accounts', () => {
    // Confirm the native Gemini connection actually carries imported model.cost from provider-models.json,
    // so the assertions below genuinely exercise Registry precedence, pre-adoption fallback and cutoff gating.
    expect(geminiAccount.models.pi?.find(m => m.id === 'gemini-4-carbon')?.cost).toMatchObject({ input: 2, output: 10 });
    expect(geminiAccount.models.pi?.find(m => m.id === 'gemini-2.5-pro')?.cost).toMatchObject({ input: 1.25, output: 10 });
    const providers = [geminiAccount, openaiApiAccount, xaiApiAccount, openrouterGemini, constructorIdAccount];
    const nov19 = getReferenceModelPricing({ at: '2026-11-19', providers });
    const nov20 = getReferenceModelPricing({ at: '2026-11-20', providers });
    const dec01 = getReferenceModelPricing({ at: '2026-12-01', providers });

    // Custom multi-account google-gemini-api resolves Registry tariffs including Priority.
    expect(getModelPriceQuote(nov20, 'gemini-work', 'gemini-4-neon', 'pi')).toMatchObject({
      providerId: 'gemini-work',
      currency: 'USD',
      inputPerMtok: 3,
      outputPerMtok: 15,
      cacheReadPerMtok: 0.15,
      priority: { inputPerMtok: 5.4, outputPerMtok: 27, cacheReadPerMtok: 0.27 },
    });

    // Scheduled 2026-12-01 price increase on gemini-4-carbon is NOT shadowed by static model.cost.
    expect(getModelPriceQuote(nov20, 'gemini-work', 'gemini-4-carbon', 'pi')).toMatchObject({
      inputPerMtok: 2, outputPerMtok: 10, cacheReadPerMtok: 0.1,
    });
    expect(getModelPriceQuote(dec01, 'gemini-work', 'gemini-4-carbon', 'pi')).toMatchObject({
      inputPerMtok: 4, outputPerMtok: 20, cacheReadPerMtok: 0.2,
    });

    // Long-context >200K band survives on google-gemini-api.
    expect(getModelPriceQuote(nov20, 'gemini-work', 'gemini-3.1-pro-preview', 'pi')?.inputTokenPriceBands).toEqual([
      expect.objectContaining({ minInputTokens: 0, maxInputTokens: 200001, inputPerMtok: 2, outputPerMtok: 12 }),
      expect.objectContaining({ minInputTokens: 200001, inputPerMtok: 4, outputPerMtok: 18 }),
    ]);

    // Deprecated gemini-2.5-pro preserves model.cost fallback on pre-adoption historical days
    // (2026-11-19), uses Registry on 2026-11-20, and stops pricing on 2026-12-01 without
    // resurrecting static model.cost after its deprecation cutoff.
    expect(getModelPriceQuote(nov19, 'gemini-work', 'gemini-2.5-pro', 'pi')).toMatchObject({
      inputPerMtok: 1.25, outputPerMtok: 10,
    });
    expect(getModelPriceQuote(nov20, 'gemini-work', 'gemini-2.5-pro', 'pi')).toMatchObject({
      inputPerMtok: 1.25, outputPerMtok: 10,
    });
    expect(getModelPriceQuote(dec01, 'gemini-work', 'gemini-2.5-pro', 'pi')).toBeUndefined();

    // Official direct preset openai-api resolves to canonical openai Registry tariffs.
    expect(getModelPriceQuote(nov20, 'openai-api-work', 'gpt-6.2-sol', 'codex')).toMatchObject({
      providerId: 'openai-api-work',
      currency: 'USD',
      inputPerMtok: 2,
      outputPerMtok: 10,
    });

    // Official direct preset xai-api with bare model ID resolves xai/grok-4.7 Registry
    // tariffs (including Fast/priority) while keeping the connection's original bare ID.
    expect(getModelPriceQuote(nov20, 'xai-api-work', 'grok-4.7', 'pi')).toMatchObject({
      providerId: 'xai-api-work',
      modelId: 'grok-4.7',
      currency: 'USD',
      inputPerMtok: 2,
      outputPerMtok: 6,
      cacheReadPerMtok: 0.5,
      priority: { inputPerMtok: 4, outputPerMtok: 12, cacheReadPerMtok: 1 },
    });

    // Provider IDs matching Object.prototype keys (e.g. "constructor") never throw or break catalog build.
    expect(getModelPriceQuote(nov20, 'constructor', 'new/model', 'pi')).toMatchObject({
      providerId: 'constructor',
      modelId: 'new/model',
      inputPerMtok: 0.4,
      outputPerMtok: 1.6,
    });

    // Non-Registry providers (OpenRouter) keep imported model.cost and project cost.tiers.
    expect(getModelPriceQuote(nov20, 'openrouter-work', 'google/gemini-3.1-pro-preview', 'pi')).toMatchObject({
      providerId: 'openrouter-work',
      inputPerMtok: 2,
      outputPerMtok: 12,
      inputTokenPriceBands: [
        expect.objectContaining({ minInputTokens: 0, maxInputTokens: 200001, inputPerMtok: 2, outputPerMtok: 12 }),
        expect.objectContaining({ minInputTokens: 200001, inputPerMtok: 4, outputPerMtok: 18 }),
      ],
    });
  });
});
