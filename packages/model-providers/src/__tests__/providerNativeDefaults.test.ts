import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG } from '../catalog.js';
import { buildUserProvider } from '../user-provider.js';
import { modelProtocolComparison } from '../modelProtocol.js';
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

describe('supplier import follows Gateway native model defaults', () => {
  it.each([
    ['openrouter', 'google/gemini-3.8-flash', 'google-generative-ai', [false, false, true], ['anthropic-messages', 'openai-responses', 'openai-completions']],
    ['openrouter', 'anthropic/claude-fable-5', 'anthropic-messages', [true, false, true], ['anthropic-messages', 'openai-responses', 'anthropic-messages']],
    ['openrouter', 'openai/gpt-6-astra', 'openai-responses', [false, true, true], ['anthropic-messages', 'openai-responses', 'openai-completions']],
    ['openrouter', 'deepseek/deepseek-v4-pro', 'openai-completions', [false, false, true], ['anthropic-messages', 'openai-responses', 'openai-completions']],
    ['vercel-ai-gateway', 'google/gemini-3.8-flash', 'google-generative-ai', [false, false, true], ['anthropic-messages', 'openai-responses', 'anthropic-messages']],
    ['vercel-ai-gateway', 'anthropic/claude-fable-5', 'anthropic-messages', [true, false, true], ['anthropic-messages', 'openai-responses', 'anthropic-messages']],
    ['vercel-ai-gateway', 'openai/gpt-6-astra', 'openai-responses', [false, true, true], ['anthropic-messages', 'openai-responses', 'anthropic-messages']],
    ['opencode', 'gemini-3.8-flash', 'google-generative-ai', [false, false, true], ['google-generative-ai', 'google-generative-ai', 'google-generative-ai']],
    ['opencode', 'claude-fable-5', 'anthropic-messages', [true, false, true], ['anthropic-messages', 'anthropic-messages', 'anthropic-messages']],
    ['opencode', 'gpt-6-astra', 'openai-responses', [false, true, true], ['openai-responses', 'openai-responses', 'openai-responses']],
    ['opencode-go', 'qwen3.7-plus', 'openai-completions', [false, false, true], ['anthropic-messages', 'anthropic-messages', 'anthropic-messages']],
  ] as const)('%s / %s retains supplier endpoints but defaults only native engines', (preset, id, nativeApi, enabled, apis) => {
    const provider = buildUserProvider(connection(preset, id), options);
    const byAgent = Object.fromEntries(agents.map(agent => [agent, provider.models[agent]![0]]));
    const comparison = modelProtocolComparison(provider, byAgent);
    agents.forEach((agent, i) => {
      expect(provider.models[agent]![0]).toMatchObject({ nativeApi, api: apis[i], defaultEnabled: enabled[i] });
      expect(comparison.forAgent(agent)?.mode).toBe(enabled[i] ? 'matching' : 'compatibility');
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
      contextWindow: 1_048_576, maxOutput: 65_536, supportsImageInput: true, defaultEnabled: agent === 'pi',
    });
    Object.assign(config.runtimes.codex!.models[0], { defaultEnabled: true, contextWindow: 64_000,
      reasoning: true, reasoningEfforts: ['low', 'medium'], reasoningDefaultEffort: 'low' } satisfies Partial<ProviderRuntimeModelConfig>);
    config.runtimes.pi!.models[0].defaultEnabled = false;
    const refreshed = buildUserProvider(JSON.parse(JSON.stringify(config)), options);
    expect(refreshed.models.codex![0]).toMatchObject({ defaultEnabled: true, contextWindow: 64_000, defaultEffort: 'low' });
    expect(refreshed.models.pi![0].defaultEnabled).toBe(false);
    expect(refreshed.models['claude-code']![0].defaultEnabled).toBe(false);
  });

  it('does not infer native declarations from hand-written IDs on unrelated endpoints', () => {
    const provider = buildUserProvider({ id: 'proxy', name: 'Proxy', runtimes: {
      codex: { baseUrl: 'https://proxy.example/v1', models: [{ id: 'google/gemini-99', name: 'Gemini', api: 'openai-responses' }] },
    } }, options);
    expect(provider.models.codex![0].nativeApi).toBeUndefined();
    expect(provider.models.codex![0].defaultEnabled).toBe(false);
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
    expect(provider.models.codex![0].defaultEnabled).toBe(nativeApi === 'openai-responses');
  });

  it('all presets leave unknown or mismatched fixed engines off, while preserving Pi adapters', () => {
    let checked = 0;
    for (const preset of options.presets!) {
      const provider = buildUserProvider({ id: `${preset.id}-audit`, name: preset.name, runtimes: Object.fromEntries(
        Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, {
          ...runtime, catalogPresetId: preset.id,
          models: runtime.models.map(({ defaultEnabled: _selection, ...model }) => model),
        }]),
      ) }, options);
      for (const agent of agents) for (const model of provider.models[agent] ?? []) {
        if (model.mode && !['chat', 'responses'].includes(model.mode)) continue;
        const message = `${preset.id}/${agent}/${model.id}`;
        if (agent === 'pi') expect(model.defaultEnabled, message).toBe(true);
        else if (model.defaultEnabled) {
          const api = agent === 'claude-code' ? 'anthropic-messages' : 'openai-responses';
          expect(model.nativeApi, message).toBe(api);
          expect([api, ...(agent === 'codex' ? ['azure-openai-responses'] : [])], message).toContain(model.api);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4000);
  });
});
