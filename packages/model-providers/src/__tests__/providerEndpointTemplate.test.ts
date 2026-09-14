import { describe, expect, it } from 'vitest';
import { bindProviderPresetRuntime, providerEndpointBindings } from '../providerEndpointTemplate.js';
import { BUNDLED_CATALOG } from '../builtin.js';
import { buildUserProvider } from '../user-provider.js';

describe('cloud account endpoint setup', () => {
  it('binds Cloudflare account and gateway to every model route', () => {
    const preset = BUNDLED_CATALOG.presets!.find(preset => preset.id === 'cloudflare-ai-gateway')!;
    const runtimes = Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, {
      ...bindProviderPresetRuntime(runtime!, runtime!.baseUrl.replace('{CLOUDFLARE_ACCOUNT_ID}', 'my-account').replace('{CLOUDFLARE_GATEWAY_ID}', 'my-gateway')),
      catalogPresetId: preset.id,
    }]));
    expect(JSON.stringify(runtimes)).not.toContain('{CLOUDFLARE_');
    const provider = buildUserProvider({ id: 'my-cloud', name: 'My Cloud', runtimes }, { presets: BUNDLED_CATALOG.presets });
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      expect(provider.models[agent]).toHaveLength(preset.runtimes[agent]!.models.length);
      for (const model of provider.models[agent]!) {
        expect(model.api).toBeDefined();
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(model.maxOutput).toBeGreaterThan(0);
        expect(model.cost).toBeDefined();
      }
    }
  });
  it('keeps Azure metadata attached to the resource-specific connection', () => {
    const preset = BUNDLED_CATALOG.presets!.find(preset => preset.id === 'azure-openai-responses')!;
    const runtimes = Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, {
      ...bindProviderPresetRuntime(runtime!, 'https://my-resource.openai.azure.com/openai/v1'), catalogPresetId: preset.id,
    }]));
    const provider = buildUserProvider({ id: 'my-azure', name: 'My Azure', runtimes }, { presets: BUNDLED_CATALOG.presets });
    for (const models of Object.values(provider.models)) for (const model of models ?? []) {
      expect(model.api).toBe('azure-openai-responses');
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxOutput).toBeGreaterThan(0);
    }
  });
  it('keeps the Azure language for a new deployment ID without borrowing another model limits', () => {
    const preset = BUNDLED_CATALOG.presets!.find(preset => preset.id === 'azure-openai-responses')!;
    const runtimes = Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, {
      ...bindProviderPresetRuntime(runtime!, 'https://my-resource.openai.azure.com/openai/v1'), catalogPresetId: preset.id,
      models: [{ id: 'my-new-deployment', name: 'My deployment', contextWindow: 64000 }],
    }]));
    const provider = buildUserProvider({ id: 'new-azure', name: 'Azure', runtimes }, { presets: BUNDLED_CATALOG.presets });
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const model = provider.models[agent]![0]!;
      expect(model.api).toBe('azure-openai-responses');
      expect(model.contextWindow).toBe(64000);
      expect(model.maxOutput).toBeUndefined();
      expect(model.userModelConfig?.api).toBeUndefined();
    }
  });
  it('rejects substituted hosts, path traversal and unfinished values as account bindings', () => {
    const template = 'https://{resource}.openai.azure.com/openai/v1';
    expect(providerEndpointBindings(template, 'https://account.openai.azure.com/openai/v1')).toEqual({ resource: 'account' });
    for (const endpoint of ['https://account.openai.azure.com.evil.test/openai/v1', template, 'https://a/b.openai.azure.com/openai/v1']) {
      expect(providerEndpointBindings(template, endpoint)).toBeNull();
    }
  });
});
