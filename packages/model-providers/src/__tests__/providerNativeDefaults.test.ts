import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG } from '../catalog.js';
import { buildUserProvider } from '../user-provider.js';
import { modelProtocolComparison } from '../modelProtocol.js';
import { pickRecommendedAgent } from '../unifiedSelection.js';
import { resolveModelMetadata } from '../modelMetadataLayers.js';
import type { CustomProviderConfig, ProviderRuntimeModelConfig } from '../types.js';

const agents = ['claude-code', 'codex', 'pi'] as const;
const options = { presets: BUNDLED_CATALOG.presets, modelRegistry: BUNDLED_CATALOG.modelRegistry };
function connection(presetId: string, modelId: string): CustomProviderConfig {
  const preset = options.presets!.find(p => p.id === presetId)!;
  return { id: `${presetId}-test`, name: preset.name, runtimes: Object.fromEntries(
    agents.map(agent => {
      const runtime = preset.runtimes[agent]!;
      const selected = runtime.models.find(m => m.id === modelId);
      expect(selected, `${presetId}/${agent}/${modelId} exists in the directory`).toBeDefined();
      const { defaultEnabled: _selection, ...model } = selected!;
      return [agent, { ...runtime, catalogPresetId: preset.id, models: [model] }];
    }),
  ) };
}

// Chris 2026-10-30: an API the supplier offers is used as is and enabled by default; only
// engines that need Cindy's local conversion stay off. Recommendation, not visibility, picks the engine.
const harnessApi = { 'claude-code': 'anthropic-messages', codex: 'openai-responses' } as const;
const usesOfferedApi = (agent: (typeof agents)[number], api: string | undefined) =>
  agent === 'pi' || api === harnessApi[agent] || (agent === 'codex' && api === 'azure-openai-responses');

