import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider, type CatalogModel } from '@cindy/model-providers';
import {
  getActiveCatalog, setActiveCatalog, setCustomProviders, setDiscoveredCodexModels,
  setLocalCatalogOverrides,
} from '../active-catalog.js';
import { EMPTY_MODEL_CATALOG_OVERRIDES, hasLocalAddition, sanitizeModelCatalogOverrides } from '../model-plane/localCatalogOverrides.js';

const accountId = 'openai-independent';
function account() {
  return buildUserProvider({
    id: accountId, name: 'OpenAI', auth: { method: 'oauth', native: 'codex' },
    runtimes: { codex: { baseUrl: 'https://chatgpt.com/backend-api/codex',
      models: [{ id: 'gpt-5.6-luna', name: 'Luna' }],
    } },
  }, { modelRegistry: BUNDLED_CATALOG.modelRegistry });
}
function entry(providerId: string, agent: 'codex' | 'claude-code' | 'pi', id: string) {
  return getActiveCatalog().providers.find(p => p.id === providerId)!.models[agent]!.find(m => m.id === id)!;
}

afterEach(() => {
  setCustomProviders([]);
  setDiscoveredCodexModels([]);
  setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
  setActiveCatalog(BUNDLED_CATALOG);
});

describe('OpenAI account catalog identity', () => {
  it.each([false, true])('Pro/Cyber keep all Harness routes with old missing metadata (%s)', (oldSnapshot) => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    const slugs = ['gpt-5.4-pro', 'gpt-5.5-pro', 'gpt-5.6-cyber'];
    if (oldSnapshot) {
      for (const base of catalog.modelRegistry!.baseModels ?? []) {
        if (!slugs.some(slug => base.id === `openai/${slug}`)) continue;
        delete base.defaults.efforts;
        delete base.defaults.defaultEffort;
      }
    }
    const provider = catalog.providers.find(p => p.id === 'openai')!;
    provider.models.pi = slugs.map(slug => ({ id: `chatgpt/${slug}`, name: slug,
      contextWindow: 400000, efforts: [], defaultEffort: null, piApi: 'openai-responses' }));
    setActiveCatalog(catalog, { authorityCatalog: catalog });
    setCustomProviders([account()]);
    for (const providerId of ['openai', accountId]) {
      for (const agent of ['codex', 'claude-code', 'pi'] as const) {
        for (const slug of slugs) {
          expect(entry(providerId, agent, agent === 'codex' ? slug : `chatgpt/${slug}`))
            .toMatchObject({ efforts: [], defaultEffort: null });
        }
      }
    }
  });

  it('does not use an addition incomplete for the actual root to revive a retired model', () => {
    const { overrides } = sanitizeModelCatalogOverrides({ additions: {
      [`${accountId}:gpt-incomplete`]: {
        base: { name: 'Incomplete for Codex' },
        perAgent: { 'claude-code': { contextWindow: 120000, efforts: [], defaultEffort: null } },
      },
    } });
    expect(overrides.additions[`${accountId}:gpt-incomplete`]).toBeDefined();
    expect(hasLocalAddition(overrides, accountId, 'gpt-incomplete', 'codex', 'openai')).toBe(false);
  });
  it('materializes a complete local addition only for the matching subscription connection', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setCustomProviders([account(), buildUserProvider({
      id: 'api-independent', name: 'OpenAI', runtimes: { codex: {
        baseUrl: 'https://api.example/v1', models: [{ id: 'existing-model', name: 'Existing' }],
      } },
    })]);
    const addition = { base: { name: 'Local model', contextWindow: 120000, efforts: [], defaultEffort: null } };
    const result = sanitizeModelCatalogOverrides({ additions: {
      [`${accountId}:gpt-local-fixture`]: addition,
      'api-independent:gpt-local-fixture': addition,
      'not-added-yet:gpt-local-fixture': addition,
      'invalid-account:incomplete': { base: { name: 'Incomplete' } },
      'xd:gpt-local-fixture': addition,
    } });
    expect(result.invalid).toEqual(['additions:invalid-account:incomplete', 'additions:xd:gpt-local-fixture']);
    setLocalCatalogOverrides(result.overrides);
    expect(entry(accountId, 'codex', 'gpt-local-fixture').contextWindow).toBe(120000);
    expect(entry(accountId, 'claude-code', 'chatgpt/gpt-local-fixture').contextWindow).toBe(120000);
    expect(entry('openai', 'codex', 'gpt-local-fixture')).toBeUndefined();
    expect(entry('api-independent', 'codex', 'gpt-local-fixture')).toBeUndefined();
    expect(getActiveCatalog().providers.some(p => p.id === 'not-added-yet')).toBe(false);
  });
  it('projects public Codex/Claude membership and explicit server Pi entries to every account', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    const remotePi: CatalogModel = {
      id: 'chatgpt/gpt-parity-fixture', name: 'Server Pi fixture', group: 'gpt',
      contextWindow: 123456, efforts: ['low'], defaultEffort: 'low',
    };
    catalog.providers.find(p => p.id === 'openai')!.models.pi = [remotePi];
    setActiveCatalog(catalog, { authorityCatalog: catalog });
    setCustomProviders([account()]);
    const providers = getActiveCatalog().providers;
    const original = providers.find(p => p.id === 'openai')!;
    const second = providers.find(p => p.id === accountId)!;
    for (const agent of ['codex', 'claude-code', 'pi'] as const) {
      const ids = second.models[agent]!.map(m => m.id);
      expect(ids).toEqual(expect.arrayContaining(original.models[agent]!.map(m => m.id)));
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(entry(accountId, 'pi', remotePi.id)).toMatchObject(remotePi);
    expect(second.id).not.toBe(original.id);
    expect(second.auth).toEqual({ method: 'oauth', native: 'codex' });
  });

  it('keeps connection-specific local metadata patches separate through catalog refresh', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setCustomProviders([account()]);
    setLocalCatalogOverrides(sanitizeModelCatalogOverrides({ patches: {
      'openai:gpt-5.6-luna': { base: { contextWindow: 111111 } },
      [`${accountId}:gpt-5.6-luna`]: { base: { contextWindow: 222222 } },
    } }).overrides);
    for (let refresh = 0; refresh < 2; refresh++) {
      for (const agent of ['codex', 'claude-code'] as const) {
        const id = agent === 'codex' ? 'gpt-5.6-luna' : 'chatgpt/gpt-5.6-luna';
        expect(entry('openai', agent, id).contextWindow).toBe(111111);
        expect(entry(accountId, agent, id).contextWindow).toBe(222222);
      }
      setActiveCatalog(structuredClone(BUNDLED_CATALOG));
    }
  });

  it.each([123456, 500000])('preserves an explicit %i root window through the Claude bridge', (contextWindow) => {
    setActiveCatalog(BUNDLED_CATALOG);
    const configured = account();
    const model = configured.models.codex![0]!;
    model.userModelConfig = { ...model.userModelConfig!, contextWindow };
    setCustomProviders([configured]);
    expect(entry(accountId, 'codex', 'gpt-5.6-luna').contextWindow).toBe(contextWindow);
    expect(entry(accountId, 'claude-code', 'chatgpt/gpt-5.6-luna').contextWindow).toBe(contextWindow);
    expect(entry('openai', 'codex', 'gpt-5.6-luna').contextWindow).not.toBe(contextWindow);
  });
});


