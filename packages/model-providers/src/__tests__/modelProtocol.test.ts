import { describe, expect, it } from 'vitest';
import { buildUserProvider } from '../user-provider.js';
import { BUNDLED_CATALOG } from '../catalog.js';
import type { CustomProviderConfig, ProviderPreset, ProviderRuntimeModelConfig } from '../types.js';
import { modelProtocolComparison, nativeModelAgents } from '../modelProtocol.js';
import { pickRecommendedAgent, resolveAgentCapability } from '../unifiedSelection.js';
import type { CatalogModel, PiModelApi, Provider } from '../types.js';

const model: CatalogModel = {
  id: 'future/model',
  name: 'Future',
  contextWindow: 1048576,
  efforts: [],
  defaultEffort: null,
};
function fixture(api?: PiModelApi) {
  const byAgent: Record<'claude-code' | 'codex' | 'pi', CatalogModel> = {
    'claude-code': { ...model },
    codex: { ...model },
    pi: { ...model, ...(api ? { piApi: api, nativeApi: api } : {}) },
  };
  const provider = {
    id: 'xd',
    agents: ['claude-code', 'codex', 'pi'],
    routing: {
      'claude-code': { wireProtocol: 'anthropic-messages' },
      codex: { wireProtocol: 'openai-responses' },
      pi: { wireProtocol: 'openai-responses' },
    },
    models: Object.fromEntries(Object.entries(byAgent).map(([agent, entry]) => [agent, [entry]])),
  } as Provider;
  return { provider, byAgent };
}