describe('supplier import enables engines that use an offered API', () => {
  // Chris 2026-10-30: DeepSeek follows the community/Pi default (Chat Completions), so the
  // catalog lists no rule for it and the real bundled directory must still recommend Pi.
  it('recommends Pi for the official DeepSeek connection from the bundled directory', () => {
    const provider = buildUserProvider(connection('deepseek', 'deepseek-v4-pro'), options);
    expect(pickRecommendedAgent(provider, 'deepseek-v4-pro', provider.agents)).toBe('pi');
  });
  it('saved DeepSeek Flash aliases retain the Codex image restriction', () => {
    const config = connection('deepseek', 'deepseek-flash');
    for (const agent of agents) {
      config.runtimes[agent]!.models = [{ id: 'deepseek-v4-flash', name: 'DeepSeek Flash' }];
    }
    const provider = buildUserProvider(config, options);
    for (const agent of agents) {
      const metadata = resolveModelMetadata(options.modelRegistry, 'deepseek', 'deepseek-v4-flash', undefined, undefined, agent);
      expect(metadata.supportsImageInput).toBeUndefined();
    }
    expect(provider.models.codex![0].supportsImageInput).toBe(false);
    const current = buildUserProvider(connection('deepseek', 'deepseek-flash'), options);
    for (const agent of agents) expect(current.models[agent]![0].supportsImageInput).toBe(agent !== 'codex');
  });

  // #7005: route context overrides must also bound the inherited output sent to Pi adapters.
  it.each([
    ['moonshot-kimi-code', 'k3.1-pro', 262_144],
    ['moonshot-kimi-code', 'k3', 262_144],
    ['moonshot-kimi-code', 'k3-256k', 262_144],
    ['moonshot-kimi-code', 'k3.1-pro-highspeed', 1_048_576],
    ['moonshot-kimi-cn', 'kimi-k3.1-pro', 1_048_576],
    ['moonshot-kimi-global', 'kimi-k3.1-pro', 1_048_576],
  ] as const)('%s / %s inherits output within its route context', (preset, id, limit) => {
    const provider = buildUserProvider(connection(preset, id), options);
    for (const agent of agents) {
      const metadata = resolveModelMetadata(options.modelRegistry, preset, id, undefined, undefined, agent);
      expect(metadata.maxOutputTokens).toBeLessThanOrEqual(metadata.contextWindow!);
      const model = provider.models[agent]![0];
      expect(model.contextWindow).toBe(limit);
      expect(model.maxOutput).toBeGreaterThan(0);
      expect(model.maxOutput).toBeLessThanOrEqual(limit);
      if (limit === 1_048_576) expect(model.maxOutput).toBe(limit);
    }
  });

  it.each([
    ['openrouter', 'google/gemini-3.8-flash', 'google-generative-ai', ['anthropic-messages', 'openai-responses', 'openai-completions']],
    ['openrouter', 'anthropic/claude-fable-5', 'anthropic-messages', ['anthropic-messages', 'openai-responses', 'anthropic-messages']],
    ['openrouter', 'openai/gpt-6-astra', 'openai-responses', ['anthropic-messages', 'openai-responses', 'openai-completions']],
    ['openrouter', 'deepseek/deepseek-v4-pro', 'openai-completions', ['anthropic-messages', 'openai-responses', 'openai-completions']],
    ['vercel-ai-gateway', 'google/gemini-3.8-flash', 'google-generative-ai', ['anthropic-messages', 'openai-responses', 'anthropic-messages']],
    ['vercel-ai-gateway', 'anthropic/claude-fable-5', 'anthropic-messages', ['anthropic-messages', 'openai-responses', 'anthropic-messages']],
    ['vercel-ai-gateway', 'openai/gpt-6-astra', 'openai-responses', ['anthropic-messages', 'openai-responses', 'anthropic-messages']],
    ['opencode', 'gemini-3.8-flash', 'google-generative-ai', ['google-generative-ai', 'google-generative-ai', 'google-generative-ai']],
    ['opencode', 'claude-fable-5', 'anthropic-messages', ['anthropic-messages', 'anthropic-messages', 'anthropic-messages']],
    ['opencode', 'gpt-6-astra', 'openai-responses', ['openai-responses', 'openai-responses', 'openai-responses']],
    ['opencode-go', 'qwen3.7-plus', 'openai-completions', ['anthropic-messages', 'anthropic-messages', 'anthropic-messages']],
  ] as const)('%s / %s retains supplier endpoints and defaults on every engine without local conversion', (preset, id, nativeApi, apis) => {
    const provider = buildUserProvider(connection(preset, id), options);
    const byAgent = Object.fromEntries(agents.map(agent => [agent, provider.models[agent]![0]]));
    const comparison = modelProtocolComparison(provider, byAgent);
    agents.forEach((agent, i) => {
      const enabled = usesOfferedApi(agent, apis[i]);
      expect(provider.models[agent]![0]).toMatchObject({ nativeApi, api: apis[i], defaultEnabled: enabled });
      expect(comparison.forAgent(agent)?.mode).toBe(enabled ? 'matching' : 'compatibility');
    });
  });

  it('new Hermes directory models retain their declared Chat route and metadata', () => {
    const preset = options.presets!.find(p => p.id === 'nous')!;
    const config: CustomProviderConfig = { id: 'nous-test', name: 'Hermes', runtimes: Object.fromEntries(agents.map(agent => [agent, {
      ...preset.runtimes[agent], catalogPresetId: preset.id, models: [{
        id: 'google/gemini-3.8-flash', name: 'Gemini', api: 'openai-completions',
        discoveredMetadata: { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsImageInput: true,
          efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      }],
    }])) };
    const provider = buildUserProvider(config, options);
    for (const agent of agents) expect(provider.models[agent]![0]).toMatchObject({
      api: 'openai-completions', nativeApi: 'google-generative-ai', defaultEnabled: agent === 'pi',
      contextWindow: 1_048_576, maxOutput: 65_536, supportsImageInput: true,
      efforts: ['low', 'medium', 'high'], defaultEffort: 'medium',
    });
  });

  it.each(['current', 'id-only'] as const)('refreshing %s OpenRouter imports preserves exact limits and user overrides', version => {
    const config = connection('openrouter', 'google/gemini-3.8-flash');
    if (version === 'id-only') for (const agent of agents) {
      config.runtimes[agent]!.models = [{ id: 'google/gemini-3.8-flash', name: 'Gemini' }];
    }
    const before = JSON.stringify(config);
    const imported = buildUserProvider(config, options);
    expect(JSON.stringify(config)).toBe(before);
    for (const agent of agents) expect(imported.models[agent]![0]).toMatchObject({
      contextWindow: 1_048_576, maxOutput: 65_536, supportsImageInput: true, defaultEnabled: true,
    });
    Object.assign(config.runtimes.codex!.models[0], { defaultEnabled: true, contextWindow: 64_000,
      reasoning: true, reasoningEfforts: ['low', 'medium'], reasoningDefaultEffort: 'low' } satisfies Partial<ProviderRuntimeModelConfig>);
    config.runtimes.pi!.models[0].defaultEnabled = false;
    const refreshed = buildUserProvider(JSON.parse(JSON.stringify(config)), options);
    expect(refreshed.models.codex![0]).toMatchObject({ defaultEnabled: true, contextWindow: 64_000, defaultEffort: 'low' });
    expect(refreshed.models.pi![0].defaultEnabled).toBe(false);
    expect(refreshed.models['claude-code']![0].defaultEnabled).toBe(true);
  });

  it('keeps the manufacturer family on unrelated endpoints and enables the offered Responses API', () => {
    const provider = buildUserProvider({ id: 'proxy', name: 'Proxy', runtimes: {
      codex: { baseUrl: 'https://proxy.example/v1', models: [{ id: 'google/gemini-99', name: 'Gemini', api: 'openai-responses' }] },
    } }, options);
    expect(provider.models.codex![0].nativeApi).toBe('google-generative-ai');
    expect(provider.models.codex![0].defaultEnabled).toBe(true);
  });

  it.each([null, 'openai-responses'] as const)('a Server correction %s wins over the local Gemini declaration', nativeApi => {
    const config = connection('openrouter', 'google/gemini-3.8-flash');
    const provider = buildUserProvider(config, { ...options, modelRegistry: {
      schemaVersion: 5, updatedAt: '2099-09-13T00:00:00Z', models: [{
        id: 'google/gemini-3.8-flash', name: 'Gemini', nativeApi,
        routes: [{ providerId: config.id, modelId: 'google/gemini-3.8-flash', agents: ['claude-code', 'codex'] }],
      }],
    } });
    for (const agent of agents) expect(provider.models[agent]![0].nativeApi).toBe(nativeApi);
    expect(provider.models.codex![0].defaultEnabled).toBe(true);
  });

  function auditProvider(preset: NonNullable<typeof options.presets>[number]) {
    return buildUserProvider({ id: `${preset.id}-audit`, name: preset.name, runtimes: Object.fromEntries(
      Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, {
        ...runtime, catalogPresetId: preset.id,
        models: runtime.models.map(({ defaultEnabled: _selection, ...model }) => model),
      }]),
    ) }, options);
  }

  // Each supplier gets its own test budget and failure report as the catalog grows.
  it.each(options.presets!)('$id enables engines on an offered API and leaves local conversion off', preset => {
    const provider = auditProvider(preset);
    let checked = 0;
    for (const agent of agents) for (const model of provider.models[agent] ?? []) {
      if (model.mode && !['chat', 'responses'].includes(model.mode)) continue;
      checked++;
      const message = `${preset.id}/${agent}/${model.id}`;
      // Without a declared API, a fixed-protocol engine sends its own format to the configured endpoint.
      const wire = model.route?.wireProtocol ?? provider.routing[agent]?.wireProtocol;
      const api = model.api ?? (agent === 'pi' ? model.piApi : undefined) ??
        (wire === 'openai-chat' ? 'openai-completions' : wire) ?? (agent === 'pi' ? undefined : harnessApi[agent]);
      expect(model.defaultEnabled, message).toBe(usesOfferedApi(agent, api));
    }
    expect(checked).toBe(agents.reduce((total, agent) => total + (preset.runtimes[agent]?.models.length ?? 0), 0));
  });

  // Each supplier case above verifies that every input model was actually audited.
  it('audits more than 4000 conversational models across all presets', () => {
    const count = options.presets!.reduce((total, preset) => total + agents.reduce(
      (subtotal, agent) => subtotal + (preset.runtimes[agent]?.models.length ?? 0), 0,
    ), 0);
    expect(count).toBeGreaterThan(4000);
  });
});
