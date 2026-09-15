import { BUNDLED_CATALOG } from '../../test/catalog-fixture.js';
import { describe, expect, it } from 'vitest';
import { SERVER_CATALOG, installServerCatalog } from '../builtin.js';
import { buildUserProvider } from '../user-provider.js';
import { modelProtocolComparison } from '../modelProtocol.js';
import { parseCatalog } from '../catalog.js';
import type { ProviderPreset } from '../types.js';

describe('server-published supplier presets', () => {
  it('preserves all published connection templates and each Harness member list', () => {
    const catalog = parseCatalog(JSON.stringify(BUNDLED_CATALOG));
    expect(catalog.presets).toHaveLength(52);
    for (const preset of catalog.presets!) {
      const provider = buildUserProvider({ id: preset.id, name: preset.name, runtimes: preset.runtimes }, { presets: catalog.presets });
      for (const agent of ['claude-code', 'codex', 'pi'] as const) {
        expect(provider.models[agent]?.map(model => model.id), `${preset.id}/${agent}`).toEqual(preset.runtimes[agent]?.models.map(model => model.id));
      }
    }
  });
  it('does not regenerate deleted templates from adapter metadata', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    catalog.presets = [];
    installServerCatalog(parseCatalog(catalog));
    expect(Object.keys(SERVER_CATALOG.providerModelCatalog!.providers)).toHaveLength(39);
    expect(SERVER_CATALOG.presets).toEqual([]);
  });
});

it('consumes a server-declared direct Messages endpoint with its context limit', () => {
  const presets: ProviderPreset[] = [{ id: 'test-gateway', name: 'Test', runtimes: {
    'claude-code': { baseUrl: 'https://gateway.example/anthropic', wireProtocol: 'anthropic-messages', models: [{ id: 'model', name: 'Model', api: 'anthropic-messages', contextWindow: 128000, route: { baseUrl: 'https://gateway.example/anthropic', wireProtocol: 'anthropic-messages' } }] },
    codex: { baseUrl: 'https://gateway.example/v1', wireProtocol: 'openai-responses', models: [{ id: 'model', name: 'Model', contextWindow: 64000 }] },
    pi: { baseUrl: 'https://gateway.example/anthropic', wireProtocol: 'anthropic-messages', models: [{ id: 'model', name: 'Model', contextWindow: 128000 }] },
  } }];
  const preset = presets.find(p => p.id === 'test-gateway')!;
  const provider = buildUserProvider({ id: 'test', name: 'Test', runtimes: preset.runtimes }, { modelRegistry: {
    schemaVersion: 5, updatedAt: '2026-09-13T00:00:00Z', models: [{
      id: 'model', name: 'Model', nativeApi: 'anthropic-messages',
      routes: [{ providerId: 'test', modelId: 'model', agents: ['claude-code', 'codex'] }],
    }],
  } });
  expect(provider.models['claude-code']![0]).toMatchObject({ api: 'anthropic-messages', contextWindow: 128000, defaultEnabled: true, route: { baseUrl: 'https://gateway.example/anthropic' } });
  expect(provider.models.codex![0]).toMatchObject({ contextWindow: 64000, defaultEnabled: false });
  expect(modelProtocolComparison(provider, { codex: provider.models.codex![0] }).forAgent('codex')).toMatchObject({
    outbound: 'openai-responses', mode: 'compatibility', localConversion: false,
  });
  expect(provider.models.pi![0].defaultEnabled).toBe(true);
});