it('applies server Pi replacement, removal and missing-field fallback equally to both accounts', () => {
  setCustomProviders([account()]);
  const catalog = structuredClone(BUNDLED_CATALOG);
  const openai = catalog.providers.find(p => p.id === 'openai')!;
  const future: CatalogModel = { id: 'gpt-server-new', name: 'Server model', contextWindow: 123456,
    efforts: ['low'], defaultEffort: 'low', piApi: 'openai-responses' };
  openai.models.pi = [future];
  setActiveCatalog(catalog, { authorityCatalog: catalog });
  for (const providerId of ['openai', accountId]) {
    expect(getActiveCatalog().providers.find(p => p.id === providerId)!.models.pi?.map(m => m.id))
      .toEqual(['chatgpt/gpt-server-new']);
  }
  openai.models.pi = [];
  setActiveCatalog(structuredClone(catalog), { authorityCatalog: structuredClone(catalog) });
  for (const providerId of ['openai', accountId]) {
    expect(getActiveCatalog().providers.find(p => p.id === providerId)!.models.pi).toEqual([]);
    expect(getActiveCatalog().providers.find(p => p.id === providerId)!.models.codex?.length).toBeGreaterThan(0);
  }
  delete openai.models.pi;
  setActiveCatalog(structuredClone(catalog), { authorityCatalog: structuredClone(catalog) });
  for (const providerId of ['openai', accountId]) {
    expect(getActiveCatalog().providers.find(p => p.id === providerId)!.models.pi?.length).toBeGreaterThan(0);
  }
});


