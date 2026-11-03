import { providerProtocolCandidates } from '../providerProtocolProbe.js';
import { describe, it, expect } from 'vitest';
import { BUNDLED_CATALOG, sortPresetsForRegion } from '../index.js';
import { bindDetectedProvider, classifyProviderAddress, detectDeploymentProviders, enrichDetectedModels, matchOfficialProviders, providerDeploymentRoot, type ProviderEvidence } from '../providerDetection.js';
// Contract: scheme 2 identifies configurations from combined evidence, never a port/model name.
// New production entry; previous catalog tests cover parsing, not identity/binding. Unit, no network.
const presets = BUNDLED_CATALOG.presets ?? [];
const models = { data: [{ id: 'alias', root: 'weights', owned_by: 'vllm', max_model_len: 8192 }] };
const evidence: ProviderEvidence = {
  subPublic: { code: 0, data: { version: '0.2.17', hide_ccs_import_button: false, backend_mode_enabled: true, subscription_enabled: false } },
  subBilling: { object: 'sub2api.key_billing', schema_version: 1 },
  liteReady: { litellm_version: '1.106.0', status: 'healthy', success_callbacks: [] },
  liteModels: { data: [{ model_name: 'alias', litellm_params: {}, model_info: {} }] },
  lmGreeting: { lmstudio: true }, lmModels: { models: [] },
  llamaProps: { default_generation_settings: {}, total_slots: 1, build_info: 'b11723' },
  vllmVersion: { version: '0.0.0+source.test' }, models,
};

describe('deployment evidence', () => {
  it.each([
    ['sub2api', ['subPublic', 'subBilling']], ['litellm', ['liteReady', 'liteModels']],
    ['lmstudio', ['lmGreeting', 'lmModels']], ['llamacpp', ['llamaProps', 'models']], ['vllm', ['vllmVersion', 'models']],
  ] as const)('requires combined evidence for %s', (id, keys) => {
    const input = Object.fromEntries(keys.map(k => [k, evidence[k]]));
    expect(detectDeploymentProviders(input)).toEqual([id]);
    for (const key of keys) expect(detectDeploymentProviders({ [key]: evidence[key] })).toEqual([]);
  });
  it('retains contradictory matches instead of choosing the first response', () => {
    expect(detectDeploymentProviders(evidence)).toEqual(['sub2api', 'litellm', 'lmstudio', 'llamacpp', 'vllm']);
  });
  it('rejects error bodies and coerced number/boolean fields', () => {
    expect(detectDeploymentProviders({ ...evidence, subPublic: { code: false, data: (evidence.subPublic as any).data }, subBilling: { object: 'sub2api.key_billing', schema_version: true },
      liteReady: { status: 'healthy' }, lmModels: { error: 'not found' }, llamaProps: { default_generation_settings: {}, total_slots: '1', build_info: 'x' }, models: { data: [{ id: 'alias', root: 'x', owned_by: 'vllm', max_model_len: true }] },
    })).toEqual([]);
  });
  it('accepts a nonempty native LM directory without the greeting, and rejects unknown types', () => {
    const native = { key: 'weights', type: 'embedding', publisher: 'test', loaded_instances: [] };
    expect(detectDeploymentProviders({ lmModels: { models: [native] } })).toEqual(['lmstudio']);
    expect(detectDeploymentProviders({ lmModels: { models: [{ ...native, type: 'unknown' }] } })).toEqual([]);
  });
  it('does not turn internal aliases into account-visible membership or maximize conflicting capabilities', () => {
    const result = enrichDetectedModels([{ id: 'public-alias', name: 'Alias' }], 'litellm', { liteModels: { data: [
      { model_name: 'public-alias', model_info: { id: 'deployment-1', max_input_tokens: 8192 } },
      { model_name: 'public-alias', model_info: { id: 'deployment-2', max_input_tokens: 32768 } },
      { model_name: 'hidden', model_info: {} },
    ] } });
    expect(result.map(m => m.id)).toEqual(['public-alias']);
    expect(result[0].discoveredMetadata?.contextWindow).toBeUndefined();
  });
  it('maps LM loaded instance aliases while retaining embedding type', () => {
    const result = enrichDetectedModels([{ id: 'friendly', name: 'Friendly' }], 'lmstudio', { lmModels: { models: [
      { key: 'file-name', type: 'embedding', publisher: 'test', loaded_instances: [{ id: 'friendly' }] },
    ] } });
    expect(result[0]).toMatchObject({ id: 'friendly', discoveredMetadata: { mode: 'embedding' } });
  });
});

