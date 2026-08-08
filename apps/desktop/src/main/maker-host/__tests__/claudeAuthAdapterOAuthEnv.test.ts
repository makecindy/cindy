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

const h = vi.hoisted(() => ({
  hasOAuth: true,
  oauthState: 'present' as 'present' | 'absent' | 'unreadable' | 'binding-unreadable',
  oauth: null as Record<string, unknown> | null,
  gatewayKey: 'sk-xd-gateway' as string | null,
  cleared: 0,
  conditionalClearResult: 'cleared' as 'cleared' | 'absent' | 'changed',
  conditionalClearCalls: [] as Array<{ accessToken: string; refreshToken?: string | null }>,
  durableClearResult: 'cleared' as 'cleared' | 'absent' | 'changed',
  durableClearCalls: [] as Array<{ accessToken: string; refreshToken?: string | null }>,
  durableClearError: null as Error | null,
  durableRejectionCalls: [] as Array<{
    accessToken: string;
    refreshToken?: string | null;
  }>,
  durableRejectionErrors: [] as Error[],
  recoveryFenceCalls: [] as Array<{ accessToken: string; refreshToken?: string | null }>,
  recoveryFenceErrors: [] as Error[],
  clearError: null as Error | null,
  pendingRevocationResult: true,
  pendingRevocationError: null as Error | null,
  invalidationValidationResult: true,
  invalidationValidationResults: [] as boolean[],
  invalidationBeginCalls: 0,
  invalidationBeginErrors: [] as Error[],
  invalidationBeginReturnsNull: false,
  invalidationBeginChangesCredentialOnError: false,
  credentialMatchState: 'same' as 'same' | 'changed' | 'absent' | 'unreadable',
  credentialGuardCalls: 0,
  credentialGuardErrors: [] as Error[],
  conditionalClearChangesCredentialOnError: false,
  clearErrorAfterCommit: null as Error | null,
  refresherInvalidated: 0,
  disconnectCalls: 0,
  disconnectResultOverride: null as 'revoked' | 'confirmed-unbound' | null,
  gatewayRemovals: 0,
  unbindCalls: [] as Array<{
    provider: string;
    options?: {
      revoked?: boolean;
      ifOwnedByCurrentSession?: boolean;
      expectedOwner?: { dataOwnerId: string; generation: number };
      expectedOperation?: {
        dataOwnerId: string;
        generation: number;
        operationId: string;
        intent: 'invalidate';
      };
    };
  }>,
  pendingRevocations: [] as Array<{
    provider: string;
    owner: { dataOwnerId: string; generation: number };
  }>,
  rejectedCredentials: [] as Array<{
    source: 'invalid_grant';
    owner: { dataOwnerId: string; generation: number };
    rejectedCredential: { accessToken: string; refreshToken: string | null };
  }>,
  ownerId: 'owner-a' as string | null,
  ownerGeneration: 7,
  boundaryPending: false,
  invalidGrantHandler: null as
    | ((proof: {
        source: 'invalid_grant';
        owner: { dataOwnerId: string; generation: number };
        rejectedCredential: { accessToken: string; refreshToken: string | null };
        durabilityEstablished?: boolean;
      }) => void)
    | null,
  /** getValidClaudeAiOAuth 的可注入延迟(测回调超时用)。 */
  refreshDelayMs: 0,
  lastRefreshOpts: null as {
    staleToken?: string;
    staleAuthorizationRevision?: string;
    forceRefresh?: boolean;
  } | null,
  encryptionAvailable: true,
  proxyReady: true,
  canUseGateway: true,
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/xdt-test-userdata-nonexistent',
    // ripgrep 探测已惰性化(issue #1956):runtime-configs import 期不再读
    // getAppPath / isPackaged,这里无需再补。
  },
  safeStorage: { isEncryptionAvailable: () => h.encryptionAvailable },
}));

vi.mock('@cindy/maker-core', () => ({
  CINDY_CLAUDE_OAUTH_REVISION_ENV: 'CINDY_CLAUDE_OAUTH_REVISION',
}));

vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: h.canUseGateway }),
}));