it('legacy Pi defaults cannot override Registry definitions or per-account user patches', () => {
  const catalog = structuredClone(BUNDLED_CATALOG);
  const openai = catalog.providers.find(p => p.id === 'openai')!;
  openai.models.pi = [{ id: 'chatgpt/gpt-5.6-luna', name: 'Remote Luna', contextWindow: 123456,
    efforts: ['low'], defaultEffort: 'low', piApi: 'openai-responses' }];
  setActiveCatalog(catalog, { authorityCatalog: catalog });
  setCustomProviders([account()]);
  setLocalCatalogOverrides(sanitizeModelCatalogOverrides({ patches: {
    [`${accountId}:chatgpt/gpt-5.6-luna`]: { perAgent: { pi: { contextWindow: 234567 } } },
  } }).overrides);
  expect(entry('openai', 'pi', 'chatgpt/gpt-5.6-luna')).toMatchObject({
    name: entry('openai', 'codex', 'gpt-5.6-luna').name, contextWindow: 272000,
  });
  expect(entry(accountId, 'pi', 'chatgpt/gpt-5.6-luna').contextWindow).toBe(234567);
});


it('public model defaults supersede stale static Pi effort ladders', () => {
  const catalog = structuredClone(BUNDLED_CATALOG);
  catalog.providers.find(p => p.id === 'openai')!.models.pi = [{
    id: 'chatgpt/gpt-5.4-mini', name: 'Old Mini', contextWindow: 272000,
    efforts: ['minimal', 'xhigh'], defaultEffort: 'xhigh', piApi: 'openai-responses',
  }];
  setActiveCatalog(catalog, { authorityCatalog: catalog });
  setCustomProviders([account()]);
  for (const providerId of ['openai', accountId]) {
    expect(entry(providerId, 'pi', 'chatgpt/gpt-5.4-mini')).toMatchObject({
      name: 'GPT-5.4-Mini', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium',
    });
  }
});


it.each([false, true])('V5 publication refresh preserves account overrides through the Claude bridge (form=%s)', (explicitForm) => {
  const catalog = structuredClone(BUNDLED_CATALOG);
  catalog.modelRegistry!.schemaVersion = 5;
  const model = catalog.modelRegistry!.models.find(m => m.id === 'openai/gpt-5.6-luna')!;
  const configured = account();
  if (explicitForm) {
    configured.models.codex![0]!.userModelConfig = {
      ...configured.models.codex![0]!.userModelConfig!, contextWindow: 500000, reasoningDefaultEffort: 'high', defaultEnabled: true,
    };
  } else {
    setLocalCatalogOverrides(sanitizeModelCatalogOverrides({ patches: {
      [`${accountId}:gpt-5.6-luna`]: { base: { contextWindow: 500000, defaultEffort: 'high' } },
    } }).overrides);
  }
  setCustomProviders([configured]);
  for (const contextWindow of [240000, 300000]) {
    model.productDefaults = { contextWindow, effort: 'low', fast: false, visible: false };
    catalog.version = `published-${contextWindow}`;
    setActiveCatalog(structuredClone(catalog));
    for (const agent of ['codex', 'claude-code'] as const) {
      const id = agent === 'codex' ? 'gpt-5.6-luna' : 'chatgpt/gpt-5.6-luna';
      expect(entry('openai', agent, id)).toMatchObject({ contextWindow, defaultEffort: 'low', defaultFast: false });
      expect(entry(accountId, agent, id)).toMatchObject({ contextWindow: 500000, defaultEffort: 'high',
        defaultFast: false, defaultEnabled: explicitForm, catalogDefaults: { revision: catalog.version, contextWindow } });
      expect(entry(accountId, agent, id).fieldSources?.contextWindow?.at(-1)?.source).toBe('user');
      expect(entry(accountId, agent, id).fieldSources?.defaultEffort?.at(-1)?.source).toBe('user');
    }
  }
});

