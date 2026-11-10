import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, parseCatalog } from '../catalog.js';
import { availableModelInterfaces } from '../providerInterfaceRoutes.js';
import { buildUserProvider } from '../user-provider.js';
import { isOpenHubsModelsUrl, parseModelsListResponse } from '../modelDiscovery.js';
import { providerSetupLink } from '../providerSetupLinks.js';

const root = 'https://openhubs.zhidemai.com';
const ids = ['deepseek-v4-flash', 'kimi-k3.1-pro', 'glm-5.3'];

describe('OpenHubs built-in connection', () => {
  it.each(['claude-code', 'codex', 'pi'] as const)('resolves the %s default through JSON save without restricting discovered model IDs', agent => {
    const catalog = parseCatalog(JSON.stringify(BUNDLED_CATALOG));
    const preset = catalog.presets!.find(p => p.id === 'openhubs')!;
    expect(Object.keys(preset.runtimes)).toEqual(['claude-code', 'codex', 'pi']);
    expect(providerSetupLink(preset)).toEqual({ kind: 'apiKey', url: root + '/console/api-keys' });
    const runtime = preset.runtimes[agent]!;
    expect(runtime.models.map(m => m.id)).toEqual(ids);
    const saved = JSON.parse(JSON.stringify({ id: 'openhubs-account', name: 'OpenHubs', runtimes: { [agent]: {
      ...runtime, catalogPresetId: preset.id,
      models: [...runtime.models, { id: 'new-account-model', name: 'New Account Model' }]
        .map(m => ({ ...m, interfaceId: 'auto', contextWindow: 4096, defaultEnabled: true })),
    } } }));
    const provider = buildUserProvider(saved, { presets: catalog.presets, modelRegistry: catalog.modelRegistry });
    const api = agent === 'claude-code' ? 'anthropic-messages' : agent === 'codex' ? 'openai-responses' : 'openai-completions';
    const wireProtocol = agent === 'pi' ? 'openai-chat' : api;
    const baseUrl = agent === 'claude-code' ? root : root + '/v1';
    expect(provider.agents).toEqual([agent]);
    for (const model of provider.models[agent]!) {
      expect(model).toMatchObject({ contextWindow: 4096, defaultEnabled: true, api,
        selectedInterface: { profileId: 'openhubs-' + api, wireModelId: model.id,
          route: { baseUrl, wireProtocol } } });
    }
    const profiles = catalog.modelRegistry!.interfaceProfiles!.filter(p => p.providerId === 'openhubs');
    expect(profiles).toHaveLength(3);
    expect(profiles.every(p => p.modelIds === undefined)).toBe(true);
    const choices = availableModelInterfaces(catalog.modelRegistry, 'openhubs', 'new-account-model', baseUrl, agent);
    expect(choices).toHaveLength(3);
    expect(choices.find(c => c.preferred)?.api).toBe(api);
    expect(preset.runtimes.pi!.models[0]).toMatchObject({ contextWindow: 1048576, maxOutput: 384000 });
  });

  it.each(['?page=2', '?type=chat', '#filtered', '/extra'])('does not claim a complete inventory for %s', suffix => {
    expect(isOpenHubsModelsUrl(root + '/v1/models' + suffix)).toBe(false);
  });
  it.each(['http://openhubs.zhidemai.com/v1/models', 'https://relay.example/v1/models',
    'https://openhubs.zhidemai.com.evil.example/v1/models', 'https://user@openhubs.zhidemai.com/v1/models'])
  ('does not treat another source as the official inventory: %s', url => {
    expect(isOpenHubsModelsUrl(url)).toBe(false);
  });
  it('accepts a successful empty inventory without inventing chat support from endpoint tags', () => {
    expect(isOpenHubsModelsUrl(root + '/v1/models')).toBe(true);
    expect(parseModelsListResponse({ error_code: 0, data: [] }, root + '/v1/models')).toEqual([]);
    const models = parseModelsListResponse({ error_code: 0, data: [{ id: 'unknown', supported_endpoint_types: ['openai'] }] }, root + '/v1/models')!;
    expect(models[0].discoveredMetadata?.nativeApi).toBeUndefined();
  });
  it.each([{ error_code: 1001, data: [] }, { error: { message: 'insufficient balance' }, data: [] },
    { error_code: 0, models: [] }, { error_code: 'bad', data: [] },
    { error_code: 0, data: [null] }, { error_code: 0, data: [{ id: 123 }] }])
  ('rejects a business or malformed failure rather than clearing recommendations: %j', response => {
    expect(parseModelsListResponse(response, root + '/v1/models')).toBeNull();
  });
});
