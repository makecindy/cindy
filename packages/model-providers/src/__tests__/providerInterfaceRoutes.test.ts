import { BUNDLED_CATALOG } from '../../test/catalog-fixture.js';
import { describe, expect, it } from 'vitest';
import { buildUserProvider } from '../user-provider.js';
import { alignModelApiRoute, providerInterfaceModelRoute } from '../providerInterfaceRoutes.js';


describe('documented supplier interfaces', () => {
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
