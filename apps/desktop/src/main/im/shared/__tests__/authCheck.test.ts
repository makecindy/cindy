import { describe, expect, it, vi } from 'vitest';

import type { AgentKind } from '@cindy/maker-core';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';

import { ui as discordUi } from '../../discord/uiText';
import { ui as feishuUi } from '../../feishu/uiText';
import {
  checkImRouteAuth,
  checkImRouteAuthDetailed,
  hasAuthForImRoute,
  resolveEffectiveProvider,
  type ImAuthCheckDeps,
} from '../authCheck';

/** A conversation on a built-in engine, the shape model providers route. */
type AuthRow = Parameters<typeof resolveEffectiveProvider>[0];

function deps(overrides: Partial<ImAuthCheckDeps> = {}): ImAuthCheckDeps {
  return {
    readXdGatewayApiKey: vi.fn(() => null),
    hasCustomProviderKey: vi.fn(() => false),
    getAgentAuthState: vi.fn(async () => ({ authenticated: false })),
    listProviders: vi.fn(async () => []),
    warn: vi.fn(),
    ...overrides,
  };
}

function row(overrides: Partial<AuthRow> = {}): AuthRow {
  return {
    agentKind: 'claude-code',
    model: 'claude-opus-4-7',
    providerId: null,
    ...overrides,
  };
}

function model(id: string): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200000,
    efforts: ['high'],
    defaultEffort: 'high',
  };
}

function provider(
  overrides: Partial<ProviderView> & {
    id: string;
    strategy: NonNullable<ProviderView['routing'][AgentKind]>['authStrategy'];
    modelId?: string;
    agentKind?: AgentKind;
  },
): ProviderView {
  const agentKind = overrides.agentKind ?? 'claude-code';
  const modelId = overrides.modelId ?? 'claude-opus-4-7';
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    source: overrides.source ?? 'builtin',
    connected: overrides.connected ?? true,
    agents: overrides.agents ?? [agentKind],
    auth: overrides.auth ?? { method: 'apiKey' },
    routing: {
      [agentKind]: {
        upstream: 'https://example.test',
        authStrategy: overrides.strategy,
      },
      ...overrides.routing,
    },
    models: {
      [agentKind]: [model(modelId)],
      ...overrides.models,
    },
  };
}

