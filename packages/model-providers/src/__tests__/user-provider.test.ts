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

import { buildUserProvider, DEFAULT_CUSTOM_CONTEXT_WINDOW } from '../user-provider.js';
import type { CustomProviderConfig } from '../types.js';

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
  });

  it('attaches per-runtime custom headers (still no api key)', () => {
    const p = buildUserProvider({
      ...codexOnly,
      runtimes: { codex: { ...codexOnly.runtimes.codex!, headers: { 'X-Org': 'acme' } } },
    });
    expect(p.routing.codex?.headerOverride).toEqual({ 'X-Org': 'acme' });
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
});
