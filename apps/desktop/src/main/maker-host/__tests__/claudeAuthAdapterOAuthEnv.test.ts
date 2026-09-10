/**
 * claudeAuthAdapterOAuthEnv.test.ts —— DesktopClaudeAuthAdapter.getAuthEnv 订阅分支回归。
 *
 * 固化 2026-07-03 事故的修复契约:连了 Claude.ai 订阅时,getAuthEnv 必须把订阅
 * access token(及 scopes / subscriptionType / rateLimitTier)经 env 显式递给 cc 子进程
 * —— cc >= 2.1.198 在 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST 下不再自读系统凭证库,
 * 「不注入任何鉴权 env」的旧行为会让所有订阅会话毫秒级 "Not logged in"。
 * 同时守住:订阅分支绝不注入 ANTHROPIC_API_KEY(与 OAuth 共存触发 cc shouldDisableAuth);
 * gateway-key 模式不受影响、不带订阅 token。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClaudeEnv } from '../../../../../../packages/maker-core/src/agents/claude-code/env-builder.js';

const h = vi.hoisted(() => ({
  hasOAuth: true,
  oauth: null as Record<string, unknown> | null,
  gatewayKey: 'sk-xd-gateway' as string | null,
  cleared: 0,
  revoked: false,
  revocationFails: false,
  refresherInvalidated: 0,
  invalidGrantHandler: null as ((digest: string) => void) | null,
  rejectedDigest: undefined as string | undefined,
  /** getValidClaudeAiOAuth 的可注入延迟(测回调超时用)。 */
  refreshDelayMs: 0,
  lastRefreshOpts: null as { staleToken?: string; forceRefresh?: boolean } | null,
  encryptionAvailable: true,
  proxyReady: true,
  canUseGateway: true,
  accounts: new Map<string, Record<string, unknown> | null>(),
  refreshAccount: vi.fn(),
  retainPresentation: vi.fn(),
}));

vi.mock('../provider-presentation-store.js', () => ({
  retainInvalidatedProviderPresentation: h.retainPresentation,
  retainProviderPresentationAfterAuthChange: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/xdt-test-userdata-nonexistent',
    // ripgrep 探测已惰性化(issue #1956):runtime-configs import 期不再读
    // getAppPath / isPackaged,这里无需再补。
  },
  safeStorage: { isEncryptionAvailable: () => h.encryptionAvailable },
}));

vi.mock('@cindy/maker-core', () => ({}));

vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: h.canUseGateway }),
}));

vi.mock('../nativeProviderAuthBinding.js', async (original) => ({
  ...(await original<typeof import('../nativeProviderAuthBinding.js')>()),
  isNativeProviderAuthRevoked: () => h.revoked,
  unbindNativeProviderAuth: (_provider: string, opts?: { rejectedCredentialDigest?: string }) => {
    if (h.revocationFails) throw new Error('binding write failed');
    h.revoked = true;
    h.rejectedDigest = opts?.rejectedCredentialDigest;
  },
}));

vi.mock('../claude-credentials-store.js', () => ({
  hasClaudeAiOAuth: () => h.hasOAuth,
  clearClaudeAiOAuth: () => {
    h.cleared += 1;
  },
}));

vi.mock('../claude-oauth-refresh.js', () => ({
  getValidClaudeAiOAuth: async (opts?: { staleToken?: string }) => {
    h.lastRefreshOpts = opts ?? null;
    if (h.refreshDelayMs > 0) await new Promise((r) => setTimeout(r, h.refreshDelayMs));
    return h.oauth;
  },
  getClaudeAiOAuthForSpawn: () => h.oauth,
  invalidateClaudeOAuthRefresh: () => {
    h.refresherInvalidated += 1;
  },
  // disconnect = invalidate → clear(唯一断开入口,logout/IPC 都必须走它)
  disconnectClaudeAiOAuth: () => {
    h.refresherInvalidated += 1;
    h.revoked = true;
  },
  setClaudeOAuthInvalidGrantHandler: (handler: ((digest: string) => void) | null) => {
    h.invalidGrantHandler = handler;
  },
}));

vi.mock('../subscription-account-auth.js', () => ({
  subscriptionAccountKind: (id: string) => h.accounts.has(id) ? 'claude' : null,
  readClaudeAccountOAuth: (id: string) => h.accounts.get(id) ?? null,
  subscriptionAccountState: (id: string) => ({ authenticated: !!h.accounts.get(id), authSource: 'oauth' }),
  getValidClaudeAccountOAuth: (...args: unknown[]) => h.refreshAccount(...args),
}));

vi.mock('../../secrets/providerSecretStore.js', () => ({
  getProviderSecretStore: () => ({
    get: () => h.gatewayKey,
    remove: () => ({ success: true }),
  }),
}));

