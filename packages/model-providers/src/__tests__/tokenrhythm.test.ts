import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, parseCatalog } from '../catalog.js';
import { buildUserProvider } from '../user-provider.js';
import { availableModelInterfaces } from '../providerInterfaceRoutes.js';
import { matchOfficialProviders } from '../providerDetection.js';
import { resolveProviderLogoKind } from '../providerBranding.js';
import { providerSetupLink } from '../providerSetupLinks.js';
import { parseModelsListResponse } from '../modelDiscovery.js';

const root = 'https://tokenrhythm.studio';

describe('Token Rhythm connection preset', () => {
  it.each(['claude-code', 'codex', 'pi'] as const)('restores %s routing without inventing account members or overriding user values', agent => {
    const catalog = parseCatalog(JSON.stringify(BUNDLED_CATALOG));
    const preset = catalog.presets!.find(p => p.id === 'tokenrhythm')!;
    expect(Object.keys(preset.runtimes)).toEqual(['claude-code', 'codex', 'pi']);
    expect(providerSetupLink(preset)).toEqual({ kind: 'apiKey', url: root + '/account/keys' });
    const runtime = preset.runtimes[agent]!;
    expect(runtime.models).toEqual([]);
    const api = agent === 'claude-code' ? 'anthropic-messages' : agent === 'codex' ? 'openai-responses' : 'openai-completions';
    const wireProtocol = agent === 'pi' ? 'openai-chat' : api;
    const baseUrl = root + (agent === 'claude-code' ? '' : '/v1');
    expect(runtime).toMatchObject({ baseUrl, wireProtocol, modelsUrl: root + '/v1/models' });
    const config = JSON.parse(JSON.stringify({ id: 'tokenrhythm-test', name: 'Token Rhythm', runtimes: { [agent]: {
      ...runtime, catalogPresetId: preset.id,
      models: [{ id: 'account-model', name: 'User name', interfaceId: 'auto', contextWindow: 8192, maxOutputTokens: 512, defaultEnabled: false },
        { id: 'manual-model', name: 'Manual' }],
    } } }));
    const provider = buildUserProvider(config, { presets: catalog.presets, modelRegistry: catalog.modelRegistry });
    expect(provider.agents).toEqual([agent]);
    expect(provider.models[agent]!.map(m => m.id)).toEqual(['account-model', 'manual-model']);
    expect(provider.models[agent]![0]).toMatchObject({ name: 'User name', api, contextWindow: 8192, maxOutput: 512,
      defaultEnabled: false, selectedInterface: { profileId: 'tokenrhythm-' + api, wireModelId: 'account-model', route: { baseUrl, wireProtocol } } });
    const choices = availableModelInterfaces(catalog.modelRegistry, 'tokenrhythm', 'new-model', baseUrl, agent);
    expect(choices).toHaveLength(3);
    expect(choices.find(c => c.preferred)?.api).toBe(api);
  });

  it('recognizes the official endpoint and brand without trusting display names or lookalike domains', () => {
    expect(matchOfficialProviders(root + '/v1', BUNDLED_CATALOG.presets!).map(p => p.id)).toEqual(['tokenrhythm']);
    expect(resolveProviderLogoKind('tokenrhythm')).toBe('tokenrhythm');
    expect(resolveProviderLogoKind('renamed', { pi: { upstream: root + '/v1' } })).toBe('tokenrhythm');
    expect(resolveProviderLogoKind('renamed', { pi: { upstream: 'https://tokenrhythm.studio.evil.example/v1' } })).toBeNull();
  });

  it('keeps discovered model IDs and parser empty/error distinctions without claiming inventory completeness', () => {
    expect(parseModelsListResponse({ data: [{ id: 'new-account-model' }] }, root + '/v1/models')?.map(m => m.id)).toEqual(['new-account-model']);
    expect(parseModelsListResponse({ data: [] }, root + '/v1/models')).toEqual([]);
    expect(parseModelsListResponse({ error: { code: 'INVALID_API_KEY' } }, root + '/v1/models')).toBeNull();
  });
});
