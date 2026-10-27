import { describe, expect, it } from 'vitest';
import { buildUserProvider } from '../user-provider.js';
import { alignModelApiRoute, providerInterfaceModelRoute } from '../providerInterfaceRoutes.js';
import { BUNDLED_CATALOG } from '../catalog.js';

describe('documented supplier interfaces', () => {
  // r4365890304 (unit): import saved Model Studio connections through the
  // production resolver. Previous coverage checked protocol shape, not whether
  // these products actually exposed a selected catalog interface.
  it.each([
    ['aliyun-model-studio-cn', 'https://dashscope.aliyuncs.com'],
    ['aliyun-model-studio-global', 'https://dashscope-intl.aliyuncs.com'],
  ])('selects the declared %s saved interfaces without changing user settings', (presetId, host) => {
    const provider = buildUserProvider({ id: 'studio', name: 'Studio', runtimes:
      Object.fromEntries(['claude-code', 'codex', 'pi'].map(agent => [agent, {
        baseUrl: `${host}/${agent === 'codex' ? 'compatible-mode/v1' : 'apps/anthropic'}`,
        wireProtocol: agent === 'codex' ? 'openai-chat' : 'anthropic-messages', catalogPresetId: presetId,
        models: [{ id: 'qwen3.7-flash', contextWindow: 64000, defaultEnabled: false }],
      }])) });
    for (const agent of provider.agents) {
      const api = agent === 'codex' ? 'openai-completions' : 'anthropic-messages';
      expect(provider.models[agent]![0]).toMatchObject({
        api, contextWindow: 64000, defaultEnabled: false,
        selectedInterface: { profileId: `${presetId}-${api}`, route: {
          baseUrl: `${host}/${agent === 'codex' ? 'compatible-mode/v1' : 'apps/anthropic'}`,
        } },
      });
    }
  });
  it.each([
    ['zhipu-glm-cn', 'https://open.bigmodel.cn/api/coding/paas/v4'],
    ['zhipu-glm-global', 'https://api.z.ai/api/coding/paas/v4'],
  ])('declares the server %s Coding endpoint without redirecting public API connections', (presetId, codingBase) => {
    const preset = BUNDLED_CATALOG.presets!.find(p => p.id === presetId)!;
    for (const [baseUrl, profileId] of [
      [codingBase, `${presetId}-coding-openai-completions`],
      [codingBase.replace('/coding/', '/'), `${presetId}-openai-completions`],
    ]) {
      const provider = buildUserProvider({ id: 'glm', name: 'GLM', runtimes: { codex: {
        ...preset.runtimes.codex!, baseUrl, catalogPresetId: presetId,
        models: [{ id: 'glm-5.3-flash', name: 'GLM', contextWindow: 64000, defaultEnabled: false }],
      } } }, { presets: BUNDLED_CATALOG.presets });
      expect(provider.models.codex![0]).toMatchObject({
        api: 'openai-completions', contextWindow: 64000, defaultEnabled: false,
        selectedInterface: { profileId, route: { baseUrl, wireProtocol: 'openai-chat' } },
      });
    }
  });
  it('imports OpenCode Go DeepSeek 4.1 Flash capabilities for every engine', () => {
    const preset = BUNDLED_CATALOG.presets!.find(p => p.id === 'opencode-go')!;
    const provider = buildUserProvider({ id: 'go', name: 'Go', runtimes:
      Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, {
        ...runtime, catalogPresetId: preset.id, models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek' }],
      }])) }, { presets: BUNDLED_CATALOG.presets });
    for (const agent of provider.agents) {
      expect(provider.models[agent]?.[0]).toMatchObject({
        contextWindow: 1_000_000, maxOutput: 384_000, supportsImageInput: true,
        efforts: ['high', 'max'], defaultEffort: 'high', defaultEnabled: agent === 'pi',
      });
    }
  });
  it('keeps every preset HTTP API consistent with the actual route after import', () => {
    for (const preset of BUNDLED_CATALOG.presets ?? []) {
      const provider = buildUserProvider({ id: 'audit', name: preset.id, runtimes:
        Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, {
          ...runtime, catalogPresetId: preset.id,
          models: runtime.models.map(({ defaultEnabled: _selection, ...model }) => model),
        }])) }, { presets: BUNDLED_CATALOG.presets });
      for (const agent of provider.agents) for (const model of provider.models[agent] ?? []) {
        const api = model.api ?? model.piApi;
        if (!api || !['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai', 'google-vertex', 'azure-openai-responses'].includes(api)) continue;
        if (model.route?.requestPath || provider.routing[agent]?.requestPath) continue;
        const expected = api === 'openai-completions' ? 'openai-chat'
          : api === 'azure-openai-responses' ? 'openai-responses'
          : api === 'google-vertex' ? 'google-generative-ai' : api;
        const actual = model.route?.wireProtocol ?? provider.routing[agent]?.wireProtocol
          ?? (agent === 'claude-code' ? 'anthropic-messages' : agent === 'codex' ? 'openai-responses' : 'openai-chat');
        expect(actual, `${preset.id}/${agent}/${model.id}`).toBe(expected);
      }
    }
  });
  it.each(['claude-code', 'codex', 'pi'] as const)('repairs saved Responses/Chat disagreement for %s without resetting user choices', agent => {
    const provider = buildUserProvider({ id: 'go', name: 'Go', runtimes: {
      [agent]: { catalogPresetId: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', wireProtocol: 'openai-chat', models: [{
        id: 'grok-4.5', name: 'Grok', api: 'openai-responses', contextWindow: 64000,
        defaultEnabled: false, reasoning: true, reasoningEfforts: ['low', 'medium'], reasoningDefaultEffort: 'low',
        route: { baseUrl: 'https://opencode.ai/zen/go/v1', wireProtocol: 'openai-chat' },
      }] },
    } });
    expect(provider.models[agent]?.[0]).toMatchObject({ api: 'openai-responses',
      route: { wireProtocol: 'openai-responses', baseUrl: 'https://opencode.ai/zen/go/v1' },
      contextWindow: 64000, defaultEnabled: false, defaultEffort: 'low' });
  });
  it.each([
    ['baseten', 'claude-code', 'https://inference.baseten.co/v1', 'https://inference.baseten.co', 'anthropic-messages'],
    ['groq', 'codex', 'https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1', 'openai-responses'],
    ['huggingface', 'codex', 'https://router.huggingface.co/v1', 'https://router.huggingface.co/v1', 'openai-responses'],
    ['lmstudio', 'codex', 'http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1', 'openai-responses'],
    ['litellm', 'claude-code', 'http://127.0.0.1:4000/v1', 'http://127.0.0.1:4000', 'anthropic-messages'],
    ['longcat', 'codex', 'https://api.longcat.chat/openai/v1', 'https://api.longcat.chat/openai/v1', 'openai-completions'],
  ] as const)('imports newly discovered %s models using the declared %s interface', (preset, agent, base, target, api) => {
    const provider = buildUserProvider({ id: 'account', name: 'Account', runtimes: {
      [agent]: { catalogPresetId: preset, baseUrl: base, wireProtocol: 'openai-chat', models: [{ id: 'new-model', name: 'New', contextWindow: 64000, defaultEnabled: false }] },
    } });
    expect(provider.models[agent]?.[0]).toMatchObject({ api, contextWindow: 64000, defaultEnabled: false, route: { baseUrl: target } });
  });
  it.each(['claude-code', 'codex', 'pi'] as const)('repairs old OpenCode Go Chat imports for %s without enabling compatibility', agent => {
    const provider = buildUserProvider({ id: 'go', name: 'Go', runtimes: {
      [agent]: { catalogPresetId: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', wireProtocol: 'openai-chat', models: [{ id: 'qwen3.7-plus', name: 'Qwen', api: 'openai-completions', defaultEnabled: false }] },
    } });
    expect(provider.models[agent]?.[0]).toMatchObject({ api: 'anthropic-messages', defaultEnabled: false, route: { baseUrl: 'https://opencode.ai/zen/go' } });
    expect(provider.models[agent]?.[0]?.contextWindow).toBeGreaterThan(0);
  });
  it('does not lend OpenCode Go model protocols to Zen or a user proxy', () => {
    const model = { id: 'minimax-m2.7', name: 'MiniMax', api: 'openai-completions' as const };
    expect(providerInterfaceModelRoute(model, 'pi', 'opencode', 'https://opencode.ai/zen/v1').api).toBe('openai-completions');
    expect(providerInterfaceModelRoute(model, 'pi', 'opencode-go', 'https://proxy.example/v1')).toBe(model);
    expect(providerInterfaceModelRoute(model, 'pi', 'opencode-go', 'https://opencode.ai/zen/v1')).toBe(model);
  });
});


