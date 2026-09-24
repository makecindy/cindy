import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider, parseCatalog } from '@cindy/model-providers';
import { buildXaiSyncCandidate, inspectXaiImport } from '../../../../../../tools/model-catalog/xai-sync.js';
import { getActiveCatalog, setActiveCatalog, setCustomProviders, setLocalCatalogOverrides, setXaiDiscoveredModels } from '../active-catalog.js';
import { fastModelId } from '../model-fast-mode.js';
import { EMPTY_MODEL_CATALOG_OVERRIDES, sanitizeModelCatalogOverrides } from '../model-plane/localCatalogOverrides.js';
import { parseCachedXaiModels, parseXaiAccountModels } from '../model-discovery/xai-models.js';

const observedAt = '2026-09-24T12:00:00.000Z';
// The API shape is real; this deliberately unseen ID guards against per-model branches.
const account = { data: [{ id: 'grok-4.8', name: 'Grok 4.8', context_window: 600_000,
  api_backend: 'responses', reasoning_efforts: ['xhigh', 'high', 'medium', 'low'], reasoning_effort: 'high' }] };
const details = { models: [{ id: 'grok-4.8', input_modalities: ['text', 'image'], output_modalities: ['text'],
  prompt_text_token_price: 20_000, completion_text_token_price: 60_000, cached_prompt_text_token_price: 5_000,
  long_context_threshold: 200_000, prompt_text_token_price_long_context: 40_000,
  completion_text_token_price_long_context: 120_000, cached_prompt_text_token_price_long_context: 10_000,
  capabilities: { reasoning_effort: ['low', 'medium', 'high', 'xhigh'], default_reasoning_effort: 'high' } }] };
const build = (a: unknown = account, d: unknown = details) => buildXaiSyncCandidate(BUNDLED_CATALOG, a, d, observedAt);
afterEach(() => {
  setXaiDiscoveredModels(null);
  setXaiDiscoveredModels(null, 'grok-work');
  setCustomProviders([]);
  setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
  setActiveCatalog(BUNDLED_CATALOG);
});

