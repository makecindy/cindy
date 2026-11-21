import { sourceProviderForPreset } from '../providerPresetIdentity.js';
import { describe, expect, it } from 'vitest';
import { appendPiProviderPresets } from '../piProviderPresets.js';
import { PROVIDER_MODEL_CATALOG } from '../providerModelCatalog.js';
import { buildUserProvider, withConnectionDefaultHeaders } from '../user-provider.js';
import { modelProtocolComparison } from '../modelProtocol.js';

const nativeApis: Record<string, Record<string, string>> = {
  openrouter: { 'claude-code': 'anthropic-messages', codex: 'openai-responses' },
  deepseek: { 'claude-code': 'anthropic-messages', codex: 'openai-responses' },
  'moonshot-kimi-code': { codex: 'openai-responses' },
  'minimax-global': { codex: 'openai-responses' },
  'minimax-cn': { codex: 'openai-responses' },
  'moonshot-kimi-global': { 'claude-code': 'anthropic-messages' },
  'moonshot-kimi-cn': { 'claude-code': 'anthropic-messages' },
  'aliyun-bailian-token-plan-cn': { 'claude-code': 'anthropic-messages', codex: 'openai-responses' },
  'vercel-ai-gateway': { codex: 'openai-responses' },
  'xiaomi-mimo-api-cn': { 'claude-code': 'anthropic-messages', codex: 'openai-responses' },
  'xiaomi-mimo-token-plan-cn': { 'claude-code': 'anthropic-messages', codex: 'openai-responses' },
  'zai-coding-plan-global': { 'claude-code': 'anthropic-messages', codex: 'openai-responses' },
  'zhipu-coding-plan-cn': { 'claude-code': 'anthropic-messages', codex: 'openai-responses' },
  baseten: { 'claude-code': 'anthropic-messages' },
  groq: { codex: 'openai-responses' },
  huggingface: { codex: 'openai-responses' },
  fireworks: { 'claude-code': 'anthropic-messages', codex: 'openai-responses' },
};
const generated = appendPiProviderPresets([]);
describe('Pi supplier connection import', () => {
  it.each(generated.filter(p => p.id !== 'nous'))('projects $id models into all three harnesses with their actual API and metadata', preset => {
    const provider = buildUserProvider({ id: preset.id, name: preset.name, runtimes: Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, { ...runtime, catalogPresetId: preset.id }])) }, { presets: generated });
    const source = sourceProviderForPreset(preset.id);
    const rows = PROVIDER_MODEL_CATALOG.providers[source].filter(row => preset.runtimes.pi!.models.some(model => model.id === row.id));
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      expect(provider.models[agent], `${preset.id}/${agent}`).toHaveLength(rows.length);
      rows.forEach((row, index) => {
        // Cindy's Coding route declarations supersede the imported Pi source
        // limits; other supplier rows retain their original metadata contract.
        const kimiCode = preset.id === 'moonshot-kimi-code';
        const codingWindow = kimiCode && ['k3', 'k3-256k'].includes(row.id);
        // Kimi platform serves Responses for the K3 series only; K2 models keep Chat for Codex.
        const kimiPlatformK3 = preset.id.startsWith('moonshot-kimi-') && !kimiCode && agent === 'codex' && /^kimi-k3/.test(row.id);
        expect(provider.models[agent]![index], `${preset.id}/${agent}/${row.id}`).toMatchObject({
          id: row.id, api: kimiPlatformK3 ? 'openai-responses' : nativeApis[preset.id]?.[agent] ?? row.execution.pi.api,
          ...(agent === 'pi' ? { piApi: row.execution.pi.api } : {}),
          ...(row.contextWindow === undefined ? {} : { contextWindow: codingWindow ? 262144 : row.contextWindow }),
          ...(row.maxOutput === undefined ? {} : { maxOutput: codingWindow ? 262144 : row.maxOutput }),
          ...(row.supportsImageInput === undefined ? {} : { supportsImageInput: row.supportsImageInput }),
        });
      });
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
  // The gateway offers Responses: Codex uses it as is and is enabled (Chris 2026-10-30).
  expect(provider.models.codex![0]).toMatchObject({ contextWindow: 64000, defaultEnabled: true });
  expect(modelProtocolComparison(provider, { codex: provider.models.codex![0] }).forAgent('codex')).toMatchObject({
    outbound: 'openai-responses', mode: 'matching', localConversion: false,
  });
  expect(provider.models.pi![0].defaultEnabled).toBe(true);
});