vi.mock('../claude-credentials-store.js', () => ({
  hasClaudeAiOAuth: () => h.hasOAuth,
  getBoundClaudeAiOAuthState: () => h.oauthState,
  clearClaudeAiOAuth: () => {
    h.cleared += 1;
    if (h.clearError) throw h.clearError;
  },
  clearClaudeAiOAuthIfMatchesWithBindingCommit: (
    expected: { accessToken: string; refreshToken?: string | null },
    validate: () => boolean,
    commit: () => boolean,
  ) => {
    h.conditionalClearCalls.push(expected);
    if (h.clearError) {
      if (h.conditionalClearChangesCredentialOnError) h.credentialMatchState = 'changed';
      throw h.clearError;
    }
    if (h.conditionalClearResult === 'changed') return 'changed';
    if (!validate() || !commit()) return 'binding-changed';
    if (h.clearErrorAfterCommit) throw h.clearErrorAfterCommit;
    return h.conditionalClearResult;
  },
  clearClaudeAiOAuthIfMatchesWithBindingInvalidation: (
    expected: { accessToken: string; refreshToken?: string | null },
    owner: { dataOwnerId: string; generation: number },
  ) => {
    h.conditionalClearCalls.push(expected);
    if (h.credentialMatchState === 'changed' || h.conditionalClearResult === 'changed') {
      return 'changed';
    }
    h.invalidationBeginCalls += 1;
    const setupError = h.invalidationBeginErrors.shift();
    if (setupError) {
      if (h.invalidationBeginChangesCredentialOnError) h.credentialMatchState = 'changed';
      throw setupError;
    }
    if (h.invalidationBeginReturnsNull) return 'binding-changed';
    const valid = h.invalidationValidationResults.shift() ?? h.invalidationValidationResult;
    if (!valid) return 'binding-changed';
    if (h.clearError) {
      if (h.conditionalClearChangesCredentialOnError) h.credentialMatchState = 'changed';
      throw h.clearError;
    }
    h.unbindCalls.push({ provider: 'anthropic', options: { expectedOwner: owner } });
    if (h.clearErrorAfterCommit) throw h.clearErrorAfterCommit;
    return h.conditionalClearResult;
  },
  clearClaudeAiOAuthIfMatches: (expected: {
    accessToken: string;
    refreshToken?: string | null;
  }) => {
    h.durableClearCalls.push(expected);
    if (h.durableClearError) throw h.durableClearError;
    return h.durableClearResult;
  },
  getClaudeAiOAuthCredentialMatchState: () => h.credentialMatchState,
  runWithClaudeAiOAuthCredentialNotReplaced: <T>(
    _expected: { accessToken: string; refreshToken?: string | null },
    action: () => T,
  ) => {
    h.credentialGuardCalls += 1;
    const error = h.credentialGuardErrors.shift();
    if (error) throw error;
    return h.credentialMatchState === 'changed'
      ? { state: 'changed' as const }
      : { state: 'current' as const, value: action() };
  },
  getClaudeAiOAuthSessionAuthorizationRevision: (oauth: Record<string, unknown>) =>
    typeof oauth.cindyAuthorizationRevision === 'string'
      ? oauth.cindyAuthorizationRevision
      : 'cindy-unattributed-v1',
  persistClaudeAiOAuthCredentialRejection: (expected: {
    accessToken: string;
    refreshToken?: string | null;
  }) => {
    h.durableRejectionCalls.push(expected);
    const error = h.durableRejectionErrors.shift();
    if (error) throw error;
    return true;
  },
  persistClaudeAiOAuthCredentialRejectionRecovery: (expected: {
    accessToken: string;
    refreshToken?: string | null;
  }) => {
    h.recoveryFenceCalls.push(expected);
    const error = h.recoveryFenceErrors.shift();
    if (error) throw error;
    return true;
  },
}));

