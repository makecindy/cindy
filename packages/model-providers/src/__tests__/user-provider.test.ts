/**
 * buildUserProvider —— 用户自定义配置（per-runtime）→ 标准 Provider 的映射。
 *
 * 核心不变量：
 *   - source='user'、auth.method 与 access 元数据匹配；
 *   - 只为**已配置的 runtime** 生成 api-key-header 路由 + per-agent 模型清单（各自 baseUrl/models）；
 *   - **API key 绝不出现在产出的 Provider 里**（密钥在 host resolve 时按 (id,agent) 注入）；
 *   - 模型补保守默认（contextWindow / 无 effort / group=custom:<id> / defaultEnabled）。
 */

import { describe, it, expect } from 'vitest';

import {
  buildUserProvider,
  DEFAULT_CUSTOM_CONTEXT_WINDOW,
  LEGACY_XAI_CUSTOM_PROVIDER_RUNTIME_ID,
  storedCustomProviderId,
} from '../user-provider.js';
import type { CustomProviderConfig } from '../types.js';
import { BUNDLED_CATALOG } from '../catalog.js';

const codexOnly: CustomProviderConfig = {
  id: 'openrouter',
  name: 'OpenRouter',
  runtimes: {
    codex: {
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [
        { id: 'meta/llama-4-405b', name: 'Llama 4 405B' },
        { id: 'qwen/qwen3-max', name: 'Qwen3 Max' },
      ],
    },
  },
};