// #11326: github-copilot 官方端点按第一跳请求头判定客户端身份,静态目录里每个模型都写了同一份。
// 动态发现合并进来的新模型没有这份资料,只能继承连接级默认值,否则三端请求都会被拒。
describe('github-copilot connection defaults', () => {
  it('sinks the IDE identity headers onto the connection so discovered models inherit them', () => {
    const copilot = appendPiProviderPresets([]).find(preset => preset.id === 'github-copilot');
    expect(copilot).toBeTruthy();
    const rowHeaders = PROVIDER_MODEL_CATALOG.providers['github-copilot'][0]!.execution.pi.headers!;
    expect(Object.keys(rowHeaders).length).toBeGreaterThan(0);
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      // 连接级值与目录里各模型写的完全一致,不是另抄的一份。
      expect(copilot!.runtimes[agent]?.headers, agent).toEqual(rowHeaders);
    }
  });

  it('backfills preset headers onto an existing connection that only carries catalogPresetId', () => {
    const preset = appendPiProviderPresets([]).find(entry => entry.id === 'github-copilot')!;
    const rowHeaders = PROVIDER_MODEL_CATALOG.providers['github-copilot'][0]!.execution.pi.headers!;
    // 存量连接:runtimes 是创建时快照的,只有 catalogPresetId 与 baseUrl,没有 headers。
    const provider = buildUserProvider({
      id: 'copilot-legacy', name: 'Copilot',
      runtimes: {
        pi: {
          baseUrl: preset.runtimes.pi!.baseUrl,
          catalogPresetId: 'github-copilot',
          models: [{ id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }],
        },
      },
    }, { presets: [preset] });
    expect(provider.routing.pi?.headerOverride).toEqual(rowHeaders);

    // 用户改过端点的连接不补:那条连接不再代表预设声明的上游。
    const custom = buildUserProvider({
      id: 'copilot-custom', name: 'Copilot custom',
      runtimes: {
        pi: {
          baseUrl: 'https://my-gateway.example.com/v1',
          catalogPresetId: 'github-copilot',
          models: [{ id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }],
        },
      },
    }, { presets: [preset] });
    expect(custom.routing.pi?.headerOverride).toBeUndefined();
  });

  it('backfills connection default headers on read for stored configs', () => {
    const rowHeaders = PROVIDER_MODEL_CATALOG.providers['github-copilot'][0]!.execution.pi.headers!;
    // 存量入库记录：只有 catalogPresetId，没有 headers。
    const stored = {
      id: 'copilot-legacy', name: 'Copilot',
      runtimes: { pi: { baseUrl: 'https://api.individual.githubcopilot.com', catalogPresetId: 'github-copilot', models: [] } },
    };
    const patched = withConnectionDefaultHeaders(stored as never);
    expect(patched.runtimes.pi?.headers).toEqual(rowHeaders);
    // 不写库、不改原对象。
    expect((stored.runtimes.pi as { headers?: unknown }).headers).toBeUndefined();

    // 已有 headers 的连接原样返回（同一个引用）。
    const own = { ...stored, runtimes: { pi: { ...stored.runtimes.pi, headers: { 'X-Own': '1' } } } };
    expect(withConnectionDefaultHeaders(own as never)).toBe(own);

    // 非预设连接不受影响。
    const other = { id: 'mine', name: 'Mine', runtimes: { pi: { baseUrl: 'https://example.com/v1', models: [] } } };
    expect(withConnectionDefaultHeaders(other as never)).toBe(other);
  });

  it('does not hand the Copilot identity to a custom gateway that kept catalogPresetId', () => {
    const relay = {
      id: 'copilot-relay', name: 'Relay',
      runtimes: { pi: { baseUrl: 'https://my-gateway.example.com/v1', catalogPresetId: 'github-copilot', models: [] } },
    };
    expect(withConnectionDefaultHeaders(relay as never)).toBe(relay);
  });

  it('recognises business / enterprise Copilot hosts, and keeps unreadable header state intact', () => {
    const rowHeaders = PROVIDER_MODEL_CATALOG.providers['github-copilot'][0]!.execution.pi.headers!;
    for (const host of ['api.githubcopilot.com', 'api.individual.githubcopilot.com',
      'api.business.githubcopilot.com', 'api.enterprise.githubcopilot.com']) {
      const stored = {
        id: `copilot-${host}`, name: 'Copilot',
        runtimes: { pi: { baseUrl: `https://${host}`, catalogPresetId: 'github-copilot', models: [] } },
      };
      const patched = withConnectionDefaultHeaders(stored as never) as {
        runtimes: { pi?: { headers?: Record<string, string> } };
      };
      expect(patched.runtimes.pi?.headers, host).toEqual(rowHeaders);
    }

    // 密文头读不出来时（headersState='unknown'）不补默认值：否则会把状态翻成 configured，
    // 用公开默认值掩盖一次真实的读取失败。
    const unreadable = {
      id: 'copilot-unknown', name: 'Copilot',
      runtimes: { pi: {
        baseUrl: 'https://api.individual.githubcopilot.com',
        catalogPresetId: 'github-copilot', headersState: 'unknown' as const, models: [],
      } },
    };
    expect(withConnectionDefaultHeaders(unreadable as never)).toBe(unreadable);
  });

  it('keeps runtime headers a caller already set', () => {
    const own = { 'X-Own-Header': '1' };
    const [preset] = appendPiProviderPresets([{
      id: 'github-copilot', name: 'GitHub Copilot', regionHint: 'global',
      runtimes: { pi: { baseUrl: 'https://api.individual.githubcopilot.com', headers: own, models: [] } },
    }]);
    expect(preset!.runtimes.pi?.headers).toEqual(own);
  });
});