describe('protocol and endpoint repair', () => {
  it.each(['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'])('pairs the recommended Google %s API and URL for every harness', id => {
    const preset = BUNDLED_CATALOG.presets!.find(p => p.id === 'google-gemini-api')!;
    const provider = buildUserProvider({ id: 'google-test', name: 'Google', runtimes:
      Object.fromEntries(Object.entries(preset.runtimes).map(([agent, rt]) => [agent, {
        ...rt, catalogPresetId: preset.id, models: [{ id, name: id }],
      }])) }, { presets: [preset] });
    for (const agent of provider.agents) {
      const model = provider.models[agent]![0];
      expect(model).toMatchObject({ api: 'google-generative-ai', defaultEnabled: agent === 'pi',
        route: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', wireProtocol: 'google-generative-ai' } });
      expect(model.userModelConfig).toEqual({ id, name: id });
      expect(model.contextWindow).toBeGreaterThan(0);
    }
  });
  it('repairs a stored official Google URL, but preserves custom hosts and request paths', () => {
    const model = { id: 'gemini', name: 'Gemini', api: 'google-generative-ai' as const,
      route: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', wireProtocol: 'openai-chat' as const } };
    expect(alignModelApiRoute(model, model.route.baseUrl).route).toEqual({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', wireProtocol: 'google-generative-ai' });
    const custom = { ...model, route: { ...model.route, baseUrl: 'https://proxy.example/v1beta/openai' } };
    expect(alignModelApiRoute(custom, custom.route.baseUrl).route?.baseUrl).toBe(custom.route.baseUrl);
    const path = { ...custom, route: { ...custom.route, requestPath: '/custom' } };
    expect(alignModelApiRoute(path, path.route.baseUrl)).toBe(path);
  });
  it('gives the LiteLLM Claude connection a Messages root before any model is selected', () => {
    expect(BUNDLED_CATALOG.presets!.find(p => p.id === 'litellm')!.runtimes['claude-code']).toMatchObject({
      baseUrl: 'http://127.0.0.1:4000', wireProtocol: 'anthropic-messages',
    });
  });
  it.each(['claude-code', 'codex', 'pi'] as const)('keeps unknown Google models on the explicitly configured API for %s', agent => {
    const p = buildUserProvider({ id: 'private', name: 'Private', runtimes: {
      [agent]: { baseUrl: 'https://private.example/v1beta', wireProtocol: 'google-generative-ai', models: [{ id: 'new-deployment', name: 'New' }] },
    } });
    expect(p.models[agent]![0].api).toBe('google-generative-ai');
    expect(p.models[agent]![0].defaultEnabled).toBe(agent === 'pi');
  });
});


it('keeps a preset API reference with a declared custom request path', () => {
  const preset = { id: 'custom-path', name: 'Custom path', runtimes: { codex: {
    baseUrl: 'https://gateway.example/v1', wireProtocol: 'openai-chat' as const, requestPath: '/tenant/infer',
    models: [{ id: 'model', name: 'Model', api: 'openai-completions' as const }],
  } } };
  const raw = { id: 'account', name: 'Account', runtimes: { codex: {
    ...preset.runtimes.codex, catalogPresetId: preset.id, models: [{ id: 'model', name: 'Model' }],
  } } };
  const provider = buildUserProvider(raw, { presets: [preset] });
  expect(provider.models.codex![0].api).toBe('openai-completions');
  expect(provider.models.codex![0].route).toBeUndefined();
  expect(provider.models.codex![0].userModelConfig).toEqual(raw.runtimes.codex.models[0]);
  expect(provider.routing.codex!.requestPath).toBe('/tenant/infer');
});

// Tier: unit. Production import/projection must follow a new directory revision
// without materializing automatic choices into saved API overrides.
describe('V6 remote interface bindings', () => {
  function connection(model: Record<string, unknown> = {}) {
    return { id: 'kimi-v6', name: 'Kimi', runtimes: { codex: {
      catalogPresetId: 'moonshot-kimi-code', baseUrl: 'https://api.kimi.com/coding/v1',
      wireProtocol: 'openai-chat' as const, models: [{ id: 'k3.1-pro', name: 'K3.1', ...model }],
    } } };
  }
  it('follows new defaults, keeps explicit selections and preserves the Coding limit', () => {
    const registry = structuredClone(BUNDLED_CATALOG.modelRegistry!);
    const options = { modelRegistry: registry, presets: BUNDLED_CATALOG.presets };
    const automatic = buildUserProvider(connection(), options).models.codex![0];
    expect(automatic).toMatchObject({ api: 'openai-responses', contextWindow: 262144, maxOutput: 262144 });
    expect(automatic.availableInterfaces).toHaveLength(3);
    expect(automatic.userModelConfig).not.toHaveProperty('api');
    const route = registry.models.flatMap(e => e.routes).find(r => r.providerId === 'moonshot-kimi-code' && r.modelId === 'k3.1-pro')!;
    route.preferredInterfaces!.codex = ['moonshot-kimi-code-anthropic-messages'];
    expect(buildUserProvider(connection(), options).models.codex![0].api).toBe('anthropic-messages');
    expect(buildUserProvider(connection({ interfaceId: 'moonshot-kimi-code-openai-completions' }), options).models.codex![0].api).toBe('openai-completions');
    expect(buildUserProvider(connection({ route: { baseUrl: 'https://api.kimi.com/coding/v1', wireProtocol: 'openai-chat' } }), options).models.codex![0].api).toBe('openai-completions');
    expect(buildUserProvider(connection({ api: 'openai-completions', contextWindow: 64000 }), options).models.codex![0])
      .toMatchObject({ api: 'openai-completions', contextWindow: 64000 });
  });
  it('excludes unknown required behavior and keeps another supported binding', () => {
    const registry = structuredClone(BUNDLED_CATALOG.modelRegistry!);
    registry.interfaceProfiles!.find(p => p.id === 'moonshot-kimi-code-openai-responses')!.requires = ['future-adapter-v99'];
    const model = buildUserProvider(connection(), { modelRegistry: registry, presets: BUNDLED_CATALOG.presets }).models.codex![0];
    expect(model.api).toBe('openai-completions');
    expect(model.availableInterfaces?.some(p => p.api === 'openai-responses')).toBe(false);
  });
  it('does not redirect a custom endpoint or request path using an official profile', () => {
    const input = connection();
    input.runtimes.codex.baseUrl = 'https://my-relay.example/coding/v1';
    expect(buildUserProvider(input, { modelRegistry: BUNDLED_CATALOG.modelRegistry }).models.codex![0].selectedInterface).toBeUndefined();
    const custom = connection({ route: { baseUrl: 'https://api.kimi.com/coding/v1', wireProtocol: 'openai-chat', requestPath: '/private/chat' } });
    expect(buildUserProvider(custom).models.codex![0].route?.requestPath).toBe('/private/chat');
  });
});
