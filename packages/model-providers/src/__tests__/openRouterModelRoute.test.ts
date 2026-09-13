import { providerInterfaceModelRoute } from '../providerInterfaceRoutes.js';
import { describe, it, expect } from 'vitest';
import { BUNDLED_CATALOG } from '../catalog.js';
import { buildUserProvider } from '../user-provider.js';

describe('OpenRouter import protocol ownership', () => {
  it('projects old imported Pi catalog routes to native harness APIs without changing membership or choices', () => {
    const runtimes = Object.fromEntries(['claude-code', 'codex', 'pi'].map(agent => [agent, {
      catalogPresetId: 'openrouter', baseUrl: agent === 'claude-code' ? 'https://openrouter.ai/api' : 'https://openrouter.ai/api/v1',
      ...(agent === 'pi' ? { wireProtocol: 'openai-chat' as const } : {}),
      models: [{ id: 'google/gemini-test', name: 'Test', defaultEnabled: false, api: 'openai-completions' as const,
        route: { baseUrl: 'https://openrouter.ai/api/v1', wireProtocol: 'openai-chat' as const } }],
    }]));
    const provider = buildUserProvider({ id: 'openrouter-imported', name: 'OpenRouter', runtimes });
    for (const [agent, api] of [['claude-code','anthropic-messages'], ['codex','openai-responses'], ['pi','openai-completions']] as const) {
      expect(provider.models[agent]?.[0]).toMatchObject({ id: 'google/gemini-test', api, defaultEnabled: false });
    }
  });
  it('all generated OpenRouter models retain each harness native protocol', () => {
    const preset = BUNDLED_CATALOG.presets!.find(p => p.id === 'openrouter')!;
    for (const [agent, api] of [['claude-code','anthropic-messages'], ['codex','openai-responses'], ['pi','openai-completions']] as const) {
      const models = preset.runtimes[agent]!.models;
      expect(models.length).toBeGreaterThan(10);
      for (const model of models) {
        if (agent === 'pi') expect(['openai-completions', 'anthropic-messages', 'openai-responses']).toContain(model.api ?? model.piApi ?? 'openai-completions');
        else expect(model.api ?? api, `${agent}/${model.id}`).toBe(api);
      }
    }
  });
});

it('does not rewrite manual hosts, custom paths, or explicit protocol choices', () => {
  for (const [preset, base, model] of [
    ['openrouter', 'https://proxy.example/v1', { id: 'model', name: 'Model', api: 'openai-completions' as const }],
    ['openrouter', 'https://openrouter.ai/api/v1', { id: 'model', name: 'Model', api: 'openai-completions' as const, route: { baseUrl: 'https://openrouter.ai/api/v1', wireProtocol: 'openai-chat' as const, requestPath: '/custom' } }],
    [undefined, 'https://openrouter.ai/api/v1', { id: 'model', name: 'Model', api: 'openai-completions' as const }],
    ['openrouter', 'https://openrouter.ai/api/v1', { id: 'model', name: 'Model', api: 'anthropic-messages' as const }],
  ] as const) expect(providerInterfaceModelRoute(model, 'codex', preset, base)).toBe(model);
});
