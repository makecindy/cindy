/**
 * claudeAuthAdapterOAuthEnv.test.ts —— DesktopClaudeAuthAdapter 的 Claude 订阅鉴权契约。
 *
 * Claude 订阅只经内置 Claude Code CLI 自己的登录使用(Anthropic 不允许第三方应用收集、
 * 存储或中转订阅凭证):
 *   - 订阅会话(oauth-bearer)的 getAuthEnv 不递任何凭证,只补系统代理 env;
 *   - 未指定来源时网关 key 优先(与未连订阅时一致),没有网关 key 才交给本机登录;
 *   - 独立 Claude 账号已停用,不递凭证;
 *   - gateway-key / provider-oauth 形态保持原样。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClaudeEnv } from '../../../../../../packages/maker-core/src/agents/claude-code/env-builder.js';

const h = vi.hoisted(() => ({
  nativeLogin: true,
  bound: true,
  gatewayKey: 'sk-xd-gateway' as string | null,
  revoked: false,
  removedGatewayKey: 0,
  disconnects: 0,
  networkEnv: {} as Record<string, string>,
  encryptionAvailable: true,
  proxyReady: true,
  canUseGateway: true,
  accounts: new Map<string, 'claude' | 'xai'>(),
  retainPresentation: vi.fn(),
  readLoginCalls: [] as Array<{ maxAgeMs?: number } | undefined>,
  legacyMigrations: 0,
}));

vi.mock('../provider-presentation-store.js', () => ({
  retainInvalidatedProviderPresentation: h.retainPresentation,
  retainProviderPresentationAfterAuthChange: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/xdt-test-userdata-nonexistent',
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
  isNativeProviderAuthBound: () => h.bound,
}));

vi.mock('../claude-native-auth.js', () => ({
  hasClaudeNativeLogin: () => h.nativeLogin,
  hasClaudeNativeLoginUnbound: () => h.nativeLogin,
}));

vi.mock('../claude-native-connection.js', () => ({
  readClaudeNativeLogin: async (opts?: { maxAgeMs?: number }) => {
    h.readLoginCalls.push(opts);
    return h.nativeLogin ? { loggedIn: true, email: 'user@example.com' } : null;
  },
  disconnectClaudeNativeLogin: async () => {
    h.disconnects += 1;
    h.revoked = true;
  },
}));

vi.mock('../claude-native-cli.js', () => ({
  claudeCliNetworkEnv: async () => ({ ...h.networkEnv }),
}));

vi.mock('../claude-legacy-config-migration.js', () => ({
  ensureLegacyClaudeConfigMigrated: async () => {
    h.legacyMigrations += 1;
  },
}));

vi.mock('../subscription-account-auth.js', () => ({
  subscriptionAccountKind: (id: string) => h.accounts.get(id) ?? null,
  subscriptionAccountState: (id: string) => h.accounts.get(id) === 'claude'
    ? { authenticated: false, errorReason: 'claude_account_retired', authSource: 'oauth' }
    : { authenticated: true, authSource: 'oauth' },
}));

vi.mock('../../secrets/providerSecretStore.js', () => ({
  getProviderSecretStore: () => ({
    get: () => h.gatewayKey,
    remove: () => {
      h.removedGatewayKey += 1;
      return { success: true };
    },
  }),
}));

// getAuthEnv 前置的共享 skills 预热会碰真实文件系统 —— 剪断(与本测试无关)。
vi.mock('../shared-global-skills.js', () => ({
  prepareSharedGlobalSkillLinks: async () => ({ warnings: [] }),
  prepareSharedProjectSkillLinks: async () => ({ warnings: [] }),
}));

vi.mock('../built-in-skills.js', () => ({
  prepareBuiltInSkills: async () => ({ descriptors: [], projectionSafe: true, warnings: [] }),
  refreshBuiltInSharedSkillLinks: async () => ({ warnings: [] }),
  refreshBuiltInClaudeSkillLinks: async () => ({ warnings: [] }),
  resolveBundledSystemSkillsRoot: () => '/tmp/cindy-bundled-system-skills',
}));

vi.mock('../anthropic-compat-proxy-host.js', () => ({
  isAnthropicCompatProxyHandleReady: () => h.proxyReady,
}));

const CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_SUBSCRIPTION_TYPE',
  'CLAUDE_CODE_RATE_LIMIT_TIER',
  'CINDY_CLAUDE_ACCOUNT_PROVIDER_ID',
] as const;

describe('DesktopClaudeAuthAdapter — Claude 订阅只经 CLI 自己的登录', () => {
  beforeEach(() => {
    h.nativeLogin = true;
    h.bound = true;
    h.gatewayKey = 'sk-xd-gateway';
    h.revoked = false;
    h.removedGatewayKey = 0;
    h.disconnects = 0;
    h.networkEnv = {};
    h.encryptionAvailable = true;
    h.proxyReady = true;
    h.canUseGateway = true;
    h.accounts.clear();
    h.retainPresentation.mockReset();
    h.readLoginCalls = [];
    h.legacyMigrations = 0;
  });

  it('keeps the owner-scoped BYOK key readable when Cindy gateway access is disabled', async () => {
    h.canUseGateway = false;
    const { readClaudeApiKey, readOwnerScopedXdGatewayKey } = await import('../auth-adapters.js');

    expect(readClaudeApiKey()).toBeNull();
    expect(readOwnerScopedXdGatewayKey()).toBe('sk-xd-gateway');
  });

  async function makeAdapter() {
    const mod = await import('../auth-adapters.js');
    return new mod.DesktopClaudeAuthAdapter();
  }

  it('订阅会话:已连接即授权,且 getAuthEnv 不递任何凭证(只补代理 env)', async () => {
    h.networkEnv = { HTTPS_PROXY: 'http://127.0.0.1:7890' };
    const adapter = await makeAdapter();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toEqual({
      authenticated: true, identity: 'Claude.ai · OAuth', authSource: 'oauth',
    });
    // 会话启动要结论:登录态缓存超过 60s 就重读 CLI。
    expect(h.readLoginCalls).toEqual([{ maxAgeMs: 60_000 }]);
    const env = await adapter.getAuthEnv({ credentialMode: 'oauth-bearer' });
    for (const key of CREDENTIAL_KEYS) expect(env[key]).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
  });

  it('各来源都用 CLI 默认配置目录:不设 CLAUDE_CONFIG_DIR,拉起前先过旧 dev 目录补拷', async () => {
    h.gatewayKey = null;
    const adapter = await makeAdapter();
    const optionsList = [
      { credentialMode: 'oauth-bearer' as const },
      { credentialMode: 'gateway-key' as const },
      { credentialMode: 'provider-oauth' as const },
      undefined,
    ];
    for (const options of optionsList) {
      const env = await adapter.getAuthEnv(options);
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    }
    expect(h.legacyMigrations).toBe(optionsList.length);
  });

  it('订阅会话:未连接(CLI 未登录或 Cindy 未获许可)→ no_oauth', async () => {
    h.nativeLogin = false;
    const adapter = await makeAdapter();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toEqual({
      authenticated: false, errorReason: 'no_oauth',
    });
  });

  it('订阅会话不依赖 loopback proxy(CLI 直连 Anthropic)', async () => {
    h.proxyReady = false;
    const adapter = await makeAdapter();
    await expect(adapter.getState({ credentialMode: 'oauth-bearer' })).resolves.toMatchObject({
      authenticated: true, authSource: 'oauth',
    });
  });

  it('buildClaudeEnv 端到端:订阅会话不走 proxy、不设 host 接管、不带凭证', async () => {
    const adapter = await makeAdapter();
    const env = await buildClaudeEnv(adapter, { endpoint: 'http://127.0.0.1:1' }, {
      credentialMode: 'oauth-bearer', nativeCliAuth: true, sessionProviderId: 'anthropic',
    });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
    for (const key of CREDENTIAL_KEYS) expect(env[key]).toBeUndefined();
  });

  it('未指定来源 + 有网关 key:走网关,与未连订阅时一致(即便订阅已连接)', async () => {
    const adapter = await makeAdapter();
    await expect(adapter.getState()).resolves.toEqual({ authenticated: true });
    const env = await adapter.getAuthEnv();
    expect(env.ANTHROPIC_API_KEY).toBe('sk-xd-gateway');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('未指定来源 + 无网关 key:交给本机 Claude Code 登录,不递凭证', async () => {
    h.gatewayKey = null;
    h.networkEnv = { HTTPS_PROXY: 'http://127.0.0.1:7890' };
    const adapter = await makeAdapter();
    await expect(adapter.getState()).resolves.toEqual({
      authenticated: true, identity: 'Claude.ai · OAuth', authSource: 'oauth',
    });
    const env = await adapter.getAuthEnv();
    for (const key of CREDENTIAL_KEYS) expect(env[key]).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
  });

  it('未指定来源 + 无网关 key:非 Anthropic 模型不交给订阅,经 proxy 隐式桥(占位 key)', async () => {
    h.gatewayKey = null;
    const mod = await import('../auth-adapters.js');
    const adapter = new mod.DesktopClaudeAuthAdapter();
    // 没有 authSource → maker-core 不按订阅会话起 CLI,仍设 proxy BASE_URL。
    await expect(adapter.getState({ model: 'glm-5' })).resolves.toEqual({ authenticated: true });
    await expect(adapter.getAuthEnv({ model: 'glm-5' })).resolves.toMatchObject({
      ANTHROPIC_API_KEY: mod.CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY,
    });
    // Anthropic 一方模型照常交给本机登录。
    await expect(adapter.getState({ model: 'claude-opus-4-7' })).resolves.toMatchObject({ authSource: 'oauth' });
    const env = await adapter.getAuthEnv({ model: 'claude-opus-4-7' });
    for (const key of CREDENTIAL_KEYS) expect(env[key]).toBeUndefined();
    const endToEnd = await buildClaudeEnv(adapter, { endpoint: 'http://127.0.0.1:1' }, { authModel: 'glm-5' });
    expect(endToEnd.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1');
    expect(endToEnd.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1');
    expect(endToEnd.ANTHROPIC_API_KEY).toBe(mod.CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY);
  });

  it('未指定来源 + 无网关 key + 未连订阅 → no_key', async () => {
    h.gatewayKey = null;
    h.nativeLogin = false;
    const adapter = await makeAdapter();
    await expect(adapter.getState()).resolves.toEqual({ authenticated: false, errorReason: 'no_key' });
    const env = await adapter.getAuthEnv();
    for (const key of CREDENTIAL_KEYS) expect(env[key]).toBeUndefined();
  });

  it('独立 Claude 账号已停用:拒绝授权、不递任何凭证', async () => {
    const providerId = 'anthropic-a';
    h.accounts.set(providerId, 'claude');
    const adapter = await makeAdapter();
    await expect(adapter.getState({ credentialMode: 'provider-oauth', providerId })).resolves.toMatchObject({
      authenticated: false, errorReason: 'claude_account_retired',
    });
    const env = await adapter.getAuthEnv({ credentialMode: 'provider-oauth', providerId });
    for (const key of CREDENTIAL_KEYS) expect(env[key]).toBeUndefined();
  });

  it('adapter 不再提供订阅 token 刷新回调', async () => {
    const adapter = await makeAdapter();
    expect((adapter as { getFreshSubscriptionToken?: unknown }).getFreshSubscriptionToken).toBeUndefined();
  });

  it('gateway-key 模式:只注入 ANTHROPIC_API_KEY,不带订阅 token(即便订阅在连)', async () => {
    const adapter = await makeAdapter();
    const env = await adapter.getAuthEnv({ credentialMode: 'gateway-key' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-xd-gateway');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('provider-oauth 模式:无网关 key / 订阅也可用,且只注入占位 key', async () => {
    h.nativeLogin = false;
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
    h.nativeLogin = false;
    h.gatewayKey = null;
    h.proxyReady = false;
    const adapter = await makeAdapter();

    await expect(adapter.getState({ credentialMode: 'provider-oauth' })).resolves.toEqual({
      authenticated: false,
      errorReason: 'proxy_not_ready',
    });
  });

  it('getOneShotAuth:连了订阅时 host 直连请求固定走网关 key,绝不用订阅', async () => {
    const mod = await import('../auth-adapters.js');
    const adapter = new mod.DesktopClaudeAuthAdapter();
    await expect(adapter.getOneShotAuth()).resolves.toMatchObject({ apiKey: 'sk-xd-gateway' });
    h.nativeLogin = false;
    await expect(adapter.getOneShotAuth()).resolves.toBeNull();
  });

  it('invalidate 只广播重新登录提示,不撤销 Cindy 的使用许可', async () => {
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));
    await adapter.invalidate('claude_cli_logged_out');
    expect(h.revoked).toBe(false);
    expect(h.disconnects).toBe(0);
    expect(h.retainPresentation).toHaveBeenCalledWith('anthropic');
    expect(broadcasts).toEqual(['claude_cli_logged_out']);
  });

  it('broadcasts before waiting for auxiliary presentation persistence', async () => {
    const adapter = await makeAdapter();
    let release!: () => void;
    h.retainPresentation.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
    const broadcast = vi.fn();
    adapter.setOnInvalidatedBroadcast(broadcast);
    const pending = adapter.invalidate('claude_cli_logged_out');
    expect(broadcast).toHaveBeenCalledWith('claude_cli_logged_out');
    release();
    await pending;
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('logout 撤销 Cindy 的使用许可,不登出 CLI', async () => {
    const adapter = await makeAdapter();
    await adapter.logout();
    expect(h.disconnects).toBe(1);
    expect(h.revoked).toBe(true);
    expect(h.removedGatewayKey).toBe(0);
  });

  it('logout 看绑定而非内存登录态:登录态未读到时也不误删网关 key', async () => {
    h.nativeLogin = false;
    const adapter = await makeAdapter();
    await adapter.logout();
    expect(h.disconnects).toBe(1);
    expect(h.removedGatewayKey).toBe(0);
  });
});
