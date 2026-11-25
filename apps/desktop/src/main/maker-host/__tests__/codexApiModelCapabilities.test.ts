/**
 * Regression: official API connections omitted Codex's reported Ultra/Fast.
 * Production entry: active catalog projection; minimal input is an exact model
 * ID on the official API route plus its engine capability report. Existing OAuth
 * discovery tests do not cover API projection, override precedence or isolation.
 * Unit tier: in-memory catalog only; the five-file related suite takes 2.98s.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, type CatalogModel, type CustomProviderConfig } from '@cindy/model-providers';

import {
  getActiveCatalog,
  setActiveCatalog,
  setCustomProviderConfigs,
  setCustomProviders,
  setDiscoveredCodexModels,
  setLocalCatalogOverrides,
  setCodexApiModelCapabilities,
} from '../active-catalog.js';
import {
  hasCodexApiConnections,
  needsOpenAiApiCodexFastDeclaration,
  needsOpenAiApiCodexUltrafastDeclaration,
  setCodexApiModelProbe,
  requestCodexApiModelProbe,
} from '../codex-api-model-capabilities.js';
import { mapCodexAppServerModelsToCatalog } from '../codex-model-discovery.js';
import { EMPTY_MODEL_CATALOG_OVERRIDES, sanitizeModelCatalogOverrides } from '../model-plane/localCatalogOverrides.js';

const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const live = (id = 'gpt-6.1-sol'): CatalogModel => ({
  id, name: id, contextWindow: 272_000, efforts: [...efforts], defaultEffort: 'low',
  supportsFastMode: true, supportsUltrafastMode: true,
  discoveredMetadata: { efforts: [...efforts], defaultEffort: 'low', supportsFastMode: true },
});
const config = (): CustomProviderConfig => ({
  id: 'openai-api', name: 'OpenAI API',
  runtimes: { codex: { baseUrl: 'https://api.openai.com/v1', models: [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1' },
    { id: 'private-alias', name: 'Alias' },
  ] } },
});
const model = (provider = 'openai-api', agent: 'codex' | 'pi' = 'codex') =>
  getActiveCatalog().providers.find(p => p.id === provider)!.models[agent]![0]!;

afterEach(() => {
  setCodexApiModelProbe(null);
  setCustomProviders([]);
  setCodexApiModelCapabilities(null);
  setDiscoveredCodexModels([]);
  setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
  setActiveCatalog(structuredClone(BUNDLED_CATALOG));
});

describe('Codex API engine capabilities', () => {
  // #12423: exercise the configured model list, picker flags and launch
  // declaration as one unit. A single-model fallback misses the other IDs
  // from the official Fast tables, including the separate Codex table.
  it('fills Fast for all documented OpenAI API models absent from native discovery', () => {
    const supportedIds = [
      'gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.1-sol',
      'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol',
      'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4',
      'gpt-5.4-mini', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini',
      'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3',
      'gpt-5.3-codex',
    ];
    const otherIds = ['gpt-5.4-nano', 'gpt-5.3-codex-spark', 'gpt-6.2-astra-alias'];
    const stored = config();
    stored.runtimes.codex!.models = [...supportedIds, ...otherIds].map(id => ({ id, name: id }));
    setCustomProviderConfigs([stored]);
    setCodexApiModelCapabilities([]);

    const provider = getActiveCatalog().providers.find(entry => entry.id === stored.id)!;
    const projected = provider.models.codex!;
    expect(projected.filter(entry => entry.supportsFastMode).map(entry => entry.id)).toEqual(supportedIds);
    expect(projected.filter(entry => needsOpenAiApiCodexFastDeclaration(provider, entry.id)).map(entry => entry.id))
      .toEqual(supportedIds);
    // The same four IDs must stay hidden until this connection is confirmed.
    expect(projected.some(entry => entry.supportsUltrafastMode)).toBe(false);
    const confirmed = structuredClone(stored);
    confirmed.id = 'confirmed-openai-api';
    confirmed.runtimes.codex!.openAiApiUltrafastConfirmed = true;
    setCustomProviderConfigs([stored, confirmed]);
    const eligible = getActiveCatalog().providers.find(entry => entry.id === confirmed.id)!;
    const ultrafastIds = ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.1-sol'];
    expect(eligible.models.codex!.filter(entry => entry.supportsUltrafastMode).map(entry => entry.id)).toEqual(ultrafastIds);
    expect(eligible.models.codex!.filter(entry => needsOpenAiApiCodexUltrafastDeclaration(eligible, entry.id)).map(entry => entry.id))
      .toEqual(ultrafastIds);
    expect(model().supportsUltrafastMode).not.toBe(true);
  });

  // #12423 unit: the installed Codex catalog can omit a known API model.
  // Exercise active catalog projection, including a same-name relay and explicit opt-out.
  it('fills Fast for the official 6.2 Sol route when the engine omits the model', () => {
    const stored = config();
    const modelId = 'gpt-6.2-sol';
    stored.runtimes.codex!.models[0] = { id: modelId, name: modelId };
    stored.runtimes.codex!.openAiApiUltrafastConfirmed = true;
    const relay = structuredClone(stored);
    relay.id = 'relay-same-model';
    relay.runtimes.codex!.baseUrl = 'https://relay.example/v1';
    setCustomProviderConfigs([stored, relay]);
    setCodexApiModelCapabilities([live()]);
    const provider = getActiveCatalog().providers.find(entry => entry.id === stored.id);
    expect(model()).toMatchObject({ id: modelId, supportsFastMode: true });
    expect(model().supportsUltrafastMode).toBe(true);
    expect(model(relay.id).supportsUltrafastMode).not.toBe(true);
    expect(needsOpenAiApiCodexFastDeclaration(provider, modelId)).toBe(true);
    expect(model(relay.id).supportsFastMode).not.toBe(true);
    expect(needsOpenAiApiCodexFastDeclaration(
      getActiveCatalog().providers.find(entry => entry.id === relay.id), modelId,
    )).toBe(false);

    stored.runtimes.codex!.models[0]!.supportsFastMode = false;
    setCustomProviderConfigs([stored, relay]);
    expect(model().supportsFastMode).toBe(false);
    expect(model().supportsUltrafastMode).not.toBe(true);
    expect(needsOpenAiApiCodexFastDeclaration(
      getActiveCatalog().providers.find(entry => entry.id === stored.id), modelId,
    )).toBe(false);
  });

  it('preserves an explicit provider report that Fast is unavailable', () => {
    const stored = config();
    const modelId = 'gpt-6.2-sol';
    stored.runtimes.codex!.models[0] = {
      id: modelId, name: modelId, discoveredMetadata: { supportsFastMode: false },
    };
    setCustomProviderConfigs([stored]);
    setCodexApiModelCapabilities([live()]);
    expect(model().supportsFastMode).toBe(false);
  });

  it.each(['gpt-5.6-terra', 'gpt-6.1-terra'])(
    'projects the native Ultra/Fast report for official API model %s', modelId => {
      const stored = config();
      stored.runtimes.codex!.models[0] = { id: modelId, name: modelId };
      setCustomProviderConfigs([stored]);
      const reported = mapCodexAppServerModelsToCatalog([{
        id: modelId, model: modelId, displayName: modelId, description: '', hidden: false,
        supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: '' })),
        defaultReasoningEffort: 'medium', additionalSpeedTiers: ['fast'], serviceTiers: [], isDefault: false,
      }]);
      setCodexApiModelCapabilities(reported);
      expect(model()).toMatchObject({
        id: modelId, efforts: [...efforts], supportsFastMode: true,
        userModelConfig: { id: modelId, name: modelId },
      });
      expect(model().supportsUltrafastMode).not.toBe(true);
    },
  );

  it('adds live Ultra and Fast to configured exact IDs without changing membership or stored edits', () => {
    setActiveCatalog(structuredClone(BUNDLED_CATALOG));
    const stored = config();
    setCustomProviderConfigs([stored]);
    const previous = model();
    const unknown = structuredClone(getActiveCatalog().providers.find(p => p.id === stored.id)!.models.codex![1]);
    setCodexApiModelCapabilities([live(), live('gpt-6-astra')]);
    expect(model()).toMatchObject({ efforts: [...efforts], supportsFastMode: true,
      defaultEffort: previous.defaultEffort, contextWindow: previous.contextWindow,
      userModelConfig: stored.runtimes.codex!.models[0] });
    expect(model().supportsUltrafastMode).not.toBe(true);
    expect(stored.runtimes.codex!.models[0]!.discoveredMetadata).toBeUndefined();
    expect(getActiveCatalog().providers.find(p => p.id === stored.id)!.models.codex!.map(m => m.id))
      .toEqual(['gpt-6.1-sol', 'private-alias']);
    expect(getActiveCatalog().providers.find(p => p.id === stored.id)!.models.codex![1]).toEqual(unknown);
    // A public catalog reload must not erase this process's engine report.
    setActiveCatalog(structuredClone(BUNDLED_CATALOG));
    expect(model().efforts).toContain('ultra');
    expect(model().supportsFastMode).toBe(true);
  });

  it('preserves explicit user capabilities and the configured default', () => {
    const stored = config();
    Object.assign(stored.runtimes.codex!.models[0]!, {
      reasoning: true, reasoningEfforts: ['medium', 'high'], reasoningDefaultEffort: 'high',
      supportsFastMode: false,
    });
    setCustomProviderConfigs([stored]);
    setCodexApiModelCapabilities([live()]);
    expect(model()).toMatchObject({ efforts: ['medium', 'high'], defaultEffort: 'high', supportsFastMode: false });
  });

  it('takes explicit negative reports and replaces obsolete snapshots', () => {
    setCustomProviderConfigs([config()]);
    setCodexApiModelCapabilities([live()]);
    expect(model().efforts).toContain('ultra');
    setCodexApiModelCapabilities([{ ...live(), discoveredMetadata: { efforts: [], supportsFastMode: false } }]);
    expect(model()).toMatchObject({ efforts: [], defaultEffort: null, supportsFastMode: false });
    setCodexApiModelCapabilities([]);
    expect(model().efforts).not.toContain('ultra');
  });

  it('does not turn mapper fallback values into reported API facts', () => {
    setCustomProviderConfigs([config()]);
    const before = model();
    setCodexApiModelCapabilities([{ ...live(), discoveredMetadata: {} }]);
    expect(model().efforts).toEqual(before.efforts);
    expect(model().supportsFastMode).toBe(before.supportsFastMode);
    expect(model().contextWindow).toBe(before.contextWindow);
  });

  it('keeps server force corrections and local catalog overrides above engine reports', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    catalog.modelRegistry = { schemaVersion: 4, updatedAt: '2026-11-06T00:00:00Z',
      models: [{ id: 'gpt-6.1-sol', name: 'GPT', routes: [{
        providerId: 'openai-api', modelId: 'gpt-6.1-sol', agents: ['codex'],
        forceOverrides: { efforts: ['high'], supportsFastMode: false }, overrideReason: 'Verified route restriction',
      }] }] };
    setActiveCatalog(catalog);
    setCustomProviderConfigs([config()]);
    setCodexApiModelCapabilities([live()]);
    expect(model()).toMatchObject({ efforts: ['high'], supportsFastMode: false });
    setLocalCatalogOverrides(sanitizeModelCatalogOverrides({ version: 1, patches: {
      'openai-api:gpt-6.1-sol': { base: { efforts: ['low', 'ultra'], defaultEffort: 'ultra', supportsFastMode: true } },
    } }).overrides);
    expect(model()).toMatchObject({ efforts: ['low', 'ultra'], defaultEffort: 'ultra', supportsFastMode: true });
  });

  it.each([
    { baseUrl: 'https://relay.example/v1' },
    { baseUrl: 'https://api.openai.com.evil.example/v1' },
    { baseUrl: 'http://api.openai.com/v1' },
    { baseUrl: 'https://api.openai.com/custom' },
    { baseUrl: 'https://api.openai.com/v1', wireProtocol: 'openai-chat' as const },
    { baseUrl: 'https://api.openai.com/v1', requestPath: '/custom' },
  ])('does not lend official API capabilities to another route: %j', route => {
    const stored = config();
    Object.assign(stored.runtimes.codex!, route);
    setCustomProviderConfigs([stored]);
    const before = model();
    expect(hasCodexApiConnections(getActiveCatalog())).toBe(false);
    setCodexApiModelCapabilities([live()]);
    expect(model()).toEqual(before);
  });

  it('respects per-model routes, other engines and OAuth discovery', () => {
    const stored = config();
    stored.runtimes.codex!.models[0]!.route = { baseUrl: 'https://relay.example/v1', wireProtocol: 'openai-responses' };
    stored.runtimes.pi = { baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-6.1-sol', name: 'GPT' }] };
    setCustomProviderConfigs([stored]);
    setDiscoveredCodexModels([{ ...live('oauth-only'), efforts: ['high'], discoveredMetadata: { efforts: ['high'] } }]);
    const before = model();
    const pi = model(stored.id, 'pi');
    const oauth = structuredClone(getActiveCatalog().providers.find(p => p.id === 'openai')!.models.codex);
    setCodexApiModelCapabilities([live()]);
    expect(model()).toEqual(before);
    expect(model(stored.id, 'pi')).toEqual(pi);
    expect(getActiveCatalog().providers.find(p => p.id === 'openai')!.models.codex).toEqual(oauth);
  });

  // PR #9109: a model route replaces runtime requestPath, just as dispatch does.
  it('discovers capabilities when a model Responses route replaces a runtime chat path', () => {
    const stored = config();
    Object.assign(stored.runtimes.codex!, {
      baseUrl: 'https://relay.example/v1', requestPath: '/chat/completions',
    });
    stored.runtimes.codex!.models[0]!.route = {
      baseUrl: 'https://api.openai.com/v1', wireProtocol: 'openai-responses',
    };
    setCustomProviderConfigs([stored]);
    expect(hasCodexApiConnections(getActiveCatalog())).toBe(true);
    setCodexApiModelCapabilities([live()]);
    expect(model()).toMatchObject({ efforts: [...efforts], supportsFastMode: true });
  });

  it('uses the current route after configuration changes and clears on owner reset', () => {
    setCodexApiModelCapabilities([live()]);
    setCustomProviderConfigs([config()]);
    expect(hasCodexApiConnections(getActiveCatalog())).toBe(true);
    expect(model().efforts).toContain('ultra');
    const changed = config();
    changed.runtimes.codex!.baseUrl = 'https://relay.example/v1';
    setCustomProviderConfigs([changed]);
    expect(model().efforts).not.toContain('ultra');
    setCustomProviderConfigs([config()]);
    setCodexApiModelCapabilities(null);
    expect(model().efforts).not.toContain('ultra');
  });

  it('requests discovery only through the installed maker-owned probe', () => {
    const request = vi.fn();
    requestCodexApiModelProbe();
    setCodexApiModelProbe(request);
    requestCodexApiModelProbe();
    expect(request).toHaveBeenCalledOnce();
    setCodexApiModelProbe(null);
    requestCodexApiModelProbe();
    expect(request).toHaveBeenCalledOnce();
  });
});