describe('per-model protocol comparison', () => {
  it('displays the fixed-protocol host route instead of conflicting API metadata', () => {
    const { provider, byAgent } = fixture();
    byAgent.codex.api = 'openai-responses';
    byAgent.codex.route = { baseUrl: 'https://example.invalid', wireProtocol: 'openai-chat', requestPath: '/custom' };
    expect(modelProtocolComparison(provider, byAgent).forAgent('codex')).toMatchObject({
      outbound: 'openai-completions', localConversion: true,
    });
    delete byAgent.codex.route;
    provider.routing.codex!.wireProtocol = 'openai-chat';
    provider.routing.codex!.requestPath = '/custom';
    expect(modelProtocolComparison(provider, byAgent).forAgent('codex')?.outbound).toBe('openai-completions');
  });

  it('distinguishes a stored model override from a catalog route and a connection default', () => {
    const { provider, byAgent } = fixture();
    provider.routing.codex!.wireProtocol = 'openai-chat';
    byAgent.codex.route = { baseUrl: 'https://example.invalid', wireProtocol: 'openai-responses' };
    byAgent.codex.userModelConfig = { id: model.id, name: model.name, api: 'openai-responses' };
    expect(modelProtocolComparison(provider, byAgent).forAgent('codex')).toMatchObject({
      source: 'model', connection: 'openai-completions', outbound: 'openai-responses',
    });
    delete byAgent.codex.userModelConfig.api;
    expect(modelProtocolComparison(provider, byAgent).forAgent('codex')?.source).toBe('catalog');
    delete byAgent.codex.route;
    expect(modelProtocolComparison(provider, byAgent).forAgent('codex')).toMatchObject({
      source: 'connection', outbound: 'openai-completions',
    });
    // A deliberate choice remains an override even while equal to the default.
    byAgent.codex.api = 'openai-completions';
    byAgent.codex.userModelConfig.api = 'openai-completions';
    expect(modelProtocolComparison(provider, byAgent).forAgent('codex')?.source).toBe('model');
  });

  // Chris 2026-10-30: an API the upstream offers is used as is, even when the gateway
  // serves it for another vendor's model. Only Cindy's local conversion is compatibility.
  it('treats every Gateway front door as offered and still recommends Pi for a Google model', () => {
    const { provider, byAgent } = fixture('google-generative-ai');
    const result = modelProtocolComparison(provider, byAgent);
    expect(result.reference).toBe('google-generative-ai');
    expect(result.forAgent('claude-code')).toMatchObject({
      harness: 'anthropic-messages',
      outbound: 'anthropic-messages',
      mode: 'matching',
      localConversion: false,
    });
    expect(result.forAgent('codex')).toMatchObject({
      harness: 'openai-responses',
      outbound: 'openai-responses',
      mode: 'matching',
      localConversion: false,
    });
    expect(result.upstreamApis).toEqual(['anthropic-messages', 'openai-responses', 'google-generative-ai']);
    expect(result.forAgent('pi')).toMatchObject({
      harness: 'google-generative-ai',
      outbound: 'google-generative-ai',
      mode: 'matching',
    });
    expect(pickRecommendedAgent(provider, model.id, provider.agents)).toBe('pi');
    expect(pickRecommendedAgent(provider, model.id, ['claude-code', 'codex'])).toBe('claude-code');
  });

  it.each(['openai-chat', 'openai-responses'] as const)(
    'marks a Chat Completions model as compatibility only when Codex converts locally (%s)',
    (wireProtocol) => {
      const { provider, byAgent } = fixture('openai-completions');
      provider.routing.codex!.wireProtocol = wireProtocol;
      const mode = wireProtocol === 'openai-chat' ? 'compatibility' : 'matching';
      expect(modelProtocolComparison(provider, byAgent).forAgent('codex')).toMatchObject({
        harness: 'openai-responses',
        outbound: wireProtocol === 'openai-chat' ? 'openai-completions' : 'openai-responses',
        localConversion: wireProtocol === 'openai-chat',
        mode,
      });
      expect(resolveAgentCapability([{ ...provider, connected: true }], 'xd', model.id, 'codex')?.protocolMode)
        .toBe(mode);
    },
  );

  it('does not infer a native Google route or recommendation from a Gemini name', () => {
    const { provider, byAgent } = fixture('openai-responses');
    for (const entry of Object.values(byAgent)) entry.id = 'google/gemini-future';
    expect(pickRecommendedAgent(provider, 'google/gemini-future', provider.agents)).toBe('codex');
    expect(modelProtocolComparison(provider, byAgent).forAgent('pi')?.outbound).toBe(
      'openai-responses',
    );
  });

  it('only recommends a native candidate when its effective route also matches', () => {
    const { provider, byAgent } = fixture('openai-responses');
    byAgent.codex.route = {
      baseUrl: 'https://example.invalid',
      wireProtocol: 'anthropic-messages',
    };
    expect(pickRecommendedAgent(provider, model.id, provider.agents)).toBe('pi');
    byAgent.pi.nativeApi = 'google-generative-ai';
    expect(modelProtocolComparison(provider, byAgent).forAgent('pi')?.mode).toBe('matching');
    expect(pickRecommendedAgent(provider, model.id, provider.agents)).toBe('pi');
  });

  it('uses model route overrides for local conversion, ignoring obsolete compatibility annotations', () => {
    const { provider, byAgent } = fixture('anthropic-messages');
    const codex = {
      ...model,
      route: {
        baseUrl: 'https://example.invalid',
        wireProtocol: 'anthropic-messages' as const,
      },
    };
    expect(
      modelProtocolComparison(provider, { ...byAgent, codex }).forAgent('codex'),
    ).toMatchObject({
      harness: 'openai-responses',
      outbound: 'anthropic-messages',
      mode: 'compatibility',
      localConversion: true,
    });
    expect(
      modelProtocolComparison(provider, {
        ...byAgent,
        codex: { ...model, codexCompatibilityWireProtocol: 'openai-chat' },
      }).forAgent('codex')?.outbound,
    ).toBe('openai-responses');
  });

  // Local conversion changes the engine side only; the API it reaches is still one the upstream serves.
  it('lists a converted outbound API among upstream APIs', () => {
    const claude = { ...model, route: { baseUrl: 'https://example.invalid/v1', wireProtocol: 'openai-chat' as const } };
    const provider = { id: 'custom', source: 'user', agents: ['claude-code'], routing: {}, models: { 'claude-code': [claude] } } as unknown as Provider;
    const result = modelProtocolComparison(provider, { 'claude-code': claude });
    expect(result.forAgent('claude-code')).toMatchObject({ outbound: 'openai-completions', localConversion: true });
    expect(result.upstreamApis).toEqual(['openai-completions']);
  });

  it('projects protocol support with the same provider and real bridge model identity', () => {
    const { provider } = fixture('google-generative-ai');
    const other = {
      ...provider,
      id: 'other',
      models: { codex: [{ ...model, nativeApi: 'openai-responses' as const }] },
    };
    const providers = [
      { ...provider, connected: true },
      { ...other, connected: true },
    ];
    expect(resolveAgentCapability(providers, 'xd', model.id, 'pi')).toMatchObject({
      protocolMode: 'matching',
      nativeApi: 'google-generative-ai',
      outboundApi: 'google-generative-ai',
    });
    expect(resolveAgentCapability(providers, 'xd', model.id, 'codex')).toMatchObject({
      protocolMode: 'matching',
      nativeApi: 'google-generative-ai',
      outboundApi: 'openai-responses',
    });
    expect(resolveAgentCapability(providers, 'other', model.id, 'codex')?.protocolMode).toBe(
      'matching',
    );
    // The ChatGPT subscription bridge converts Claude Code requests locally to Responses.
    const subscription = {
      ...provider,
      id: 'openai',
      source: 'builtin' as const,
      connected: true,
      models: {
        codex: [{ ...model, id: 'gpt-test' }],
        'claude-code': [{ ...model, id: 'chatgpt/gpt-test' }],
      },
    };
    expect(
      resolveAgentCapability([subscription], 'openai', 'gpt-test', 'claude-code'),
    ).toMatchObject({
      wireModelId: 'chatgpt/gpt-test',
      protocolMode: 'compatibility',
      outboundApi: 'openai-responses',
    });
  });

  it('keeps absent declarations unknown and does not invent a route in redacted views', () => {
    const { provider, byAgent } = fixture();
    const result = modelProtocolComparison(provider, byAgent);
    expect(result.reference).toBeNull();
    expect(result.forAgent('pi')?.mode).toBe('matching');
    expect(
      modelProtocolComparison(
        { id: 'xd', routing: { codex: {} } as Provider['routing'] },
        byAgent,
      ).forAgent('codex')?.outbound,
    ).toBeNull();
    expect(modelProtocolComparison(provider, {}).forAgent('pi')).toBeNull();
  });
});