describe('xAI API sync through the actual picker import', () => {
  it('keeps Fast targets default-off when the loaded server catalog predates the client mapping', () => {
    const oldCatalog = structuredClone(BUNDLED_CATALOG);
    const fastId = 'xai/grok-4.7-build-fast';
    oldCatalog.modelRegistry!.models = oldCatalog.modelRegistry!.models.filter(m => m.id !== fastId);
    oldCatalog.modelRegistry!.baseModels = oldCatalog.modelRegistry!.baseModels!.filter(m => m.id !== fastId);
    const xai = oldCatalog.providers.find(p => p.id === 'xai')!;
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      xai.models[agent] = xai.models[agent]!.filter(m => !m.id.endsWith('grok-4.7-build-fast'));
      for (const model of xai.models[agent]!) delete model.fastModelId;
    }
    setActiveCatalog(oldCatalog);
    setCustomProviders([buildUserProvider({ id: 'grok-work', name: 'Work',
      auth: { method: 'oauth', native: 'xai' }, runtimes: {} })]);
    const members = ['xai/grok-4.7', fastId, 'xai/grok-new-fixture'].map(id => ({
      id, contextWindow: 500_000, nativeApi: 'openai-responses' as const,
    }));
    setXaiDiscoveredModels(members);
    setXaiDiscoveredModels(members, 'grok-work');
    for (const providerId of ['xai', 'grok-work']) {
      const provider = getActiveCatalog().providers.find(p => p.id === providerId)!;
      for (const agent of ['claude-code', 'codex', 'pi'] as const) {
        const parentId = agent === 'pi' ? 'grok-4.7' : 'xai/grok-4.7';
        expect(provider.models[agent]!.find(m => m.id.endsWith('grok-4.7-build-fast'))?.defaultEnabled).toBe(false);
        expect(fastModelId(providerId, agent, parentId)).toBe(agent === 'pi' ? 'grok-4.7-build-fast' : fastId);
      }
      expect(provider.models.codex!.find(m => m.id === 'xai/grok-new-fixture')?.defaultEnabled).toBe(true);
    }
    const updatedCatalog = structuredClone(oldCatalog);
    updatedCatalog.providers.find(p => p.id === 'xai')!.models.codex!.push({
      id: fastId, name: 'Grok 4.7 Fast', contextWindow: 500_000,
      efforts: [], defaultEffort: null, defaultEnabled: true,
    });
    setActiveCatalog(updatedCatalog);
    expect(getActiveCatalog().providers.find(p => p.id === 'xai')!.models.codex!
      .find(m => m.id === fastId)?.defaultEnabled).toBe(true);
  });

  it.each(['catalog', 'local override'] as const)('rejects stale Fast capability without an execution mapping from %s', source => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    const xai = catalog.providers.find(p => p.id === 'xai')!;
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      // Older server catalogs also lack the valid 4.7 mapping; bundled fallback must still work.
      for (const model of xai.models[agent]!) {
        delete model.fastModelId;
        if (source === 'catalog' && model.id.endsWith('grok-4.6')) model.supportsFastMode = true;
      }
    }
    setActiveCatalog(catalog);
    setCustomProviders([buildUserProvider({ id: 'grok-work', name: 'Work',
      auth: { method: 'oauth', native: 'xai' }, runtimes: {} })]);
    const members = ['xai/grok-4.6', 'xai/grok-4.7', 'xai/grok-4.7-build-fast'].map(id => ({
      id, contextWindow: 500_000, nativeApi: 'openai-responses' as const,
    }));
    for (const providerId of ['xai', 'grok-work']) setXaiDiscoveredModels(members, providerId);
    if (source === 'local override') {
      const patches = Object.fromEntries(['xai', 'grok-work'].flatMap(providerId =>
        ['xai/grok-4.6', 'grok-4.6'].map(id => [`${providerId}:${id}`, { base: { supportsFastMode: true } }])));
      setLocalCatalogOverrides(sanitizeModelCatalogOverrides({ version: 1, patches }).overrides);
    }
    for (const providerId of ['xai', 'grok-work']) {
      const provider = getActiveCatalog().providers.find(p => p.id === providerId)!;
      for (const agent of ['claude-code', 'codex', 'pi'] as const) {
        const prefix = agent === 'pi' ? '' : 'xai/';
        expect(provider.models[agent]!.find(m => m.id === `${prefix}grok-4.6`)!.supportsFastMode, `${providerId}/${agent}`).not.toBe(true);
        expect(fastModelId(providerId, agent, `${prefix}grok-4.6`)).toBeUndefined();
        expect(fastModelId(providerId, agent, `${prefix}grok-4.7`)).toBe(`${prefix}grok-4.7-build-fast`);
      }
    }
  });

  it('never borrows Fast availability from another subscription account', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setCustomProviders([buildUserProvider({ id: 'grok-work', name: 'Work',
      auth: { method: 'oauth', native: 'xai' }, runtimes: {} })]);
    const ordinary = { id: 'xai/grok-4.7', contextWindow: 500000 };
    const fast = { id: 'xai/grok-4.7-build-fast', contextWindow: 500000 };
    setXaiDiscoveredModels([ordinary, fast]);
    setXaiDiscoveredModels([ordinary], 'grok-work');
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const id = agent === 'pi' ? 'grok-4.7' : ordinary.id;
      expect(fastModelId('xai', agent, id)).toBe(agent === 'pi' ? 'grok-4.7-build-fast' : fast.id);
      expect(fastModelId('grok-work', agent, id)).toBeUndefined();
      expect(fastModelId('custom-api-key', agent, id)).toBeUndefined();
    }
    setXaiDiscoveredModels([ordinary, fast], 'grok-work');
    expect(fastModelId('grok-work', 'codex', ordinary.id)).toBe(fast.id);
  });

  it('imports verified 4.7 Fast execution and exact tariffs without giving 4.6 a Fast mapping', () => {
    const members = ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6'].map(id => ({ ...account.data[0], id, name: id }));
    const candidate = build({ data: members }, { models: ['grok-4.7', 'grok-4.6'].map(id => ({ ...details.models[0], id })) });
    // Old readers ignore fastModelId; the serialized artifact must not make them send priority.
    for (const models of Object.values(candidate.catalog.providers.find(p => p.id === 'xai')!.models)) {
      expect(models!.find(m => m.id === 'grok-4.7' || m.id === 'xai/grok-4.7')!.supportsFastMode).not.toBe(true);
    }
    const report = inspectXaiImport(candidate);
    const parent = report.rows.find(r => r.modelId === 'xai/grok-4.7')!;
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      expect(parent.harnesses[agent].supportsFastMode).toBe(true);
      expect(parent.harnesses[agent].apiReferencePrice?.priority).toMatchObject({
        inputPerMtok: 4, outputPerMtok: 12, cacheReadPerMtok: 1,
        inputTokenPriceBands: [
          { minInputTokens: 0, maxInputTokens: 200001, inputPerMtok: 4 },
          { minInputTokens: 200001, inputPerMtok: 6, outputPerMtok: 18, cacheReadPerMtok: 1.5 },
        ],
      });
      const direct = report.rows.find(r => r.modelId.endsWith('build-fast'))!.harnesses[agent];
      expect(direct.defaultEnabled).toBe(false);
      expect(direct.apiReferencePrice).toMatchObject({ inputPerMtok: 4, outputPerMtok: 12 });
      expect(report.rows.find(r => r.modelId === 'xai/grok-4.6')!.harnesses[agent].supportsFastMode).not.toBe(true);
    }
    setXaiDiscoveredModels(parseXaiAccountModels({ data: members.filter(m => !m.id.endsWith('build-fast')) }));
    for (const models of Object.values(getActiveCatalog().providers.find(p => p.id === 'xai')!.models)) {
      expect(models!.find(m => m.id.endsWith('/grok-4.7') || m.id === 'grok-4.7')!.supportsFastMode).toBe(false);
    }
  });
  it('imports an unseen API model into all harnesses with ascending efforts, native defaults and banded prices', () => {
    const before = JSON.stringify(BUNDLED_CATALOG);
    const candidate = build();
    expect(() => parseCatalog(JSON.stringify(candidate.catalog))).not.toThrow();
    const report = inspectXaiImport(candidate);
    expect(report.harnessProjections).toBe(3);
    const { harnesses } = report.rows[0];
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      expect(harnesses[agent]).toMatchObject({
        id: agent === 'pi' ? 'grok-4.8' : 'xai/grok-4.8',
        contextWindow: 600_000, supportsImageInput: true,
        efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high',
        apiReferencePrice: { inputPerMtok: 2, outputPerMtok: 6, cacheReadPerMtok: 0.5,
          inputTokenPriceBands: [
            { minInputTokens: 0, maxInputTokens: 200_000, inputPerMtok: 2 },
            { minInputTokens: 200_000, inputPerMtok: 4, outputPerMtok: 12, cacheReadPerMtok: 1 },
          ] },
      });
      expect(harnesses[agent].defaultEnabled).toBe(agent !== 'claude-code');
    }
    expect(JSON.stringify(BUNDLED_CATALOG)).toBe(before);
    expect(report.complete).toBe(false);
    expect(report.gaps[0].fields).toEqual(['apiMaxOutput', 'fastExecution']);
  });

  it('preserves explicit catalog opt-outs while enabling a new native variant', () => {
    const candidate = build();
    const provider = candidate.catalog.providers.find(p => p.id === 'xai')!;
    provider.models.pi!.find(m => m.id === 'grok-4.8')!.defaultEnabled = false;
    const again = buildXaiSyncCandidate(candidate.catalog, account, details, '2026-09-25T12:00:00.000Z');
    expect(inspectXaiImport(again).rows[0].harnesses.pi.defaultEnabled).toBe(false);
  });

  it('keeps curated effort intent and per-harness opt-outs ahead of API recommendations', () => {
    const first = build();
    const entry = first.catalog.modelRegistry!.models.find(m => m.id === 'xai/grok-4.8')!;
    entry.routes[0].defaults!.defaultEffort = 'low';
    entry.perAgent!.codex!.defaultEnabled = false;
    const next = buildXaiSyncCandidate(first.catalog, account, details, '2026-09-25T12:00:00.000Z');
    const row = inspectXaiImport(next).rows[0].harnesses.codex;
    expect(row.defaultEffort).toBe('low');
    expect(row.defaultEnabled).toBe(false);
  });

  it('does not infer capabilities or prices from a Fast suffix, description, or adjacent model', () => {
    const candidate = build({ data: [...account.data, { ...account.data[0], id: 'grok-4.8-build-fast',
      name: 'Grok 4.8 Fast', description: 'Fast variant. 2x the price.' }] });
    const report = inspectXaiImport(candidate);
    const fast = report.rows.find(row => row.modelId.endsWith('build-fast'))!;
    for (const row of Object.values(fast.harnesses)) {
      expect(row.supportsFastMode).toBeUndefined();
      expect(row.supportsImageInput).toBeUndefined();
      expect(row.apiReferencePrice).toBeNull();
      expect(row.defaultEnabled).toBe(row.protocol?.mode === 'matching');
    }
    expect(report.gaps.find(g => g.modelId === fast.modelId)?.fields).toContain('apiReferencePrice');
  });

  it('does not add account-inaccessible detail models and rejects ambiguous aliases', () => {
    const candidate = build(account, { models: [...details.models, { ...details.models[0], id: 'not-in-account' }] });
    expect(inspectXaiImport(candidate).rows.map(r => r.modelId)).toEqual(['xai/grok-4.8']);
    expect(() => build(account, { models: ['one', 'two'].map(id => ({ ...details.models[0], id, aliases: ['grok-4.8'] })) })).toThrow('Ambiguous');
  });

  it('honors zero long-context fallback and explicit text-only input', () => {
    const candidate = build(account, { models: [{ ...details.models[0], input_modalities: ['text'],
      prompt_text_token_price_long_context: 0, completion_text_token_price_long_context: 0,
      cached_prompt_text_token_price_long_context: 0 }] });
    const row = inspectXaiImport(candidate).rows[0].harnesses.pi;
    expect(row.supportsImageInput).toBe(false);
    expect(row.apiReferencePrice?.inputTokenPriceBands?.[1]).toMatchObject({ inputPerMtok: 2, outputPerMtok: 6, cacheReadPerMtok: 0.5 });
  });

  it('preserves known tariff history and all unrelated catalog data on repeat synchronization', () => {
    const first = build();
    const next = buildXaiSyncCandidate(first.catalog, account, details, '2026-09-25T12:00:00.000Z');
    const prices = next.catalog.modelRegistry!.baseModels!.find(b => b.id === 'xai/grok-4.8')!.referencePriceGroups![0].prices;
    expect(prices).toHaveLength(2);
    expect(prices[0].effectiveFrom).toBe('2026-09-24');
    expect(prices[0].source.verifiedAt).toBe('2026-09-25');
    expect(next.catalog.presets).toEqual(BUNDLED_CATALOG.presets);
    expect(next.catalog.providers.filter(p => p.id !== 'xai')).toEqual(BUNDLED_CATALOG.providers.filter(p => p.id !== 'xai'));
    const changed = buildXaiSyncCandidate(next.catalog, account,
      { models: [{ ...details.models[0], prompt_text_token_price: 30_000 }] }, '2026-09-26T12:00:00.000Z');
    const history = changed.catalog.modelRegistry!.baseModels!.find(b => b.id === 'xai/grok-4.8')!.referencePriceGroups![0].prices;
    expect(history).toHaveLength(4);
    expect(history[0].effectiveUntil).toBe('2026-09-26');
    expect(history[2].inputPerMtok).toBe(3);
  });

  it('preserves verified cache prices on sparse updates and reports missing API cache fields', () => {
    const first = build();
    const sparse = { ...details.models[0], prompt_text_token_price: 30_000,
      cached_prompt_text_token_price: undefined, cached_prompt_text_token_price_long_context: undefined };
    const candidate = buildXaiSyncCandidate(first.catalog, account, { models: [sparse] }, '2026-09-25T12:00:00.000Z');
    const prices = candidate.catalog.modelRegistry!.baseModels!.find(b => b.id === 'xai/grok-4.8')!.referencePriceGroups![0].prices;
    expect(prices).toHaveLength(4);
    expect(prices[0].effectiveUntil).toBe('2026-09-25');
    expect(prices[2]).toMatchObject({ inputPerMtok: 3, cacheReadPerMtok: 0.5,
      source: { verifiedAt: '2026-09-24' } });
    expect(prices[3].cacheReadPerMtok).toBe(1);
    const report = inspectXaiImport(candidate);
    expect(report.gaps[0].fields).toContain('apiCacheReadPrice');
    expect(report.evidence[0].fieldsFromCatalog).toContain('cacheReadReferencePrice');
    expect(report.rows[0].harnesses.codex.apiReferencePrice?.cacheReadPerMtok).toBe(0.5);

    const unknown = build(account, { models: [sparse] });
    expect(unknown.gaps[0].fields).toContain('apiCacheReadPrice');
    expect(unknown.evidence[0].fieldsFromCatalog).not.toContain('cacheReadReferencePrice');
    expect(inspectXaiImport(unknown).rows[0].harnesses.codex.apiReferencePrice?.cacheReadPerMtok).toBeUndefined();

    const zero = buildXaiSyncCandidate(first.catalog, account, { models: [{ ...sparse,
      cached_prompt_text_token_price: 0, cached_prompt_text_token_price_long_context: 0 }] }, '2026-09-25T12:00:00.000Z');
    expect(zero.gaps[0].fields).not.toContain('apiCacheReadPrice');
    expect(inspectXaiImport(zero).rows[0].harnesses.codex.apiReferencePrice?.cacheReadPerMtok).toBe(0);
  });

  it.each([
    ['all cache prices missing', undefined],
    ['only long-context cache price missing', 5_000],
  ] as const)('keeps serialized repeat sync stable with %s', (_case, standardCache) => {
    const sparseDetails = JSON.parse(JSON.stringify({ models: [{ ...details.models[0],
      cached_prompt_text_token_price: standardCache,
      cached_prompt_text_token_price_long_context: undefined }] }));
    let candidate = build(account, sparseDetails);
    for (const at of ['2026-09-24T18:00:00.000Z', '2026-09-25T12:00:00.000Z']) {
      const savedCatalog = parseCatalog(JSON.stringify(candidate.catalog));
      candidate = buildXaiSyncCandidate(savedCatalog, account, sparseDetails, at);
      const prices = candidate.catalog.modelRegistry!.baseModels!.find(b => b.id === 'xai/grok-4.8')!.referencePriceGroups![0].prices;
      expect(prices).toHaveLength(2);
      expect(prices.every(p => p.effectiveFrom === '2026-09-24' && p.effectiveUntil === undefined)).toBe(true);
      expect(prices[0].cacheReadPerMtok).toBe(standardCache === undefined ? undefined : 0.5);
      expect(prices[1]).not.toHaveProperty('cacheReadPerMtok');
      expect(candidate.gaps[0].fields).toContain('apiCacheReadPrice');
    }
  });

  it('keeps user capability overrides after import and serializes discovery backend through the old cache envelope', () => {
    const parsed = parseXaiAccountModels(account);
    expect(parseCachedXaiModels(JSON.parse(JSON.stringify({ models: parsed })))).toEqual(parsed);
    const candidate = build();
    setLocalCatalogOverrides(sanitizeModelCatalogOverrides({ version: 1, patches: {
      'xai:xai/grok-4.8': { base: { contextWindow: 300_000, supportsImageInput: false } },
    } }).overrides);
    inspectXaiImport(candidate);
    const rows = getActiveCatalog().providers.find(p => p.id === 'xai')!.models;
    expect(rows.codex!.find(m => m.id === 'xai/grok-4.8')).toMatchObject({ contextWindow: 300_000, supportsImageInput: false });
  });

  it('rejects unusable input before producing any replacement', () => {
    expect(() => build({ data: [] })).toThrow('Empty account');
    expect(() => build({ data: [{ ...account.data[0], api_backend: 'future-protocol' }] })).toThrow('Unsupported');
    expect(() => build(account, { error: 'unauthorized' })).toThrow('Invalid or empty');
    expect(() => build({ data: [{ id: 'new-model' }] })).toThrow('Unknown context');
    expect(() => build(account, { models: [details.models[0], details.models[0]] })).toThrow('Duplicate');
  });
});