describe('buildUserProvider (per-runtime)', () => {
  it('projects a legacy custom xai row under a collision-free runtime id', () => {
    const provider = buildUserProvider({
      ...codexOnly,
      id: 'xai',
      name: 'My xAI-compatible endpoint',
    });
    expect(provider.id).toBe(LEGACY_XAI_CUSTOM_PROVIDER_RUNTIME_ID);
    expect(provider.routing.codex?.upstream).toBe('https://openrouter.ai/api/v1');
    expect(storedCustomProviderId(provider.id)).toBe('xai');
  });

  it('maps a single-runtime config to a standard user Provider', () => {
    const p = buildUserProvider(codexOnly);
    expect(p.id).toBe('openrouter');
    expect(p.name).toBe('OpenRouter');
    expect(p.source).toBe('user');
    expect(p.auth).toEqual({ method: 'apiKey' });
    expect(p.access).toEqual({ kind: 'api' });
    expect(p.agents).toEqual(['codex']);
    expect(p.routing['claude-code']).toBeUndefined();
    expect(p.models['claude-code']).toBeUndefined();
  });

  it('generates api-key-header routing with that runtime baseUrl, no key', () => {
    const p = buildUserProvider(codexOnly);
    expect(p.routing.codex).toEqual({
      upstream: 'https://openrouter.ai/api/v1',
      authStrategy: 'api-key-header',
    });
    expect(p.routing.codex?.headerOverride).toBeUndefined();
  });

  it('preserves an explicit Chat Completions protocol for Codex routing', () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: { ...codexOnly.runtimes.codex!, wireProtocol: 'openai-chat' },
      },
    });
    expect(p.routing.codex).toMatchObject({
      upstream: 'https://openrouter.ai/api/v1',
      authStrategy: 'api-key-header',
      wireProtocol: 'openai-chat',
    });
  });

  it('preserves an explicit Anthropic Messages protocol for Codex routing', () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: { ...codexOnly.runtimes.codex!, wireProtocol: 'anthropic-messages' },
      },
    });
    expect(p.routing.codex).toMatchObject({
      upstream: 'https://openrouter.ai/api/v1',
      authStrategy: 'api-key-header',
      wireProtocol: 'anthropic-messages',
    });
  });

  it('preserves a non-standard inference request path in routing', () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: {
          ...codexOnly.runtimes.codex!,
          requestPath: '/tenant/acme/v2/infer?stream=1',
        },
      },
    });
    expect(p.routing.codex?.requestPath).toBe('/tenant/acme/v2/infer?stream=1');
  });

  it('maps models per runtime with conservative default metadata', () => {
    const p = buildUserProvider(codexOnly);
    const models = p.models.codex ?? [];
    expect(models.map((m) => m.id)).toEqual(['meta/llama-4-405b', 'qwen/qwen3-max']);
    expect(models[0]).toMatchObject({
      id: 'meta/llama-4-405b',
      name: 'Llama 4 405B',
      contextWindow: DEFAULT_CUSTOM_CONTEXT_WINDOW,
      // codex runtime：参考内置默认 effort 档位（low/medium/high/xhigh，默认 high）。
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high',
      group: 'custom:openrouter',
      defaultEnabled: true,
    });
  });

  it('projects a model-specific protocol route into the provider catalog', () => {
    const provider = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: {
          ...codexOnly.runtimes.codex!,
          models: [
            {
              id: 'glm-5.3',
              name: 'GLM-5.3',
              route: {
                baseUrl: 'https://openrouter.ai/api/v1',
                wireProtocol: 'openai-responses',
              },
            },
          ],
        },
      },
    });

    expect(provider.models.codex?.[0]?.route).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      wireProtocol: 'openai-responses',
    });
  });

  it('inherits Registry efforts only for a unique route of the target agent', () => {
    const provider = buildUserProvider(
      {
        id: 'relay',
        name: 'Relay',
        runtimes: {
          codex: {
            baseUrl: 'https://relay.example/v1',
            models: [
              { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
              { id: 'chatgpt/gpt-5.6-sol', name: 'GPT-5.6-Sol ChatGPT' },
              { id: 'unregistered-model', name: 'Unregistered' },
            ],
          },
          'claude-code': {
            baseUrl: 'https://relay.example/anthropic',
            models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
          },
        },
      },
      { modelRegistry: BUNDLED_CATALOG.modelRegistry },
    );

    expect(provider.routing).toMatchObject({
      codex: { upstream: 'https://relay.example/v1' },
      'claude-code': { upstream: 'https://relay.example/anthropic' },
    });
    expect(provider.models.codex).toEqual([
      expect.objectContaining({
        id: 'gpt-5.6-sol',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultEffort: 'high',
      }),
      expect.objectContaining({
        id: 'chatgpt/gpt-5.6-sol',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultEffort: 'high',
      }),
      expect.objectContaining({
        id: 'unregistered-model',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
      }),
    ]);
    expect(provider.models['claude-code']?.[0]).toMatchObject({
      id: 'gpt-5.6-sol',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    });
  });

  it('falls back safely for ambiguous matches, missing target routes and invalid defaults', () => {
    const registry = structuredClone(BUNDLED_CATALOG.modelRegistry);
    if (!registry) throw new Error('missing bundled model registry');
    const baseEntry = registry.models.find((entry) => entry.id === 'openai/gpt-5.6-sol');
    if (!baseEntry) throw new Error('missing gpt-5.6-sol registry entry');
    baseEntry.perAgent = {
      ...baseEntry.perAgent,
      codex: { efforts: ['minimal', 'max'], defaultEffort: 'high' },
    };
    registry.models.push({
      ...structuredClone(baseEntry),
      id: 'alternate/gpt-5.6-sol',
    });

    const ambiguous = buildUserProvider(
      {
        id: 'ambiguous',
        name: 'Ambiguous',
        runtimes: {
          codex: {
            baseUrl: 'https://relay.example/v1',
            models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
          },
        },
      },
      { modelRegistry: registry },
    );
    expect(ambiguous.models.codex?.[0]).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high',
    });

    registry.models.pop();
    const invalidDefault = buildUserProvider(
      {
        id: 'unique',
        name: 'Unique',
        runtimes: {
          codex: {
            baseUrl: 'https://relay.example/v1',
            models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
          },
        },
      },
      { modelRegistry: registry },
    );
    expect(invalidDefault.models.codex?.[0]).toMatchObject({
      efforts: ['minimal', 'max'],
      defaultEffort: 'max',
    });

    const noTargetRoute = buildUserProvider(
      {
        id: 'wrong-agent',
        name: 'Wrong agent',
        runtimes: {
          codex: {
            baseUrl: 'https://relay.example/v1',
            models: [{ id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' }],
          },
        },
      },
      { modelRegistry: BUNDLED_CATALOG.modelRegistry },
    );
    expect(noTargetRoute.models.codex?.[0]).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high',
    });
  });

  it('respects an explicit hidden default for discovered models', () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: {
          ...codexOnly.runtimes.codex!,
          models: [{ id: 'discovered', name: 'Discovered', defaultEnabled: false }],
        },
      },
    });
    expect(p.models.codex?.[0].defaultEnabled).toBe(false);
  });

  it('uses explicit runtime model contextWindow and defaults only when absent', () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: {
          ...codexOnly.runtimes.codex!,
          models: [
            { id: 'long-context', name: 'Long Context', contextWindow: 1_000_000 },
            { id: 'default-context', name: 'Default Context' },
          ],
        },
      },
    });
    expect(p.models.codex?.map((m) => [m.id, m.contextWindow])).toEqual([
      ['long-context', 1_000_000],
      ['default-context', DEFAULT_CUSTOM_CONTEXT_WINDOW],
    ]);
    // 只有用户自己填的窗口算「已核实」,可以拿去收敛运行期上报值;走 200K 兜底的那条
    // 不标记 —— 否则真实 1M 的端点会被这个展示用默认值压到 200K。
    expect(p.models.codex?.map((m) => [m.id, m.contextWindowVerified])).toEqual([
      ['long-context', true],
      ['default-context', undefined],
    ]);
    // 显式配置打标、缺省物化不打标:编辑表单靠它区分「显式 200K」与「默认 200K」,
    // 不能靠与默认等值推断(显式覆盖必须在默认升级后原样保留)。
    expect(p.models.codex?.map((m) => [m.id, m.contextWindowExplicit ?? null])).toEqual([
      ['long-context', true],
      ['default-context', null],
    ]);
  });

  it('marks an explicit contextWindow equal to the current default as explicit', () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: {
          ...codexOnly.runtimes.codex!,
          models: [
            { id: 'pinned-default', name: 'Pinned', contextWindow: DEFAULT_CUSTOM_CONTEXT_WINDOW },
          ],
        },
      },
    });
    expect(p.models.codex?.[0]).toMatchObject({
      contextWindow: DEFAULT_CUSTOM_CONTEXT_WINDOW,
      contextWindowVerified: true,
      contextWindowExplicit: true,
    });
  });

  it('attaches per-runtime custom headers (still no api key)', () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: { codex: { ...codexOnly.runtimes.codex!, headers: { 'X-Org': 'acme' } } },
    });
    expect(p.routing.codex?.headerOverride).toEqual({ 'X-Org': 'acme' });
    expect(p.routing.codex?.headerOverrideState).toBe('configured');
  });

  it('carries modelsUrl into routing (edit-form round-trip), absent when unset', () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: {
        codex: { ...codexOnly.runtimes.codex!, modelsUrl: 'https://openrouter.ai/api/v1/models' },
      },
    });
    expect(p.routing.codex?.modelsUrl).toBe('https://openrouter.ai/api/v1/models');
    expect(buildUserProvider(codexOnly).routing.codex?.modelsUrl).toBeUndefined();
  });

  it('does not infer subscription access from a generic OAuth login method', () => {
    const p = buildUserProvider({
      ...codexOnly,
      auth: {
        method: 'oauth',
        oauth: {
          authorizeUrl: 'https://openrouter.ai/oauth/authorize',
          tokenUrl: 'https://openrouter.ai/oauth/token',
          clientId: 'xdt-maker',
          scopes: 'models',
        },
      },
    });
    expect(p.auth).toMatchObject({ method: 'oauth' });
    expect(p.access).toBeUndefined();
    expect(p.routing.codex?.authStrategy).toBe('oauth-token');
  });

  it('maps an explicit no-auth proxy without falling back to API-key routing', () => {
    const p = buildUserProvider({
      ...codexOnly,
      id: 'litellm-proxy',
      auth: { method: 'none' },
      runtimes: {
        codex: {
          baseUrl: 'http://127.0.0.1:4000/v1',
          models: [{ id: 'local-model', name: 'Local model' }],
        },
      },
    });
    expect(p.auth).toEqual({ method: 'none' });
    expect(p.access).toEqual({ kind: 'api' });
    expect(p.routing.codex?.authStrategy).toBe('none');
    expect(p.routing.codex?.disabled).toBeUndefined();
  });

  it('keeps a legacy remote no-auth runtime editable but disables its route', () => {
    const p = buildUserProvider({
      ...codexOnly,
      id: 'legacy-remote-no-auth',
      auth: { method: 'none' },
      runtimes: {
        codex: {
          baseUrl: 'https://remote.example/v1',
          models: [{ id: 'legacy-model', name: 'Legacy model' }],
        },
      },
    });

    expect(p.agents).toEqual(['codex']);
    expect(p.routing.codex).toMatchObject({
      upstream: 'https://remote.example/v1',
      authStrategy: 'none',
      disabled: true,
    });
    expect(p.models.codex?.map((model) => model.id)).toEqual(['legacy-model']);
  });

  it('supports two runtimes with independent baseUrl + models, stable agent order', () => {
    const p = buildUserProvider({
      id: 'vendor',
      name: 'Vendor',
      runtimes: {
        codex: { baseUrl: 'https://vendor.ai/openai/v1', models: [{ id: 'gpt-x', name: 'GPT X' }] },
        'claude-code': { baseUrl: 'https://vendor.ai/anthropic', models: [{ id: 'claude-x', name: 'Claude X' }] },
      },
    });
    // 固定顺序 claude-code 先于 codex（与 AGENT_ORDER 一致）。
    expect(p.agents).toEqual(['claude-code', 'codex']);
    expect(p.routing['claude-code']?.upstream).toBe('https://vendor.ai/anthropic');
    expect(p.routing.codex?.upstream).toBe('https://vendor.ai/openai/v1');
    expect((p.models['claude-code'] ?? []).map((m) => m.id)).toEqual(['claude-x']);
    expect((p.models.codex ?? []).map((m) => m.id)).toEqual(['gpt-x']);
  });

  it('produces an inert Provider when runtimes is empty', () => {
    const p = buildUserProvider({ id: 'x', name: 'X', runtimes: {} });
    expect(p.agents).toEqual([]);
    expect(p.routing).toEqual({});
    expect(p.models).toEqual({});
  });

  it('keeps legacy Pi custom models non-reasoning until the capability is explicitly enabled', () => {
    const p = buildUserProvider({
      id: 'localollama',
      name: 'Local Ollama',
      auth: { method: 'none' },
      runtimes: {
        pi: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          wireProtocol: 'openai-chat',
          models: [{ id: 'qwen3:8b', name: 'Qwen3 8B', supportsImageInput: true }],
        },
      },
    });
    expect(p.agents).toEqual(['pi']);
    expect(p.auth).toEqual({ method: 'none' });
    expect((p.models.pi ?? []).map((m) => m.id)).toEqual(['qwen3:8b']);
    expect((p.models.pi ?? [])[0]?.efforts).toEqual([]);
    expect((p.models.pi ?? [])[0]?.defaultEffort).toBeNull();
    expect((p.models.pi ?? [])[0]?.group).toBe('custom:localollama');
    expect((p.models.pi ?? [])[0]?.supportsImageInput).toBe(true);
  });

  it('never infers Pi efforts from a same-named Registry model', () => {
    const p = buildUserProvider(
      {
        id: 'pi-relay',
        name: 'Pi Relay',
        runtimes: {
          pi: {
            baseUrl: 'https://relay.example/v1',
            models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
          },
        },
      },
      { modelRegistry: BUNDLED_CATALOG.modelRegistry },
    );
    expect(p.models.pi?.[0]).toMatchObject({ efforts: [], defaultEffort: null });
  });

  it('exports only the explicitly supported effort levels for a Pi reasoning model', () => {
    const p = buildUserProvider({
      id: 'reasoning-pi',
      name: 'Reasoning Pi',
      runtimes: {
        pi: {
          baseUrl: 'https://example.test/v1',
          wireProtocol: 'openai-responses',
          models: [
            {
              id: 'reasoner',
              name: 'Reasoner',
              reasoning: true,
              reasoningEfforts: ['low', 'high', 'xhigh'],
            },
          ],
        },
      },
    });

    expect(p.models.pi?.[0]).toMatchObject({
      efforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
    });
  });

  it.each([
    ['kimi', 'max'],
    ['deepseek', 'high'],
  ] as const)('uses the explicit %s Pi default reasoning effort', (id, expected) => {
    const p = buildUserProvider({
      id,
      name: id,
      runtimes: {
        pi: {
          baseUrl: `https://${id}.example/v1`,
          models: [{
            id: `${id}-model`, name: `${id} model`, reasoning: true,
            reasoningEfforts: ['low', 'high', 'max'], reasoningDefaultEffort: expected,
          }],
        },
      },
    });
    expect(p.models.pi?.[0]).toMatchObject({
      efforts: ['low', 'high', 'max'],
      defaultEffort: expected,
    });
  });

  it('orders pi after claude-code and codex (AGENT_ORDER)', () => {
    const p = buildUserProvider({
      id: 'multi',
      name: 'Multi',
      runtimes: {
        pi: { baseUrl: 'http://127.0.0.1:8000/v1', models: [{ id: 'pi-m', name: 'Pi M' }] },
        codex: { baseUrl: 'https://v.ai/openai/v1', models: [{ id: 'cx-m', name: 'Cx M' }] },
        'claude-code': { baseUrl: 'https://v.ai/anthropic', models: [{ id: 'cc-m', name: 'Cc M' }] },
      },
    });
    expect(p.agents).toEqual(['claude-code', 'codex', 'pi']);
  });
});