describe('custom supplier transport ownership', () => {
  it.each(['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai', 'bedrock-converse-stream', 'azure-openai-responses', 'google-vertex', 'mistral-conversations'] as const)(
    'Pi uses %s directly; only mismatching fixed-protocol harnesses require conversion', api => {
      const { provider, byAgent } = fixture('google-generative-ai');
      provider.source = 'user';
      // Exercise the model-only API fallback. A declared connection route takes
      // precedence for fixed-protocol hosts (covered above), regardless of vendor metadata.
      provider.routing = {};
      for (const model of Object.values(byAgent)) { model.api = api; model.nativeApi = api; }
      const result = modelProtocolComparison(provider, byAgent);
      expect(result.forAgent('pi')).toMatchObject({ outbound: api, mode: 'matching', localConversion: false });
      expect(result.forAgent('claude-code')?.mode).toBe(api === 'anthropic-messages' ? 'matching' : 'compatibility');
      expect(result.forAgent('codex')?.mode).toBe(['openai-responses', 'azure-openai-responses'].includes(api) ? 'matching' : 'compatibility');
    },
  );

  it('enables every engine whose front door the Gateway offers (Gateway, user supplier)', () => {
    for (const source of [undefined, 'user'] as const) {
      const { provider, byAgent } = fixture('google-generative-ai');
      if (source) provider.source = source;
      byAgent.pi.api = 'openai-completions';
      const comparison = modelProtocolComparison(provider, byAgent);
      expect(comparison.forAgent('claude-code')).toMatchObject({ mode: 'matching', localConversion: false });
      expect(comparison.forAgent('codex')).toMatchObject({ mode: 'matching', localConversion: false });
      expect(comparison.forAgent('pi')).toMatchObject({ mode: 'matching', outbound: 'openai-completions' });
      expect(nativeModelAgents(provider, byAgent)).toEqual(['claude-code', 'codex', 'pi']);
    }
  });

  it('keeps a built-in subscription bridge in compatibility mode and off by default', () => {
    const { provider, byAgent } = fixture('openai-responses');
    provider.id = 'openai';
    provider.source = 'builtin';
    const comparison = modelProtocolComparison(provider, byAgent);
    expect(comparison.forAgent('claude-code')).toMatchObject({ outbound: 'openai-responses', mode: 'compatibility' });
    expect(comparison.forAgent('pi')).toMatchObject({ outbound: 'openai-responses', mode: 'matching' });
    expect(nativeModelAgents(provider, byAgent)).toEqual(['codex', 'pi']);
  });
});