vi.mock('../claude-oauth-refresh.js', () => ({
  getValidClaudeAiOAuth: async (opts?: {
    staleToken?: string;
    staleAuthorizationRevision?: string;
    forceRefresh?: boolean;
  }) => {
    h.lastRefreshOpts = opts ?? null;
    if (h.refreshDelayMs > 0) await new Promise((r) => setTimeout(r, h.refreshDelayMs));
    return h.oauth;
  },
  getClaudeAiOAuthForSpawn: () => h.oauth,
  invalidateClaudeOAuthRefresh: () => {
    h.refresherInvalidated += 1;
  },
  rejectClaudeOAuthCredential: (proof: (typeof h.rejectedCredentials)[number]) => {
    const duplicate = h.rejectedCredentials.some(
      (existing) =>
        existing.owner.dataOwnerId === proof.owner.dataOwnerId &&
        existing.owner.generation === proof.owner.generation &&
        existing.rejectedCredential.accessToken === proof.rejectedCredential.accessToken &&
        existing.rejectedCredential.refreshToken === proof.rejectedCredential.refreshToken,
    );
    if (!duplicate) h.rejectedCredentials.push(proof);
    return true;
  },
  // disconnect = invalidate → clear(唯一断开入口,logout/IPC 都必须走它)
  disconnectClaudeAiOAuth: () => {
    h.disconnectCalls += 1;
    if (h.disconnectResultOverride) return h.disconnectResultOverride;
    if (h.oauthState === 'absent') return 'confirmed-unbound';
    h.refresherInvalidated += 1;
    if (h.oauthState === 'binding-unreadable') {
      h.pendingRevocations.push({
        provider: 'anthropic',
        owner: { dataOwnerId: h.ownerId ?? 'none', generation: h.ownerGeneration },
      });
      throw new Error('native provider auth binding is unreadable');
    }
    h.cleared += 1;
    if (h.clearError) throw h.clearError;
    return 'revoked';
  },
  setClaudeOAuthInvalidGrantHandler: (handler: typeof h.invalidGrantHandler) => {
    h.invalidGrantHandler = handler;
  },
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `cloud:${h.ownerId ?? 'none'}:${h.ownerGeneration}`,
  getActiveAppSession: () => ({
    mode: h.ownerId ? 'cloud' : 'signed-out',
    dataOwnerId: h.ownerId,
    generation: h.ownerGeneration,
  }),
  isAppSessionBoundaryPending: () => h.boundaryPending,
}));

vi.mock('../../secrets/providerSecretStore.js', () => ({
  getProviderSecretStore: () => ({
    get: () => h.gatewayKey,
    remove: () => {
      h.gatewayRemovals += 1;
      return { success: true };
    },
  }),
}));

