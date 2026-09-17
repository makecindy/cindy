import { describe, expect, it } from 'vitest';
import {
  bindProviderEndpoint,
  bindProviderPresetRuntime,
  canonicalProviderEndpoint,
  providerEndpointBindings,
} from '../providerEndpointTemplate.js';
import { BUNDLED_CATALOG } from '../builtin.js';
import { buildUserProvider } from '../user-provider.js';

const VERTEX_TEMPLATE = 'https://{location}-aiplatform.googleapis.com';

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

  it('accepts the official Azure Cognitive Services host without rewriting it to openai.azure.com', () => {
    const preset = BUNDLED_CATALOG.presets!.find(preset => preset.id === 'azure-openai-responses')!;
    const endpoint = 'https://my-resource.cognitiveservices.azure.com/openai/v1';
    expect(providerEndpointBindings(preset.runtimes.pi!.baseUrl, endpoint)).toEqual({ resource: 'my-resource' });
    expect(bindProviderPresetRuntime(preset.runtimes.pi!, endpoint).baseUrl).toBe(endpoint);
    expect(canonicalProviderEndpoint(preset.runtimes.pi!.baseUrl, 'https://my-resource.openai.azure.com/openai/v1'))
      .toBe('https://my-resource.openai.azure.com/openai/v1');
  });
});

describe('Vertex official endpoint family', () => {
  it('binds the unprefixed global host and us/eu multi-region hosts', () => {
    expect(providerEndpointBindings(VERTEX_TEMPLATE, 'https://aiplatform.googleapis.com')).toEqual({ location: 'global' });
    expect(providerEndpointBindings(VERTEX_TEMPLATE, 'https://aiplatform.googleapis.com/v1')).toEqual({ location: 'global' });
    expect(providerEndpointBindings(VERTEX_TEMPLATE, 'https://aiplatform.us.rep.googleapis.com')).toEqual({ location: 'us' });
    expect(providerEndpointBindings(VERTEX_TEMPLATE, 'https://aiplatform.eu.rep.googleapis.com/')).toEqual({ location: 'eu' });
    expect(providerEndpointBindings(VERTEX_TEMPLATE, 'https://us-central1-aiplatform.googleapis.com')).toEqual({ location: 'us-central1' });
  });

  it('normalizes template-induced aliases to the official hosts', () => {
    expect(canonicalProviderEndpoint(VERTEX_TEMPLATE, 'https://global-aiplatform.googleapis.com'))
      .toBe('https://aiplatform.googleapis.com');
    expect(canonicalProviderEndpoint(VERTEX_TEMPLATE, 'https://us-aiplatform.googleapis.com'))
      .toBe('https://aiplatform.us.rep.googleapis.com');
    expect(bindProviderEndpoint(VERTEX_TEMPLATE, { location: 'global' })).toBe('https://aiplatform.googleapis.com');
    expect(bindProviderEndpoint(VERTEX_TEMPLATE, { location: 'us' })).toBe('https://aiplatform.us.rep.googleapis.com');
    expect(bindProviderEndpoint(VERTEX_TEMPLATE, { location: 'europe-west1' }))
      .toBe('https://europe-west1-aiplatform.googleapis.com');
  });

  it('rewrites a stored Vertex alias onto the official host in live routing', () => {
    const preset = BUNDLED_CATALOG.presets!.find(preset => preset.id === 'google-vertex')!;
    const runtimes = Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, {
      ...bindProviderPresetRuntime(runtime!, 'https://global-aiplatform.googleapis.com'),
      catalogPresetId: preset.id,
      baseUrl: 'https://global-aiplatform.googleapis.com',
    }]));
    const provider = buildUserProvider({ id: 'legacy-vertex', name: 'Vertex', runtimes }, { presets: BUNDLED_CATALOG.presets });
    expect(provider.routing.pi?.upstream).toBe('https://aiplatform.googleapis.com');
    expect(provider.routing.codex?.upstream).toBe('https://aiplatform.googleapis.com');
    expect(provider.models.pi?.find(row => row.id === 'gemini-3.8-flash')?.api
      ?? provider.models.pi?.find(row => row.id === 'gemini-3.8-flash')?.piApi).toBe('google-vertex');
  });

  it('keeps Vertex catalog metadata when the user saved a global official host', () => {
    const preset = BUNDLED_CATALOG.presets!.find(preset => preset.id === 'google-vertex')!;
    const runtimes = Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, {
      ...bindProviderPresetRuntime(runtime!, 'https://aiplatform.googleapis.com'), catalogPresetId: preset.id,
    }]));
    const provider = buildUserProvider({ id: 'my-vertex', name: 'Vertex', runtimes }, { presets: BUNDLED_CATALOG.presets });
    const model = provider.models.pi?.find(row => row.id === 'gemini-3.8-flash');
    expect(model?.api ?? model?.piApi).toBe('google-vertex');
    expect(model?.contextWindow).toBeGreaterThan(0);
    expect(provider.routing.pi?.upstream).toBe('https://aiplatform.googleapis.com');
  });

  it('rejects unofficial hosts instead of widening the placeholder regex', () => {
    for (const endpoint of [
      'https://attacker.example',
      'https://aiplatform.googleapis.com.evil.test',
      'https://evil-aiplatform.googleapis.com',
      'https://aiplatform.us.rep.googleapis.com.evil.test',
      'https://aiplatform.asia.rep.googleapis.com',
      'https://us-central1-aiplatform.googleapis.com/projects/p',
      VERTEX_TEMPLATE,
    ]) {
      expect(providerEndpointBindings(VERTEX_TEMPLATE, endpoint), endpoint).toBeNull();
    }
  });
});