describe('checkImRouteAuth', () => {
  it('checks the shared provider without requiring this computer to have its credentials', async () => {
    const remote = provider({ id: 'openai', strategy: 'oauth-passthrough' });
    const d = deps({ checkRemoteRoute: vi.fn(async () => ({ provider: remote })) });
    await expect(checkImRouteAuthDetailed(row({ providerId: 'openai', agentDeviceId: 'share:a' }), undefined, d))
      .resolves.toMatchObject({ ok: true, providerId: 'openai', providerLabel: 'openai' });
    expect(d.listProviders).not.toHaveBeenCalled();
    expect(d.getAgentAuthState).not.toHaveBeenCalled();
  });
  it('does not use a local credential when the sharing is unavailable', async () => {
    const d = deps({ readXdGatewayApiKey: () => 'local-key', checkRemoteRoute: vi.fn(async () => { throw new Error('paused'); }) });
    await expect(checkImRouteAuth(row({ providerId: 'xd', agentDeviceId: 'share:a' }), undefined, d))
      .resolves.toMatchObject({ ok: false, missing: 'provider-disconnected' });
    expect(d.listProviders).not.toHaveBeenCalled();
  });
  it.each([
    ['Discord', discordUi],
    ['Feishu', feishuUi],
  ])('does not recommend /new for an attached %s session', (_channel, ui) => {
    const message = ui.agent.authMissing?.({
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'custom-openai',
      providerLabel: 'My OpenAI',
      missing: 'provider-key',
      attached: true,
    });

    expect(message).toContain('Settings');
    expect(message).not.toContain('/new');
  });

  it('uses the selected user-provider route for codex/ models without an XD gateway key', async () => {
    const providerSnapshot = [
      provider({
        id: 'custom-litellm',
        source: 'user',
        strategy: 'api-key-header',
        agentKind: 'codex',
        modelId: 'codex/foo',
        routing: {
          codex: {
            upstream: 'https://litellm.example.test',
            authStrategy: 'api-key-header',
            headerOverride: { authorization: 'Bearer configured-by-provider' },
          },
        },
        models: { codex: [model('codex/foo')] },
      }),
    ];

    // 自定义供应商的 host 注入鉴权不应回落到 codex/ 的 XD 网关 key gate。
    await expect(
      checkImRouteAuth(
        row({ agentKind: 'codex', model: 'codex/foo', providerId: 'custom-litellm' }),
        providerSnapshot,
        deps(),
      ),
    ).resolves.toEqual({ ok: true, missing: null });
  });

  it('reports gateway-key for an implicit codex/ route without an XD gateway key', async () => {
    const providerSnapshot = [
      provider({ id: 'xd', strategy: 'gateway-key', agentKind: 'codex', modelId: 'codex/foo' }),
    ];

    await expect(
      checkImRouteAuth(row({ agentKind: 'codex', model: 'codex/foo' }), providerSnapshot, deps()),
    ).resolves.toEqual({ ok: false, missing: 'gateway-key' });
  });

  it('reports gateway-key when a gateway route has no XD key', async () => {
    const providerSnapshot = [provider({ id: 'xd', strategy: 'gateway-key' })];

    await expect(checkImRouteAuth(row(), providerSnapshot, deps())).resolves.toEqual({
      ok: false,
      missing: 'gateway-key',
    });
  });

  it('keeps the persisted provider context for an explainable failure', async () => {
    const providerSnapshot = [
      provider({ id: 'custom-anthropic', name: '我的 Anthropic', strategy: 'api-key-header' }),
    ];

    await expect(
      checkImRouteAuthDetailed(row({ providerId: 'custom-anthropic' }), providerSnapshot, deps()),
    ).resolves.toEqual({
      ok: false,
      missing: 'provider-key',
      providerId: 'custom-anthropic',
      providerLabel: '我的 Anthropic',
    });
  });

  it('reports provider-disconnected when an oauth provider is not connected', async () => {
    const providerSnapshot = [
      provider({ id: 'anthropic', strategy: 'oauth-passthrough', connected: false }),
    ];

    await expect(
      checkImRouteAuth(row({ providerId: 'anthropic' }), providerSnapshot, deps()),
    ).resolves.toEqual({
      ok: false,
      missing: 'provider-disconnected',
    });
  });

  it('passes provider-oauth-header routes when the provider is connected', async () => {
    const providerSnapshot = [
      provider({ id: 'xai', strategy: 'provider-oauth-header', connected: true }),
    ];

    await expect(
      checkImRouteAuth(row({ providerId: 'xai' }), providerSnapshot, deps()),
    ).resolves.toEqual({
      ok: true,
      missing: null,
    });
  });

  it('passes oauth-token routes when the provider is connected（回归：无 XD key/agent OAuth 环境不误判未鉴权）', async () => {
    const providerSnapshot = [
      provider({
        id: 'acme',
        source: 'user',
        strategy: 'oauth-token',
        connected: true,
        modelId: 'acme-1',
      }),
    ];

    // deps 缺省无 XD key、agent OAuth 未登录——oauth-token 由 host 注入 token，不应落 fallback 被阻断。
    await expect(
      checkImRouteAuth(row({ providerId: 'acme', model: 'acme-1' }), providerSnapshot, deps()),
    ).resolves.toEqual({
      ok: true,
      missing: null,
    });
  });

  it('reports provider-disconnected for oauth-token routes when the provider is not connected', async () => {
    const providerSnapshot = [
      provider({
        id: 'acme',
        source: 'user',
        strategy: 'oauth-token',
        connected: false,
        modelId: 'acme-1',
      }),
    ];

    await expect(
      checkImRouteAuth(row({ providerId: 'acme', model: 'acme-1' }), providerSnapshot, deps()),
    ).resolves.toEqual({
      ok: false,
      missing: 'provider-disconnected',
    });
  });

  it('allows an explicitly connected no-auth proxy without API key material', async () => {
    const providerSnapshot = [
      provider({ id: 'local-proxy', strategy: 'none', connected: true }),
    ];

    await expect(
      checkImRouteAuth(row({ providerId: 'local-proxy' }), providerSnapshot, deps()),
    ).resolves.toEqual({
      ok: true,
      missing: null,
    });
  });

  it('reports provider-key when an api-key provider is connected without key material', async () => {
    const providerSnapshot = [
      provider({ id: 'custom-anthropic', strategy: 'api-key-header', connected: true }),
    ];

    await expect(
      checkImRouteAuth(row({ providerId: 'custom-anthropic' }), providerSnapshot, deps()),
    ).resolves.toEqual({
      ok: false,
      missing: 'provider-key',
    });
  });

  it('reports agent-oauth for claude models without XD key or authenticated agent OAuth', async () => {
    await expect(checkImRouteAuth(row(), [], deps())).resolves.toEqual({
      ok: false,
      missing: 'agent-oauth',
    });
  });

  it('passes claude models without XD key when agent OAuth is authenticated', async () => {
    await expect(
      checkImRouteAuth(
        row(),
        [],
        deps({ getAgentAuthState: vi.fn(async () => ({ authenticated: true })) }),
      ),
    ).resolves.toEqual({
      ok: true,
      missing: null,
    });
  });

  it('passes gateway-key routes when XD key is present', async () => {
    const providerSnapshot = [provider({ id: 'xd', strategy: 'gateway-key' })];
    const authDeps = deps({ readXdGatewayApiKey: vi.fn(() => 'xd-key') });

    await expect(checkImRouteAuth(row(), providerSnapshot, authDeps)).resolves.toEqual({
      ok: true,
      missing: null,
    });
    await expect(hasAuthForImRoute(row(), providerSnapshot, authDeps)).resolves.toBe(true);
  });
});