describe('catalog mapping independent of desktop platform', () => {
  // GUI acceptance 2026-10-21: these empty-key inputs stayed custom. Unit:
  // exercise the real matcher and all harness bindings, not copied URL rules.
  it.each([
    ['https://ark.cn-beijing.volces.com/api/v3', 'volcengine-api'],
    ['https://api.siliconflow.cn/v1', 'siliconflow-cn'],
    ['https://api.siliconflow.com/v1', 'siliconflow-global'],
    ['https://api.mistral.ai/v1', 'mistral'],
    ['https://api.together.xyz/v1', 'together'],
    ['https://api.fireworks.ai/inference/v1', 'fireworks'],
  ])('recognizes and binds official API input %s', (url, id) => {
    const matches = matchOfficialProviders(url, presets);
    expect(matches.map(p => p.id)).toEqual([id]);
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const bound = bindDetectedProvider(matches[0], agent, url);
      expect(bound?.runtimes[agent]).toBeDefined();
      expect(bound?.runtimes[agent]?.baseUrl).not.toContain('{');
    }
    const fake = new URL(url);
    fake.hostname += '.evil.test';
    expect(matchOfficialProviders(fake.toString(), presets)).toEqual([]);
    expect(matchOfficialProviders(url + '/unregistered', presets)).toEqual([]);
    expect(matchOfficialProviders(url + '?token=fake', presets)).toEqual([]);
  });
  it.each(['cn', 'global'] as const)('classifies the entire active catalog without region filtering: %s', region => {
    expect(presets.length).toBeGreaterThan(28);
    for (const p of sortPresetsForRegion(presets, region)) {
      expect(['deployment', 'resource-template', 'official', 'manual']).toContain(classifyProviderAddress(p));
      if (classifyProviderAddress(p) !== 'official') continue;
      for (const runtime of Object.values(p.runtimes)) {
        if (runtime) expect(matchOfficialProviders(runtime.baseUrl, presets).map(p => p.id)).toContain(p.id);
      }
    }
  });
  it('matches exact official origin and business path, preserving multi-plan candidates', () => {
    const original = presets.find(p => p.id === 'deepseek')!;
    const url = original.runtimes.pi!.baseUrl;
    expect(matchOfficialProviders(url, [original, { ...original, id: 'same-address-plan' }])).toHaveLength(2);
    expect(matchOfficialProviders(url.replace('api.deepseek.com', 'api.deepseek.com.evil.test'), presets)).toEqual([]);
    expect(matchOfficialProviders(url + '/unregistered', presets)).toEqual([]);
    expect(matchOfficialProviders(url + '?token=fake', presets)).toEqual([]);
  });
  it('never identifies loopback ports or the generic endpoint template as a brand', () => {
    expect(matchOfficialProviders('http://127.0.0.1:1234/v1', presets)).toEqual([]);
    expect(matchOfficialProviders('https://unknown.example/team/v1', presets)).toEqual([]);
  });
  it.each(['sub2api', 'litellm', 'lmstudio', 'llamacpp', 'vllm'])('binds %s to the remote prefix, never localhost', id => {
    const preset = presets.find(p => p.id === id)!;
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const bound = bindDetectedProvider(preset, agent, 'https://relay.example/team/v1');
      if (!preset.runtimes[agent]) { expect(bound).toBeUndefined(); continue; }
      expect(bound).toBeDefined();
      expect(bound!.runtimes[agent]!.baseUrl).toMatch(/^https:\/\/relay\.example\/team(?:\/v1)?$/);
      expect(Object.keys(bound!.runtimes)).toEqual([agent]);
      if (bound!.runtimes[agent]!.modelsUrl) expect(bound!.runtimes[agent]!.modelsUrl).toMatch(/^https:\/\/relay\.example\/team\//);
    }
  });
  it('keeps business prefixes and rejects unsafe probe derivation', () => {
    expect(providerDeploymentRoot('https://EXAMPLE.com:443/team/v1/')).toBe('https://example.com/team');
    expect(providerDeploymentRoot('http://[::1]:8080/team')).toBe('http://[::1]:8080/team');
    for (const url of ['file:///tmp/x', 'https://user:fake@example.com/v1', 'https://example.com/v1?token=fake', 'https://example.com/v1#x', 'https://example.com/v1/chat/completions']) expect(providerDeploymentRoot(url)).toBeUndefined();
  });
});

// Automatic protocol routes must be persistable, same-origin, and preserve deployment prefixes.
describe('protocol probe candidates', () => {
  it.each([
    ['https://relay.example', 'openai-chat', 'https://relay.example/v1'],
    ['https://relay.example/responses', 'openai-responses', 'https://relay.example'],
    ['https://relay.example/chat/completions', 'openai-chat', 'https://relay.example'],
    ['https://relay.example/team/v1/chat/completions', 'openai-chat', 'https://relay.example/team/v1'],
    ['https://relay.example/team/v1/responses', 'openai-responses', 'https://relay.example/team/v1'],
    ['https://relay.example/team/v1/messages', 'anthropic-messages', 'https://relay.example/team'],
    ['https://relay.example/team/v1beta', 'google-generative-ai', 'https://relay.example/team/v1beta'],
  ])('keeps the exact resource binding for %s', (input, wireProtocol, baseUrl) => {
    const candidates = providerProtocolCandidates(input);
    expect(candidates).toHaveLength(4);
    expect(candidates[0]).toEqual({ baseUrl, wireProtocol });
    expect(candidates.every(item => new URL(item.baseUrl).origin === new URL(input).origin)).toBe(true);
  });
  it('prefers the previously verified route without changing its base', () => {
    expect(providerProtocolCandidates('https://relay.example/team', 'anthropic-messages')[0]).toEqual({
      baseUrl: 'https://relay.example/team', wireProtocol: 'anthropic-messages',
    });
  });
  it.each(['https://relay.example/team/messages', 'https://user:pass@relay.example/v1', 'https://relay.example/v1?key=hidden', 'https://relay.example/v1#fragment', 'file:///tmp/test'])('rejects ambiguous credential or URL binding %s', input => {
    expect(() => providerProtocolCandidates(input)).toThrow();
  });
});