// getAuthEnv 前置的共享 skills 预热会碰真实文件系统 —— 剪断(与本测试无关)。
vi.mock('../shared-global-skills.js', () => ({
  prepareSharedGlobalSkillLinks: async () => ({ warnings: [] }),
  prepareSharedProjectSkillLinks: async () => ({ warnings: [] }),
}));

vi.mock('../anthropic-compat-proxy-host.js', () => ({
  isAnthropicCompatProxyHandleReady: () => h.proxyReady,
}));

describe('DesktopClaudeAuthAdapter.getAuthEnv — 订阅 OAuth env 注入', () => {
  beforeEach(() => {
    h.hasOAuth = true;
    h.oauth = {
      accessToken: 'at-live',
      refreshToken: 'rt-live',
      expiresAt: Date.now() + 3600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    };
    h.gatewayKey = 'sk-xd-gateway';
    h.cleared = 0;
    h.revoked = false;
    h.revocationFails = false;
    h.refresherInvalidated = 0;
    h.refreshDelayMs = 0;
    h.encryptionAvailable = true;
    h.proxyReady = true;
    h.canUseGateway = true;
    h.accounts.clear();
    h.refreshAccount.mockReset();
  });

  it('keeps the owner-scoped BYOK key readable when Cindy gateway access is disabled', async () => {
    h.canUseGateway = false;
    const { readClaudeApiKey, readOwnerScopedXdGatewayKey } = await import('../auth-adapters.js');

    expect(readClaudeApiKey()).toBeNull();
    expect(readOwnerScopedXdGatewayKey()).toBe('sk-xd-gateway');
  });

  async function makeAdapter() {
    const mod = await import('../auth-adapters.js');
    const adapter = new mod.DesktopClaudeAuthAdapter();
    // 测试环境无 electron app 生命周期,skills 预热已 mock 成 no-op。
    return adapter;
  }

  it('订阅模式:注入 CLAUDE_CODE_OAUTH_TOKEN 全家桶,且绝不带 ANTHROPIC_API_KEY', async () => {
    const adapter = await makeAdapter();
    const env = await adapter.getAuthEnv();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('at-live');
    expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBe('user:inference user:profile');
    expect(env.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBe('max');
    expect(env.CLAUDE_CODE_RATE_LIMIT_TIER).toBe('default_claude_max_20x');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('builds native OAuth environments for the selected independent accounts', async () => {
    h.hasOAuth = false;
    h.gatewayKey = null;
    const adapter = await makeAdapter();
    for (const providerId of ['anthropic-a', 'anthropic-b']) {
      h.accounts.set(providerId, { ...h.oauth, accessToken: `test-token-${providerId}` });
      await expect(adapter.getState({ credentialMode: 'provider-oauth', providerId })).resolves.toMatchObject({
        authenticated: true, authSource: 'oauth',
      });
      const env = await buildClaudeEnv(adapter, { endpoint: 'http://127.0.0.1:1' }, {
        credentialMode: 'provider-oauth', sessionProviderId: providerId,
      });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(`test-token-${providerId}`);
      expect(env.CINDY_CLAUDE_ACCOUNT_PROVIDER_ID).toBe(providerId);
      expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBe('user:inference user:profile');
      expect(env.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBe('max');
      expect(env.CLAUDE_CODE_RATE_LIMIT_TIER).toBe('default_claude_max_20x');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    }
    h.refreshAccount.mockResolvedValue({ accessToken: 'test-refreshed-a' });
    await expect(adapter.getFreshSubscriptionToken('test-token-anthropic-a', 'anthropic-a')).resolves.toBe('test-refreshed-a');
    expect(h.refreshAccount).toHaveBeenCalledWith('anthropic-a', {
      forceRefresh: true, staleToken: 'test-token-anthropic-a',
    });
  });

  it('keeps independent account startup closed when the proxy or account is unavailable', async () => {
    const providerId = 'anthropic-a';
    h.accounts.set(providerId, { accessToken: 'test-account-a' });
    const adapter = await makeAdapter();
    h.proxyReady = false;
    await expect(adapter.getState({ credentialMode: 'provider-oauth', providerId })).resolves.toEqual({
      authenticated: false, errorReason: 'proxy_not_ready',
    });
    h.proxyReady = true;
    h.accounts.set(providerId, null);
    await expect(adapter.getState({ credentialMode: 'provider-oauth', providerId })).resolves.toMatchObject({
      authenticated: false,
    });
    await expect(adapter.getAuthEnv({ credentialMode: 'provider-oauth', providerId })).rejects.toThrow('Claude account requires login');
  });

  it('订阅字段缺省时只注入 token 本体,不留空值 env', async () => {
    h.oauth = { accessToken: 'at-live' };
    const adapter = await makeAdapter();
    const env = await adapter.getAuthEnv();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('at-live');
    expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBeUndefined();
    expect(env.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBeUndefined();
    expect(env.CLAUDE_CODE_RATE_LIMIT_TIER).toBeUndefined();
  });

  it('凭证刷新链拿不到 token(如已彻底失效)→ 不注入任何鉴权 env(与旧失败面等价,不裸奔 API key)', async () => {
    h.oauth = null;
    const adapter = await makeAdapter();
    const env = await adapter.getAuthEnv();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('gateway-key 模式:只注入 ANTHROPIC_API_KEY,不带订阅 token(即便订阅在连)', async () => {
    const adapter = await makeAdapter();
    const env = await adapter.getAuthEnv({ credentialMode: 'gateway-key' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-xd-gateway');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('provider-oauth 模式:无网关 key / Claude OAuth 也可用,且只注入占位 key', async () => {
    h.hasOAuth = false;
    h.oauth = null;
    h.gatewayKey = null;
    const mod = await import('../auth-adapters.js');
    const adapter = new mod.DesktopClaudeAuthAdapter();

    await expect(adapter.getState({ credentialMode: 'provider-oauth' })).resolves.toMatchObject({
      authenticated: true,
    });
    await expect(adapter.getAuthEnv({ credentialMode: 'provider-oauth' })).resolves.toMatchObject({
      ANTHROPIC_API_KEY: mod.CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY,
    });
  });

  it('provider-oauth 模式在 loopback proxy 未就绪时保持 fail-closed', async () => {
    h.hasOAuth = false;
    h.gatewayKey = null;
    h.proxyReady = false;
    const adapter = await makeAdapter();

    await expect(adapter.getState({ credentialMode: 'provider-oauth' })).resolves.toEqual({
      authenticated: false,
      errorReason: 'proxy_not_ready',
    });
  });

  it('getFreshSubscriptionToken:透传刷新结果的 accessToken 与 staleToken 基线', async () => {
    const adapter = await makeAdapter();
    await expect(adapter.getFreshSubscriptionToken('at-failed')).resolves.toBe('at-live');
    expect(h.lastRefreshOpts).toMatchObject({ forceRefresh: true, staleToken: 'at-failed' });
    h.oauth = null;
    await expect(adapter.getFreshSubscriptionToken()).resolves.toBeNull();
  });

  it('getFreshSubscriptionToken:超过回调预算快速返回 null(cc 落磁盘兜底)', async () => {
    const mod = await import('../auth-adapters.js');
    // 刷新耗时 = 预算 + 3s → race 应在预算到点返回 null,而不是等刷新完成。
    h.refreshDelayMs = mod.CLAUDE_OAUTH_CALLBACK_TIMEOUT_MS + 3000;
    const adapter = new mod.DesktopClaudeAuthAdapter();
    vi.useFakeTimers();
    try {
      const pending = adapter.getFreshSubscriptionToken();
      await vi.advanceTimersByTimeAsync(mod.CLAUDE_OAUTH_CALLBACK_TIMEOUT_MS + 1);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidate preserves native credentials and retains the provider before broadcasting', async () => {
    const mod = await import('../auth-adapters.js');
    const adapter = new mod.DesktopClaudeAuthAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));
    await adapter.invalidate('claude_oauth_refresh_invalid_grant');
    expect(h.cleared).toBe(0);
    expect(h.revoked).toBe(true);
    expect(h.retainPresentation).toHaveBeenCalledWith('anthropic');
    expect(h.refresherInvalidated).toBe(1);
    expect(broadcasts).toEqual(['claude_oauth_refresh_invalid_grant']);
  });

  it('构造期接线 invalid_grant handler(刷新模块通知 → invalidate 链路可达)', async () => {
    await makeAdapter();
    expect(typeof h.invalidGrantHandler).toBe('function');
    h.invalidGrantHandler?.('a'.repeat(64));
    expect(h.rejectedDigest).toBe('a'.repeat(64));
    expect(h.cleared).toBe(0);
  });

  it('logout preserves native credentials and revokes Cindy access', async () => {
    const adapter = await makeAdapter();
    await adapter.logout();
    expect(h.cleared).toBe(0);
    expect(h.revoked).toBe(true);
    expect(h.refresherInvalidated).toBe(1);
  });

  it('still retains and broadcasts automatic invalidation when persistence fails', async () => {
    const adapter = await makeAdapter();
    const broadcast = vi.fn();
    adapter.setOnInvalidatedBroadcast(broadcast);
    h.revocationFails = true;
    h.invalidGrantHandler?.('c'.repeat(64));
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith('claude_oauth_refresh_invalid_grant'));
    expect(h.retainPresentation).toHaveBeenCalledWith('anthropic');
    expect(h.cleared).toBe(0);
  });
});
