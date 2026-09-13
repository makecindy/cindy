import { sourceProviderForPreset } from '../providerPresetIdentity.js';
import { describe, expect, it } from 'vitest';
import { appendPiProviderPresets } from '../piProviderPresets.js';
import { PROVIDER_MODEL_CATALOG } from '../providerModelCatalog.js';
import { buildUserProvider } from '../user-provider.js';
import { modelProtocolComparison } from '../modelProtocol.js';

const nativeApis: Record<string, Record<string, string>> = {
  openrouter: { 'claude-code': 'anthropic-messages', codex: 'openai-responses' },
  deepseek: { 'claude-code': 'anthropic-messages' },
  'moonshot-kimi-code': { codex: 'openai-completions' },
  'minimax-global': { codex: 'openai-responses' },
  'minimax-cn': { codex: 'openai-responses' },
  'moonshot-kimi-global': { 'claude-code': 'anthropic-messages' },
  'moonshot-kimi-cn': { 'claude-code': 'anthropic-messages' },
  'aliyun-bailian-token-plan-cn': { 'claude-code': 'anthropic-messages' },
  'vercel-ai-gateway': { codex: 'openai-responses' },
  'xiaomi-mimo-api-cn': { 'claude-code': 'anthropic-messages' },
  'xiaomi-mimo-token-plan-cn': { 'claude-code': 'anthropic-messages' },
  'zai-coding-plan-global': { 'claude-code': 'anthropic-messages' },
  'zhipu-coding-plan-cn': { 'claude-code': 'anthropic-messages' },
  baseten: { 'claude-code': 'anthropic-messages' },
  groq: { codex: 'openai-responses' },
  huggingface: { codex: 'openai-responses' },
  fireworks: { 'claude-code': 'anthropic-messages', codex: 'openai-responses' },
};
const generated = appendPiProviderPresets([]);
describe('Pi supplier connection import', () => {
  it('projects every generated model into all three harnesses with its actual API and metadata', () => {
    for (const preset of generated.filter(p => p.id !== 'nous')) {
      const provider = buildUserProvider({ id: preset.id, name: preset.name, runtimes: Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, { ...runtime, catalogPresetId: preset.id }])) }, { presets: generated });
      const source = sourceProviderForPreset(preset.id);
      const rows = PROVIDER_MODEL_CATALOG.providers[source].filter(row => preset.runtimes.pi!.models.some(model => model.id === row.id));
      for (const agent of ['claude-code', 'codex', 'pi'] as const) {
        expect(provider.models[agent], `${preset.id}/${agent}`).toHaveLength(rows.length);
        rows.forEach((row, index) => {
          expect(provider.models[agent]![index], `${preset.id}/${agent}/${row.id}`).toMatchObject({
            id: row.id, api: nativeApis[preset.id]?.[agent] ?? row.execution.pi.api,
            ...(agent === 'pi' ? { piApi: row.execution.pi.api } : {}),
            ...(row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow }),
            ...(row.maxOutput === undefined ? {} : { maxOutput: row.maxOutput }),
            ...(row.supportsImageInput === undefined ? {} : { supportsImageInput: row.supportsImageInput }),
          });
        });
      }
    }
  });
  it('keeps the model-specific routes of mixed-protocol suppliers', () => {
    const preset = generated.find(p => p.id === 'fireworks')!;
    const rows = PROVIDER_MODEL_CATALOG.providers.fireworks;
    for (const row of rows) {
      const model = preset.runtimes.pi!.models.find(m => m.id === row.id)!;
      expect(model.route?.baseUrl ?? preset.runtimes.pi!.baseUrl).toBe(row.upstream);
      expect(model.piApi).toBe(row.execution.pi.api);
    }
    expect(preset.runtimes['claude-code']!.models.every(m => rows.some(r => r.id === m.id && ['anthropic-messages', 'openai-completions', 'openai-responses'].includes(r.execution.pi.api)))).toBe(true);
  });
  it('does not turn the standard catalog into automatic recommendations', () => {
    expect(generated.length).toBeGreaterThan(10);
    for (const preset of generated) for (const runtime of Object.values(preset.runtimes)) {
      expect(runtime!.models.every(m => m.defaultEnabled === false)).toBe(true);
    }
  });
  it('preserves maintained connections and distinct regional subscriptions', () => {
    const original = generated.find(p => p.id === 'groq')!;
    expect(appendPiProviderPresets([original]).filter(p => p.id === 'groq')).toEqual([original]);
    const individual = generated.find(p => p.id === 'qwen-token-plan-individual')!;
    expect(individual.runtimes.pi!.baseUrl).toContain('ap-southeast-1');
    expect(individual.runtimes.pi!.models).toHaveLength(PROVIDER_MODEL_CATALOG.providers['qwen-token-plan-individual'].length);
  });
});

it('selects a direct Messages endpoint for a Messages model and carries its context limit', () => {
  const presets = appendPiProviderPresets([{ id: 'test-gateway', name: 'Test', runtimes: {
    'claude-code': { baseUrl: 'https://gateway.example/v1', wireProtocol: 'openai-chat', models: [{ id: 'model', name: 'Model', contextWindow: 32000 }] },
    codex: { baseUrl: 'https://gateway.example/v1', wireProtocol: 'openai-responses', models: [{ id: 'model', name: 'Model', contextWindow: 64000 }] },
    pi: { baseUrl: 'https://gateway.example/anthropic', wireProtocol: 'anthropic-messages', models: [{ id: 'model', name: 'Model', contextWindow: 128000 }] },
  } }]);
  const preset = presets.find(p => p.id === 'test-gateway')!;
  const provider = buildUserProvider({ id: 'test', name: 'Test', runtimes: preset.runtimes }, { modelRegistry: {
    schemaVersion: 5, updatedAt: '2026-09-13T00:00:00Z', models: [{
      id: 'model', name: 'Model', nativeApi: 'anthropic-messages',
      routes: [{ providerId: 'test', modelId: 'model', agents: ['claude-code', 'codex'] }],
    }],
  } });
  expect(provider.models['claude-code']![0]).toMatchObject({ api: 'anthropic-messages', contextWindow: 128000, defaultEnabled: true, route: { baseUrl: 'https://gateway.example/anthropic' } });
  expect(provider.models.codex![0]).toMatchObject({ contextWindow: 64000, defaultEnabled: false });
  expect(modelProtocolComparison(provider, { codex: provider.models.codex![0] }).forAgent('codex')).toMatchObject({
    outbound: 'openai-responses', mode: 'compatibility', localConversion: false,
  });
  expect(provider.models.pi![0].defaultEnabled).toBe(true);
});