// Official resource identity must not redirect a custom-port service to port 443.
describe('resource template port boundaries', () => {
  it.each([
    ['azure-openai-responses', 'https://reviewaccount.openai.azure.com/openai/v1'],
    ['azure-openai-responses', 'https://reviewaccount.cognitiveservices.azure.com/openai/v1'],
    ['google-vertex', 'https://us-central1-aiplatform.googleapis.com'],
    ['google-vertex', 'https://aiplatform.googleapis.com'],
    ['google-vertex', 'https://aiplatform.eu.rep.googleapis.com'],
  ])('keeps %s custom ports outside automatic identity: %s', (id, input) => {
    const preset = presets.find(p => p.id === id)!;
    for (const port of ['', '443', '9443']) {
      const url = new URL(input); url.port = port;
      expect(matchOfficialProviders(url.toString(), presets).some(p => p.id === id)).toBe(port !== '9443');
      for (const agent of ['claude-code', 'codex', 'pi'] as const) {
        const bound = bindDetectedProvider(preset, agent, url.toString());
        if (port === '9443') expect(bound).toBeUndefined();
        else expect(new URL(bound!.runtimes[agent]!.baseUrl).port).toBe('');
      }
    }
  });
  it.each(['sub2api', 'litellm', 'lmstudio', 'llamacpp', 'vllm'])('preserves deployment port and prefix for %s', id => {
    const preset = presets.find(p => p.id === id)!;
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const runtime = bindDetectedProvider(preset, agent, 'https://relay.example:9443/team/v1')?.runtimes[agent];
      if (!preset.runtimes[agent]) continue;
      expect(runtime!.baseUrl).toMatch(/^https:\/\/relay.example:9443\/team(?:\/v1)?$/);
      if (runtime!.modelsUrl) expect(new URL(runtime!.modelsUrl).port).toBe('9443');
    }
  });
});

// Each fingerprint field is an independent boundary: partial lookalikes must not jump.
describe('fingerprint boundary mutations', () => {
  const checks = [
    ['sub2api', 'subPublic.code'], ['sub2api', 'subPublic.data.version'],
    ['sub2api', 'subPublic.data.hide_ccs_import_button'], ['sub2api', 'subPublic.data.backend_mode_enabled'],
    ['sub2api', 'subPublic.data.subscription_enabled'], ['sub2api', 'subBilling.object'], ['sub2api', 'subBilling.schema_version'],
    ['litellm', 'liteReady.litellm_version'], ['litellm', 'liteReady.status'], ['litellm', 'liteReady.success_callbacks'],
    ['litellm', 'liteModels.data.0.model_name'], ['litellm', 'liteModels.data.0.litellm_params'], ['litellm', 'liteModels.data.0.model_info'],
    ['lmstudio', 'lmGreeting.lmstudio'], ['lmstudio', 'lmModels.models'],
    ['llamacpp', 'llamaProps.default_generation_settings'], ['llamacpp', 'llamaProps.total_slots'], ['llamacpp', 'llamaProps.build_info'], ['llamacpp', 'models.data.0.id'],
    ['vllm', 'vllmVersion.version'], ['vllm', 'models.data.0.id'], ['vllm', 'models.data.0.root'], ['vllm', 'models.data.0.owned_by'], ['vllm', 'models.data.0.max_model_len'],
  ];
  it.each(checks)('rejects %s when %s is missing or null', (id, path) => {
    for (const value of [undefined, null]) {
      const input = structuredClone(evidence);
      const parts = path.split('.');
      let parent: any = input;
      for (const part of parts.slice(0, -1)) parent = parent[part];
      parent[parts.at(-1)!] = value;
      expect(detectDeploymentProviders(input)).not.toContain(id);
    }
  });
  it('does not merge ambiguous LM instance metadata or add hidden models', () => {
    const visible = [{ id: 'shared', name: 'Shared' }];
    const duplicate = { models: [
      { key: 'first', type: 'llm', publisher: 'test', loaded_instances: [{ id: 'shared' }], max_context_length: 8192 },
      { key: 'second', type: 'embedding', publisher: 'test', loaded_instances: [{ id: 'shared' }], max_context_length: 32768 },
    ] };
    expect(enrichDetectedModels(visible, 'lmstudio', { lmModels: duplicate })).toEqual(visible);
  });
});