describe('preset protocol provenance (#6015)', () => {
  const presetModel: ProviderRuntimeModelConfig = {
    id: 'preset-model', name: 'Preset model', api: 'anthropic-messages', piApi: 'anthropic-messages',
    route: { baseUrl: 'https://supplier.example.test', wireProtocol: 'anthropic-messages', requestPath: '/messages' },
  };
  const preset: ProviderPreset = { id: 'fixture-preset', name: 'Fixture', runtimes: { pi: {
    baseUrl: 'https://supplier.example.test', wireProtocol: 'openai-chat', models: [presetModel],
  } } };
  const config = (): CustomProviderConfig => ({ id: 'preset-connection', name: 'Fixture', runtimes: { pi: {
    ...preset.runtimes.pi!, catalogPresetId: preset.id, models: [structuredClone(presetModel)],
  } } });
  function project(value: CustomProviderConfig, presets = [preset]) {
    const provider = buildUserProvider(value, { presets });
    return { provider, model: provider.models.pi![0]!, protocol: modelProtocolComparison(provider, { pi: provider.models.pi![0]! }).forAgent('pi') };
  }
  it('treats saved preset api, piApi and route snapshots as catalog defaults without rewriting storage', () => {
    const value = config();
    value.runtimes.pi!.models[0]!.contextWindow = 32768;
    const before = structuredClone(value);
    const result = project(value);
    expect(result.protocol).toMatchObject({ source: 'catalog', customized: false, outbound: 'anthropic-messages' });
    expect(result.model.userModelConfig).toEqual(before.runtimes.pi!.models[0]);
    expect(value).toEqual(before);
  });
  it.each(['api', 'piApi', 'baseUrl', 'wireProtocol', 'requestPath'] as const)('keeps a diverging %s field customized', field => {
    const value = config();
    const stored = value.runtimes.pi!.models[0]!;
    if (field === 'api' || field === 'piApi') stored[field] = 'openai-responses';
    else if (field === 'baseUrl') stored.route!.baseUrl = 'https://other.example.test';
    else if (field === 'wireProtocol') stored.route!.wireProtocol = 'openai-responses';
    else stored.route!.requestPath = '/custom';
    expect(project(value).protocol).toMatchObject({ source: 'model', customized: true });
  });
  it('does not infer matching defaults from an unavailable preset or a detached endpoint', () => {
    expect(project(config(), []).protocol).toMatchObject({ source: 'model', customized: true });
    const value = config();
    value.runtimes.pi!.baseUrl = 'https://detached.example.test';
    expect(project(value).protocol).toMatchObject({ source: 'model', customized: true });
  });
  it('labels untouched OpenCode Go Pi snapshots as catalog defaults', () => {
    const go = BUNDLED_CATALOG.presets!.find(item => item.id === 'opencode-go')!;
    expect(go).toBeDefined();
    const provider = buildUserProvider({ id: 'go', name: 'Go', runtimes: { pi: {
      ...structuredClone(go.runtimes.pi!), catalogPresetId: go.id,
    } } }, { presets: BUNDLED_CATALOG.presets });
    const models = provider.models.pi!.filter(item => item.userModelConfig?.api || item.userModelConfig?.piApi || item.userModelConfig?.route);
    expect(models.length).toBeGreaterThan(0);
    for (const item of models) expect(modelProtocolComparison(provider, { pi: item }).forAgent('pi'))
      .toMatchObject({ source: 'catalog', customized: false });
  });
});


describe('catalog-corrected legacy protocol provenance (#6015)', () => {
  const oldModel: ProviderRuntimeModelConfig = { id: 'qwen3.7-plus', name: 'Qwen',
    api: 'openai-completions', piApi: 'openai-completions', contextWindow: 64000, defaultEnabled: false,
    route: { baseUrl: 'https://opencode.ai/zen/go/v1', wireProtocol: 'openai-chat' },
  };
  it.each(['claude-code', 'codex', 'pi'] as const)('retains catalog provenance for a repaired %s import with or without current presets', agent => {
    const config: CustomProviderConfig = { id: 'legacy-go', name: 'Legacy Go', runtimes: { [agent]: {
      catalogPresetId: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', wireProtocol: 'openai-chat',
      models: [structuredClone(oldModel)],
    } } };
    const before = structuredClone(config);
    for (const presets of [undefined, BUNDLED_CATALOG.presets]) {
      const provider = buildUserProvider(config, { presets });
      const model = provider.models[agent]![0]!;
      expect(modelProtocolComparison(provider, { [agent]: model }).forAgent(agent))
        .toMatchObject({ source: 'catalog', customized: false, outbound: 'anthropic-messages' });
      expect(model.userModelConfig).toEqual(oldModel);
      expect(model.defaultEnabled).toBe(false);
      expect(config).toEqual(before);
    }
  });
  it.each(['model path', 'connection path', 'custom host', 'other product', 'explicit non-Chat API'] as const)(
    'does not label a protected %s override as catalog repair', kind => {
      const runtime = { catalogPresetId: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1',
        wireProtocol: 'openai-chat' as const, requestPath: undefined as string | undefined,
        models: [structuredClone(oldModel)] };
      if (kind === 'model path') runtime.models[0]!.route!.requestPath = '/custom/messages';
      if (kind === 'connection path') runtime.requestPath = '/custom/messages';
      if (kind === 'custom host') runtime.models[0]!.route!.baseUrl = 'https://custom.example.test';
      if (kind === 'other product') runtime.baseUrl = 'https://opencode.ai/zen/v1';
      if (kind === 'explicit non-Chat API') runtime.models[0]!.api = 'openai-responses';
      const provider = buildUserProvider({ id: 'protected', name: 'Protected', runtimes: { pi: runtime } });
      expect(modelProtocolComparison(provider, { pi: provider.models.pi![0]! }).forAgent('pi'))
        .toMatchObject({ source: 'model', customized: true });
    },
  );
});