/**
 * Plugin-engine conversations (docs/plans/acp-plugin-bridge.md「IM 渠道」): the engine signs in with
 * its own accounts, so the check is the desktop admission (engine offered here now), not provider keys.
 * Minimal failing input: an 'acp' row that the old code routed as Claude through provider lookup.
 */
describe('checkImRouteAuth for a plugin-engine conversation', () => {
  const engineRow = (overrides: Partial<Parameters<typeof checkImRouteAuth>[0]> = {}) =>
    ({ ...row(), agentKind: 'acp' as const, model: 'default', providerId: 'acp-plugin:dsh-1:dsh', ...overrides });

  it('passes an engine this computer offers, named in the route, without provider or agent sign-in checks', async () => {
    const checkPluginEngine = vi.fn(() => ({ engineName: 'DSH', unavailable: null }));
    const d = deps({ checkPluginEngine });
    await expect(checkImRouteAuthDetailed(engineRow(), undefined, d))
      .resolves.toEqual({ ok: true, missing: null, providerId: 'acp-plugin:dsh-1:dsh', providerLabel: 'DSH' });
    expect(checkPluginEngine).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'acp-plugin:dsh-1:dsh', model: 'default' }));
    expect(d.listProviders).not.toHaveBeenCalled();
    expect(d.getAgentAuthState).not.toHaveBeenCalled();
  });

  it('names the unavailable engine and points to the provider settings that list it', async () => {
    const d = deps({ checkPluginEngine: () => ({ engineName: 'DSH', unavailable: 'DSH 已在「设置 → 模型供应商」中停用。' }) });
    const status = await checkImRouteAuthDetailed(engineRow(), undefined, d);
    expect(status).toEqual({ ok: false, missing: 'provider-disconnected', providerId: 'acp-plugin:dsh-1:dsh', providerLabel: 'DSH' });
    const message = feishuUi.agent.authMissing?.({ ...status, agentKind: 'acp', model: 'default', attached: true });
    expect(message).toContain('DSH');
    expect(message).not.toContain('acp-plugin:');
    // Fails closed when the host cannot check the engine at all.
    await expect(checkImRouteAuth(engineRow(), undefined, deps())).resolves.toEqual({ ok: false, missing: 'provider-disconnected' });
  });

  it('leaves an engine on another computer to that computer, which refuses at start', async () => {
    const checkPluginEngine = vi.fn(() => ({ engineName: null, unavailable: 'not installed here' }));
    const checkRemoteRoute = vi.fn();
    await expect(checkImRouteAuth(engineRow({ agentDeviceId: 'device-2' }), undefined, deps({ checkPluginEngine, checkRemoteRoute })))
      .resolves.toMatchObject({ ok: true });
    expect(checkPluginEngine).not.toHaveBeenCalled();
    expect(checkRemoteRoute).not.toHaveBeenCalled();
  });
});

describe('resolveEffectiveProvider', () => {
  // issue #882 第 3 点(2026-07 review):同一 model id 在不同来源上 mode 不一致时,
  // 鉴权解析不能只看"这个来源提供这个 id",还要看这个来源上这个 id 是不是聊天模型
  // ——否则会去校验一个非聊天来源的凭证,校验"通过"也不代表这个任务真能发聊天请求。
  it('rejects an explicit providerId whose copy of the model is non-chat, even though the id exists there', () => {
    const nonChat = provider({
      id: 'xd',
      strategy: 'gateway-key',
      models: { 'claude-code': [{ ...model('shared-id'), efforts: [] as const, defaultEffort: null, mode: 'image_generation' }] },
    });
    const chat = provider({
      id: 'openai',
      strategy: 'oauth-passthrough',
      models: { 'claude-code': [{ ...model('shared-id'), efforts: [] as const, defaultEffort: null, mode: 'chat' }] },
    });

    expect(
      resolveEffectiveProvider(
        row({ model: 'shared-id', providerId: 'xd' }),
        [nonChat, chat],
      ),
    ).toEqual({ kind: 'explicit-invalid' });
  });

  it('falls back to the chat-eligible source when no explicit providerId is given, skipping a non-chat copy of the same id', () => {
    const nonChat = provider({
      id: 'xd',
      strategy: 'gateway-key',
      models: { 'claude-code': [{ ...model('shared-id'), efforts: [] as const, defaultEffort: null, mode: 'image_generation' }] },
    });
    const chat = provider({
      id: 'openai',
      strategy: 'oauth-passthrough',
      models: { 'claude-code': [{ ...model('shared-id'), efforts: [] as const, defaultEffort: null, mode: 'chat' }] },
    });

    const resolution = resolveEffectiveProvider(
      row({ model: 'shared-id', providerId: null }),
      [nonChat, chat],
    );
    expect(resolution.kind).toBe('provider');
    expect(resolution.kind === 'provider' ? resolution.provider.id : null).toBe('openai');
  });
});