it.each([
  ['openai', 'codex', 'gpt-5.6-luna'],
  ['anthropic', 'claude', 'claude-sonnet-4-6'],
  ['xai', 'xai', 'xai/grok-4.3'],
] as const)('V5 public product defaults reach both %s connections without changing identity or Pi membership', (brand, native, modelId) => {
  const catalog = structuredClone(BUNDLED_CATALOG);
  catalog.version = 'multi-account-publication';
  catalog.modelRegistry!.schemaVersion = 5;
  const model = catalog.modelRegistry!.models.find(m => m.routes.some(r => r.providerId === brand && r.modelId === modelId))!;
  expect(model).toBeDefined();
  model.productDefaults = { contextWindow: 100000, effort: 'low', fast: false, visible: false };
  const configured = buildUserProvider({ id: `${brand}-published`, name: 'Personal',
    auth: { method: 'oauth', native }, runtimes: {} });
  setCustomProviders([configured]);
  setActiveCatalog(catalog, { authorityCatalog: catalog });
  const selected = getActiveCatalog().providers.find(p => p.id === configured.id)!;
  const builtin = getActiveCatalog().providers.find(p => p.id === brand)!;
  const agent = brand === 'anthropic' ? 'claude-code' : 'codex';
  for (const provider of [builtin, selected]) {
    expect(provider.models[agent]!.find(m => m.id === modelId)).toMatchObject({ contextWindow: 100000,
      defaultFast: false, defaultEnabled: false, catalogDefaults: { revision: catalog.version } });
  }
  expect(selected.models.pi?.map(m => m.id)).toEqual(builtin.models.pi?.map(m => m.id));
  expect(selected.id).toBe(`${brand}-published`);
  expect(selected.auth).toEqual({ method: 'oauth', native });
});


it('V5 defaults cannot revive retired models or re-enable Fast on a constrained bridge', () => {
  const catalog = structuredClone(BUNDLED_CATALOG);
  catalog.modelRegistry!.schemaVersion = 5;
  const retired = catalog.modelRegistry!.models.find(m => m.id === 'openai/gpt-5.6-luna')!;
  retired.status = 'retired';
  retired.productDefaults = { contextWindow: 100000, fast: true };
  const claude = catalog.modelRegistry!.models.find(m => m.id === 'anthropic/claude-sonnet-4-6')!;
  claude.productDefaults = { contextWindow: 100000, fast: true };
  setLocalCatalogOverrides(sanitizeModelCatalogOverrides({ patches: {
    'openai:gpt-5.6-luna': { base: { status: 'active' } },
    'anthropic:claude-sonnet-4-6': { perAgent: { codex: { supportsFastMode: true } } },
  } }).overrides);
  setActiveCatalog(catalog);
  setDiscoveredCodexModels([{ id: 'gpt-5.6-luna', name: 'Luna', contextWindow: 300000, efforts: ['low'], defaultEffort: 'low' }]);
  expect(entry('openai', 'codex', 'gpt-5.6-luna').status).toBe('retired');
  expect(entry('anthropic', 'codex', 'claude-sonnet-4-6')).toMatchObject({ supportsFastMode: false, defaultFast: false });
});