vi.mock('../nativeProviderAuthBinding.js', () => ({
  beginNativeProviderAuthInvalidation: (
    _provider: string,
    owner: { dataOwnerId: string; generation: number },
  ) => {
    h.invalidationBeginCalls += 1;
    const error = h.invalidationBeginErrors.shift();
    if (error) {
      if (h.invalidationBeginChangesCredentialOnError) h.credentialMatchState = 'changed';
      throw error;
    }
    if (h.invalidationBeginReturnsNull) return null;
    return { ...owner, operationId: 'invalid-grant-operation', intent: 'invalidate' };
  },
  validateNativeProviderAuthInvalidation: () =>
    h.invalidationValidationResults.shift() ?? h.invalidationValidationResult,
  abandonNativeProviderAuthOperation: () => true,
  bindNativeProviderAuth: vi.fn(),
  claimDetectedNativeProviderAuth: vi.fn(() => false),
  isNativeProviderAuthBound: vi.fn(() => true),
  isNativeProviderAuthRevoked: vi.fn(() => false),
  isNativeProviderAuthSelfAuthorized: vi.fn(() => false),
  restoreNativeProviderAuthForRecovery: vi.fn(() => false),
  captureNativeProviderAuthOwnerFence: () =>
    h.ownerId && !h.boundaryPending
      ? { dataOwnerId: h.ownerId, generation: h.ownerGeneration }
      : null,
  getNativeProviderAuthBindingState: () =>
    h.oauthState === 'binding-unreadable'
      ? 'unreadable'
      : h.oauthState === 'absent'
        ? 'unbound'
        : 'bound',
  markNativeProviderAuthRevocationPending: (
    provider: string,
    owner: { dataOwnerId: string; generation: number },
  ) => {
    h.pendingRevocations.push({ provider, owner });
    if (h.pendingRevocationError) throw h.pendingRevocationError;
    return h.pendingRevocationResult;
  },
  unbindNativeProviderAuth: (
    provider: string,
    options?: {
      revoked?: boolean;
      ifOwnedByCurrentSession?: boolean;
      expectedOwner?: { dataOwnerId: string; generation: number };
      expectedOperation?: {
        dataOwnerId: string;
        generation: number;
        operationId: string;
        intent: 'invalidate';
      };
    },
  ) => {
    h.unbindCalls.push({ provider, ...(options === undefined ? {} : { options }) });
    return true;
  },
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
    h.oauthState = 'present';
    h.oauth = {
      accessToken: 'at-live',
      refreshToken: 'rt-live',
      expiresAt: Date.now() + 3600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      cindyAuthorizationRevision: 'login-revision-1',
    };
    h.gatewayKey = 'sk-xd-gateway';
    h.cleared = 0;
    h.conditionalClearResult = 'cleared';
    h.conditionalClearCalls.length = 0;
    h.durableClearResult = 'cleared';
    h.durableClearCalls.length = 0;
    h.durableClearError = null;
    h.durableRejectionCalls.length = 0;
    h.durableRejectionErrors.length = 0;
    h.recoveryFenceCalls.length = 0;
    h.recoveryFenceErrors.length = 0;
    h.clearError = null;
    h.pendingRevocationResult = true;
    h.pendingRevocationError = null;
    h.invalidationValidationResult = true;
    h.invalidationValidationResults.length = 0;
    h.invalidationBeginCalls = 0;
    h.invalidationBeginErrors.length = 0;
    h.invalidationBeginReturnsNull = false;
    h.invalidationBeginChangesCredentialOnError = false;
    h.credentialMatchState = 'same';
    h.credentialGuardCalls = 0;
    h.credentialGuardErrors.length = 0;
    h.conditionalClearChangesCredentialOnError = false;
    h.clearErrorAfterCommit = null;
    h.refresherInvalidated = 0;
    h.disconnectCalls = 0;
    h.disconnectResultOverride = null;
    h.gatewayRemovals = 0;
    h.unbindCalls.length = 0;
    h.pendingRevocations.length = 0;
    h.rejectedCredentials.length = 0;
    h.ownerId = 'owner-a';
    h.ownerGeneration = 7;
    h.boundaryPending = false;
    h.refreshDelayMs = 0;
    h.encryptionAvailable = true;
    h.proxyReady = true;
    h.canUseGateway = true;
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
    expect(env.CINDY_CLAUDE_OAUTH_REVISION).toBe('login-revision-1');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('订阅字段缺省时只注入 token 本体,不留空值 env', async () => {
    h.oauth = { accessToken: 'at-live' };
    const adapter = await makeAdapter();
    const env = await adapter.getAuthEnv();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('at-live');
    expect(env.CINDY_CLAUDE_OAUTH_REVISION).toBe('cindy-unattributed-v1');
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
    await expect(
      adapter.getFreshSubscriptionToken('at-failed', 'login-revision-0'),
    ).resolves.toEqual({
      token: 'at-live',
      authorizationRevision: 'login-revision-1',
    });
    expect(h.lastRefreshOpts).toMatchObject({
      forceRefresh: true,
      staleToken: 'at-failed',
      staleAuthorizationRevision: 'login-revision-0',
    });
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

  it('invalidate:只失效刷新器并广播,无 proof 时绝不清共享凭证', async () => {
    const mod = await import('../auth-adapters.js');
    const adapter = new mod.DesktopClaudeAuthAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));
    await adapter.invalidate('claude_oauth_refresh_invalid_grant');
    expect(h.cleared).toBe(0);
    expect(h.refresherInvalidated).toBe(1);
    expect(h.unbindCalls).toEqual([]);
    expect(h.pendingRevocations).toEqual([]);
    expect(broadcasts).toEqual(['claude_oauth_refresh_invalid_grant']);
    expect(h.refresherInvalidated).toBe(1);
  });

  it('invalid_grant cleanup 失败时依靠 grant fence 广播,不写 provider-global marker', async () => {
    h.clearError = new Error('credential store unavailable');
    h.pendingRevocationResult = false;
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));

    h.invalidGrantHandler?.({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
    });
    await vi.waitFor(() => expect(h.rejectedCredentials).toHaveLength(1));

    expect(h.pendingRevocations).toEqual([]);
    expect(h.refresherInvalidated).toBe(0);
    expect(broadcasts).toEqual(['claude_oauth_refresh_invalid_grant']);
  });

  it('authorization epoch 不可读时保持 grant fence,不写通用撤销 intent', async () => {
    h.clearError = new Error('claude credential authorization epoch is unreadable', {
      cause: Object.assign(new Error('binding permission denied'), { code: 'EACCES' }),
    });
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));

    h.invalidGrantHandler?.({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
    });
    await vi.waitFor(() => expect(broadcasts).toHaveLength(1));

    expect(h.conditionalClearCalls).toEqual([
      { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
    ]);
    expect(h.unbindCalls).toEqual([]);
    expect(h.pendingRevocations).toEqual([]);
    expect(h.credentialMatchState).toBe('same');
    expect(broadcasts).toEqual(['claude_oauth_refresh_invalid_grant']);
  });

  it('invalid_grant cleanup 失败后凭证已替换则不广播旧账号失效', async () => {
    h.clearError = new Error('credential store unavailable');
    h.conditionalClearChangesCredentialOnError = true;
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));

    h.invalidGrantHandler?.({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
    });
    await vi.waitFor(() => expect(h.conditionalClearCalls).toHaveLength(1));

    expect(h.pendingRevocations).toEqual([]);
    expect(h.refresherInvalidated).toBe(0);
    expect(h.rejectedCredentials).toHaveLength(1);
    expect(broadcasts).toEqual([]);
  });

  it('invalid_grant 主解绑已提交但收尾抛错时仍失效旧 refresher', async () => {
    h.clearErrorAfterCommit = new Error('binding lock release failed');
    h.pendingRevocationResult = false;
    h.invalidationValidationResults.push(true, false);
    h.credentialMatchState = 'absent';
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));

    h.invalidGrantHandler?.({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
    });
    await vi.waitFor(() => expect(h.rejectedCredentials).toHaveLength(1));

    expect(h.unbindCalls).toHaveLength(1);
    expect(h.refresherInvalidated).toBe(0);
    expect(broadcasts).toEqual(['claude_oauth_refresh_invalid_grant']);
  });

  it('invalidate:凭证库不可读时也不猜测删除或写撤销标记', async () => {
    h.hasOAuth = false;
    h.oauthState = 'unreadable';
    h.clearError = new Error('keychain locked');
    const adapter = await makeAdapter();

    await expect(adapter.invalidate('claude_oauth_refresh_invalid_grant')).resolves.toBeUndefined();

    expect(h.cleared).toBe(0);
    expect(h.refresherInvalidated).toBe(1);
    expect(h.unbindCalls).toEqual([]);
    expect(h.pendingRevocations).toEqual([]);
    expect(h.gatewayRemovals).toBe(0);
  });

  it('invalidate:只有 reason 没有 proof 时,归属不可读也绝不猜测删除 OAuth', async () => {
    h.hasOAuth = false;
    h.oauthState = 'binding-unreadable';
    const adapter = await makeAdapter();

    await expect(adapter.invalidate('claude_oauth_refresh_invalid_grant')).resolves.toBeUndefined();

    expect(h.cleared).toBe(0);
    expect(h.conditionalClearCalls).toEqual([]);
    expect(h.refresherInvalidated).toBe(1);
    expect(h.unbindCalls).toEqual([]);
    expect(h.pendingRevocations).toEqual([]);
    expect(h.gatewayRemovals).toBe(0);
  });

  it('invalidate:归属不可读且没有 token provenance 时不删除任何凭证', async () => {
    h.hasOAuth = false;
    h.oauthState = 'binding-unreadable';
    const adapter = await makeAdapter();

    await expect(adapter.invalidate('unrelated_auth_reset')).resolves.toBeUndefined();

    expect(h.cleared).toBe(0);
    expect(h.refresherInvalidated).toBe(1);
    expect(h.unbindCalls).toEqual([]);
    expect(h.pendingRevocations).toEqual([]);
    expect(h.gatewayRemovals).toBe(0);
  });

  it('invalidate:明确未绑定 OAuth 时不触碰 Claude CLI 的共享凭证', async () => {
    h.hasOAuth = false;
    h.oauthState = 'absent';
    const adapter = await makeAdapter();

    await expect(adapter.invalidate('unrelated_auth_reset')).resolves.toBeUndefined();

    expect(h.refresherInvalidated).toBe(1);
    expect(h.cleared).toBe(0);
    expect(h.unbindCalls).toEqual([]);
    expect(h.pendingRevocations).toEqual([]);
  });

  it('构造期接线 invalid_grant handler(刷新模块通知 → invalidate 链路可达)', async () => {
    await makeAdapter();
    expect(typeof h.invalidGrantHandler).toBe('function');
  });

  it('迟到的 invalid_grant proof 只条件清旧 token,新账号已替换时不解绑也不广播', async () => {
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    const replacements = vi.fn();
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));
    adapter.setOnCredentialReplacementDetected(replacements);
    h.conditionalClearResult = 'changed';

    h.invalidGrantHandler?.({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-old', refreshToken: 'rt-old' },
    });
    await vi.waitFor(() => expect(h.conditionalClearCalls).toHaveLength(1));

    expect(h.conditionalClearCalls).toEqual([{ accessToken: 'at-old', refreshToken: 'rt-old' }]);
    expect(h.unbindCalls).toEqual([]);
    expect(h.pendingRevocations).toEqual([]);
    expect(broadcasts).toEqual([]);
    expect(replacements).toHaveBeenCalledOnce();
    expect(h.refresherInvalidated).toBe(0);
    expect(h.rejectedCredentials).toHaveLength(1);
  });

  it('有效 invalid_grant proof 只清匹配 token,并按原 owner generation 条件解绑', async () => {
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));

    h.invalidGrantHandler?.({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-old', refreshToken: 'rt-old' },
    });
    await vi.waitFor(() => expect(broadcasts).toHaveLength(1));

    expect(h.conditionalClearCalls).toEqual([{ accessToken: 'at-old', refreshToken: 'rt-old' }]);
    expect(h.unbindCalls).toEqual([
      {
        provider: 'anthropic',
        options: {
          expectedOwner: { dataOwnerId: 'owner-a', generation: 7 },
        },
      },
    ]);
    expect(h.pendingRevocations).toEqual([]);
    expect(h.rejectedCredentials).toHaveLength(1);
    expect(broadcasts).toEqual(['claude_oauth_refresh_invalid_grant']);
  });

  it('refresher 未建立耐久拒绝时先补 grant-scoped recovery fence', async () => {
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));

    h.invalidGrantHandler?.({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-old', refreshToken: 'rt-old' },
      durabilityEstablished: false,
    });
    await vi.waitFor(() => expect(broadcasts).toHaveLength(1));

    expect(h.recoveryFenceCalls).toEqual([{ accessToken: 'at-old', refreshToken: 'rt-old' }]);
  });

  it('invalid_grant proof 的 owner generation 已过期时不触碰任何新会话状态', async () => {
    await makeAdapter();
    h.ownerGeneration = 8;

    h.invalidGrantHandler?.({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-old', refreshToken: 'rt-old' },
    });
    await Promise.resolve();

    expect(h.conditionalClearCalls).toEqual([]);
    expect(h.unbindCalls).toEqual([]);
    expect(h.pendingRevocations).toEqual([]);
    expect(h.refresherInvalidated).toBe(0);
    expect(h.rejectedCredentials).toEqual([]);
  });

  it('a real newer auth operation leaves token durability to the refresher and stays silent', async () => {
    h.invalidationBeginReturnsNull = true;
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    const replacements = vi.fn();
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));
    adapter.setOnCredentialReplacementDetected(replacements);

    h.invalidGrantHandler?.({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
    });
    await vi.waitFor(() => expect(h.rejectedCredentials).toHaveLength(1));

    expect(h.invalidationBeginCalls).toBe(1);
    expect(h.conditionalClearCalls).toEqual([
      { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
    ]);
    expect(h.durableClearCalls).toEqual([]);
    expect(h.unbindCalls).toEqual([]);
    expect(broadcasts).toEqual([]);
    expect(replacements).not.toHaveBeenCalled();
  });

  it('setup lock contention retries owner cleanup without duplicating refresher durability', async () => {
    const locked = Object.assign(new Error('binding lock busy'), { code: 'ELOCKED' });
    h.durableRejectionErrors.push(locked);
    h.invalidationBeginErrors.push(locked);
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));

    h.invalidGrantHandler?.({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
    });

    await vi.waitFor(() => expect(h.rejectedCredentials).toHaveLength(1));
    await vi.waitFor(() => expect(h.unbindCalls).toHaveLength(1));
    expect(h.durableRejectionCalls).toEqual([]);
    expect(h.invalidationBeginCalls).toBe(2);
    expect(h.pendingRevocations).toEqual([]);
    expect(h.refresherInvalidated).toBe(0);
    expect(broadcasts).toEqual(['claude_oauth_refresh_invalid_grant']);
  });

  it('final guarded broadcast survives the full stale-lock window', async () => {
    vi.useFakeTimers();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      h.credentialGuardErrors.push(
        Object.assign(new Error('credential storage lock busy'), { code: 'ELOCKED' }),
      );
    }
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));

    try {
      h.invalidGrantHandler?.({
        source: 'invalid_grant',
        owner: { dataOwnerId: 'owner-a', generation: 7 },
        rejectedCredential: { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
      });
      expect(h.credentialGuardCalls).toBe(1);
      expect(broadcasts).toEqual([]);

      // 100 + 250 + 500 + 1s + 2s + 4s + 8s + 8s = 23.85s,
      // deliberately longer than the shared storage lock's 15s stale window.
      await vi.advanceTimersByTimeAsync(23_850);

      expect(h.credentialGuardCalls).toBe(9);
      expect(broadcasts).toEqual(['claude_oauth_refresh_invalid_grant']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replacement committed while final broadcast waits suppresses the old logout event', async () => {
    vi.useFakeTimers();
    h.credentialGuardErrors.push(
      Object.assign(new Error('credential storage lock busy'), { code: 'ELOCKED' }),
    );
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    const replacements = vi.fn();
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));
    adapter.setOnCredentialReplacementDetected(replacements);

    try {
      h.invalidGrantHandler?.({
        source: 'invalid_grant',
        owner: { dataOwnerId: 'owner-a', generation: 7 },
        rejectedCredential: { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
      });
      expect(h.credentialGuardCalls).toBe(1);

      h.credentialMatchState = 'changed';
      await vi.advanceTimersByTimeAsync(100);

      expect(h.credentialGuardCalls).toBe(2);
      expect(broadcasts).toEqual([]);
      expect(replacements).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('replacement committed after setup contention keeps the old identity fenced without broadcasting', async () => {
    vi.useFakeTimers();
    h.invalidationBeginErrors.push(
      Object.assign(new Error('binding lock busy'), { code: 'ELOCKED' }),
    );
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));

    try {
      h.invalidGrantHandler?.({
        source: 'invalid_grant',
        owner: { dataOwnerId: 'owner-a', generation: 7 },
        rejectedCredential: { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
      });
      expect(h.invalidationBeginCalls).toBe(1);
      expect(h.rejectedCredentials).toHaveLength(1);
      expect(broadcasts).toEqual([]);

      // The competing login commits while this cleanup is in its retry delay.
      h.credentialMatchState = 'changed';
      await vi.advanceTimersByTimeAsync(50);

      expect(h.invalidationBeginCalls).toBe(1);
      expect(h.conditionalClearCalls).toEqual([
        { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
        { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
      ]);
      expect(h.durableClearCalls).toEqual([]);
      expect(h.unbindCalls).toEqual([]);
      expect(h.pendingRevocations).toEqual([]);
      expect(h.rejectedCredentials).toHaveLength(1);
      expect(h.refresherInvalidated).toBe(0);
      expect(broadcasts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('permanent setup failure broadcasts the already-suppressed rejected credential', async () => {
    h.invalidationBeginErrors.push(
      Object.assign(new Error('binding permission denied'), { code: 'EACCES' }),
    );
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));

    h.invalidGrantHandler?.({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
    });
    await vi.waitFor(() => expect(h.invalidationBeginCalls).toBe(1));

    expect(h.conditionalClearCalls).toEqual([
      { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
    ]);
    expect(h.durableClearCalls).toEqual([]);
    expect(h.unbindCalls).toEqual([]);
    expect(h.pendingRevocations).toEqual([]);
    expect(h.rejectedCredentials).toHaveLength(1);
    expect(h.refresherInvalidated).toBe(0);
    expect(broadcasts).toEqual(['claude_oauth_refresh_invalid_grant']);
  });

  it('replacement committed before first setup cannot leave a stale invalidation intent', async () => {
    h.credentialMatchState = 'changed';
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));

    h.invalidGrantHandler?.({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
    });
    await vi.waitFor(() => expect(h.rejectedCredentials).toHaveLength(1));

    expect(h.invalidationBeginCalls).toBe(0);
    expect(h.conditionalClearCalls).toEqual([
      { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
    ]);
    expect(h.durableClearCalls).toEqual([]);
    expect(h.unbindCalls).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('does not repeat the refresher durable-clear fallback after setup failure', async () => {
    h.invalidationBeginErrors.push(
      Object.assign(new Error('binding permission denied'), { code: 'EACCES' }),
    );
    const adapter = await makeAdapter();
    const broadcasts: string[] = [];
    adapter.setOnInvalidatedBroadcast((reason) => broadcasts.push(reason));

    h.invalidGrantHandler?.({
      source: 'invalid_grant',
      owner: { dataOwnerId: 'owner-a', generation: 7 },
      rejectedCredential: { accessToken: 'at-rejected', refreshToken: 'rt-rejected' },
    });
    await vi.waitFor(() => expect(h.invalidationBeginCalls).toBe(1));

    expect(h.durableClearCalls).toEqual([]);
    expect(h.rejectedCredentials).toHaveLength(1);
    expect(broadcasts).toEqual(['claude_oauth_refresh_invalid_grant']);
  });

  it('logout(订阅在连):清凭证同时失效刷新器,防在途刷新复活凭证', async () => {
    const adapter = await makeAdapter();
    await adapter.logout();
    expect(h.cleared).toBe(1);
    expect(h.refresherInvalidated).toBe(1);
    expect(h.disconnectCalls).toBe(1);
    expect(h.unbindCalls).toEqual([]);
    expect(h.gatewayRemovals).toBe(0);
  });

  it('logout:凭证库不可读时失效刷新并失败,不误删 gateway key', async () => {
    h.hasOAuth = false;
    h.oauthState = 'unreadable';
    h.clearError = new Error('keychain locked');
    const adapter = await makeAdapter();

    await expect(adapter.logout()).rejects.toThrow('keychain locked');

    expect(h.refresherInvalidated).toBe(1);
    expect(h.cleared).toBe(1);
    expect(h.disconnectCalls).toBe(1);
    expect(h.unbindCalls).toEqual([]);
    expect(h.gatewayRemovals).toBe(0);
  });

  it('logout:归属不可读时失效刷新并拒绝猜测,OAuth 与 gateway 都不删除', async () => {
    h.hasOAuth = false;
    h.oauthState = 'binding-unreadable';
    const adapter = await makeAdapter();

    await expect(adapter.logout()).rejects.toThrow(/binding is unreadable/i);

    expect(h.refresherInvalidated).toBe(1);
    expect(h.disconnectCalls).toBe(1);
    expect(h.cleared).toBe(0);
    expect(h.unbindCalls).toEqual([]);
    expect(h.pendingRevocations).toHaveLength(1);
    expect(h.gatewayRemovals).toBe(0);
  });

  it('logout:即使尚未绑定 OAuth 也先串行化登出,确认无绑定后才移除 gateway key', async () => {
    h.hasOAuth = false;
    h.oauthState = 'absent';
    const adapter = await makeAdapter();

    await expect(adapter.logout()).resolves.toBeUndefined();

    expect(h.refresherInvalidated).toBe(0);
    expect(h.disconnectCalls).toBe(1);
    expect(h.cleared).toBe(0);
    expect(h.unbindCalls).toEqual([]);
    expect(h.gatewayRemovals).toBe(1);
  });

  it('logout:stale OAuth binding 收口后确认凭证缺失,同一次调用继续移除 gateway key', async () => {
    h.disconnectResultOverride = 'confirmed-unbound';
    const adapter = await makeAdapter();

    await expect(adapter.logout()).resolves.toBeUndefined();

    expect(h.disconnectCalls).toBe(1);
    expect(h.gatewayRemovals).toBe(1);
  });

  it('logout:已绑定 OAuth 清除失败时仍写 revoked 并向调用方报错', async () => {
    h.oauthState = 'present';
    h.clearError = new Error('credential delete failed');
    const adapter = await makeAdapter();

    await expect(adapter.logout()).rejects.toThrow('credential delete failed');

    expect(h.refresherInvalidated).toBe(1);
    expect(h.disconnectCalls).toBe(1);
    expect(h.cleared).toBe(1);
    expect(h.unbindCalls).toEqual([]);
    expect(h.gatewayRemovals).toBe(0);
  });
});
