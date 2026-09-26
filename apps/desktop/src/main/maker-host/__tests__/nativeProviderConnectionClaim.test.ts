/**
 * 连接态读取路径上的 native provider 绑定自愈(anthropic / xai)。
 *
 * 回归的是 #294 同族缺陷的另一半:本机 CLI 凭证的自动继承只在「cloud 模式 + 持有
 * legacy 命名空间认领」时才由一次性迁移建立,local 模式 owner 与没跑到迁移的 cloud
 * owner 永远拿不到 —— 设置页与聊天门禁于是各说各话。anthropic 还多一层:启动期的磁盘
 * 清单加载因未绑定而早退,绑定建立后要补一次,否则只剩 Registry presence。Claude 订阅的
 * 登录态来自内置 CLI(`claude auth status`),Cindy 不读凭证、也不带凭证拉清单。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, type Catalog } from '@cindy/model-providers';

const h = vi.hoisted(() => ({
  userDataDir: '',
  dataOwnerId: 'owner-a' as string | null,
  generation: 1,
  legacyCloudOwner: false,
  catalog: null as Catalog | null,
  claudeCredentialPresent: true,
  grokCredentialPresent: true,
  refreshXaiModels: vi.fn(async () => true),
  loadXaiDiskCache: vi.fn(async () => false),
  refreshXaiMediaModels: vi.fn(async () => true),
  loadAnthropicDiskCache: vi.fn(async () => {}),
  codexLoginWithSideEffects: vi.fn(async () => false),
  codexLoginReadOnly: vi.fn(() => false),
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir },
  net: { request: vi.fn() },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({
    mode: h.dataOwnerId ? ('local' as const) : ('signed-out' as const),
    dataOwnerId: h.dataOwnerId,
    generation: h.generation,
  }),
  activeOwnerScopeKey: () => `local:${h.dataOwnerId ?? 'none'}:${h.generation}`,
  isAppSessionBoundaryPending: () => false,
  // model-disable-store(经 createDesktopProviderService 引入)按 owner 定位 override
  // 文件;指到本用例的临时 userData 即可(store 是惰性读,文件缺席 = 全启用)。
  ownerScopedUserDataPath: (...segments: string[]) => path.join(h.userDataDir, ...segments),
}));

// 本机 CLI 登录态:*Unbound 是「CLI 登没登录」,无绑定语义;带绑定的读取叠加 owner 校验,
// 与真实实现(claude-native-auth / hasGrokOAuthLogin)的分层一致。
vi.mock('../claude-native-auth.js', () => ({
  hasClaudeNativeLoginUnbound: () => h.claudeCredentialPresent,
  hasClaudeNativeLogin: () => h.claudeCredentialPresent && isBoundToCurrentOwner('anthropic'),
}));
vi.mock('../claude-native-connection.js', () => ({
  readClaudeNativeLogin: async () =>
    h.claudeCredentialPresent && isBoundToCurrentOwner('anthropic')
      ? { loggedIn: true, email: 'claude@example.test' }
      : null,
}));
vi.mock('../claude-native-cli.js', () => ({
  readClaudeCliLoginStatus: async () => ({ loggedIn: h.claudeCredentialPresent }),
}));
vi.mock('../grok-oauth-login.js', () => ({
  grokAccountIdentity: () => 'grok@example.test',
  hasGrokOAuthLoginUnbound: () => h.grokCredentialPresent,
  hasGrokOAuthLogin: () => h.grokCredentialPresent && isBoundToCurrentOwner('xai'),
  getGrokAccessToken: () => null,
  peekGrokAccessToken: () => null,
  resetGrokOAuthMemoryCache: () => {},
}));

vi.mock('../model-discovery/anthropic.js', () => ({
  loadAnthropicModelsFromDiskCache: h.loadAnthropicDiskCache,
}));
vi.mock('../model-discovery/xai.js', () => ({
  clearXaiDiscoveredModels: vi.fn(),
  loadXaiModelsFromDiskCache: h.loadXaiDiskCache,
  refreshXaiModelsFromHttp: h.refreshXaiModels,
}));
vi.mock('../model-discovery/xai-media.js', () => ({
  refreshXaiMediaModels: h.refreshXaiMediaModels,
  clearXaiMediaModels: vi.fn(),
}));

vi.mock('../active-catalog.js', async () => {
  const actual =
    await vi.importActual<typeof import('../active-catalog.js')>('../active-catalog.js');
  return {
    ...actual,
    getActiveCatalog: () => h.catalog ?? actual.getActiveCatalog(),
  };
});

// hasCodexOAuthLogin 在真实实现里会经 getAccessToken 触发 reconcile(建硬链 + 写绑定);
// ReadOnly 变体是它的纯读同侪。这里用计数区分两条路径分别被谁调用。
vi.mock('../auth-adapters.js', () => ({
  readClaudeApiKey: () => null,
  desktopCodexAuthAdapter: {
    hasCodexOAuthLogin: h.codexLoginWithSideEffects,
    hasCodexOAuthLoginReadOnly: h.codexLoginReadOnly,
    readAccountPresentationState: async () => ({ authenticated: h.codexLoginReadOnly() }),
    hasCodexOAuthLoginUnbound: () => false,
  },
}));

vi.mock('../../authManager.js', () => ({
  getAuthState: () => h.legacyCloudOwner
    ? { mode: 'cloud', user: { id: h.dataOwnerId } }
    : { mode: 'local', user: null },
}));
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: false }),
}));
vi.mock('../../ownerNamespaceMigration.js', () => ({
  hasLegacyOwnerNamespaceClaim: () => h.legacyCloudOwner,
}));
vi.mock('../../manifestService.js', () => ({
  isDev: () => true,
  getBaseUrl: () => 'https://example.invalid',
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getBuildClientEndpoint: () => 'https://example.invalid',
  getClientEndpoint: () => 'https://example.invalid',
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  genericOAuthSecretIo: {},
  setProviderSecretsClearedListener: () => {},
  addProviderSecretsClearedListener: () => {},
  readCustomProviderKey: () => null,
  // builtinApiKeyConnected(gemini)在 listProviders 里读 key 存在性;本测试不关心
  // 该供应商,恒返回 null = 未配置。
  getProviderSecretStore: () => ({ get: () => null, has: () => h.grokCredentialPresent }),
}));

import {
  getDesktopProviderService,
  setNativeProviderClaimListener,
} from '../createDesktopProviderService.js';
import {
  bindNativeProviderAuth,
  getNativeProviderAuthSource,
  isNativeProviderAuthBound,
} from '../nativeProviderAuthBinding.js';

function isBoundToCurrentOwner(provider: 'anthropic' | 'xai'): boolean {
  return isNativeProviderAuthBound(provider);
}

async function listProviders(allowSideEffects = true, waitForDiscovery = false) {
  return getDesktopProviderService({ allowSideEffects }).listProviders({ allowSideEffects, waitForDiscovery });
}

async function connectedMap(allowSideEffects = true): Promise<Record<string, boolean>> {
  const providers = await listProviders(allowSideEffects);
  return Object.fromEntries(providers.map((p) => [p.id, p.connected]));
}

beforeEach(() => {
  h.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-native-conn-claim-'));
  h.dataOwnerId = 'owner-a';
  h.generation = 1;
  h.legacyCloudOwner = false;
  h.catalog = BUNDLED_CATALOG;
  h.claudeCredentialPresent = true;
  h.grokCredentialPresent = true;
  h.refreshXaiModels.mockClear();
  h.loadXaiDiskCache.mockClear();
  h.refreshXaiMediaModels.mockClear();
  h.loadAnthropicDiskCache.mockClear();
  h.codexLoginWithSideEffects.mockClear();
  h.codexLoginReadOnly.mockClear();
});

afterEach(() => {
  fs.rmSync(h.userDataDir, { recursive: true, force: true });
});

describe('native provider connection claim on read', () => {
  it('read-only service acquisition skips legacy migration even for eligible cloud owners', async () => {
    h.legacyCloudOwner = true;
    await listProviders(false);
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(isNativeProviderAuthBound('xai')).toBe(false);
    expect(fs.existsSync(path.join(h.userDataDir, 'native-provider-auth.json'))).toBe(false);
    // A later trusted acquisition of the same singleton still performs migration.
    getDesktopProviderService();
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    expect(isNativeProviderAuthBound('xai')).toBe(true);
  });

  it('projects only bound native account identities without exposing credentials', async () => {
    const before = await listProviders(false);
    for (const id of ['anthropic', 'xai']) {
      expect(before.find((p) => p.id === id)?.subscriptionAccount?.identity).toBeUndefined();
    }
    bindNativeProviderAuth('anthropic', { sharedSystem: true });
    bindNativeProviderAuth('xai');
    const after = await listProviders(false);
    expect(after.find((p) => p.id === 'anthropic')?.subscriptionAccount).toEqual({
      source: 'local', identity: 'claude@example.test',
    });
    expect(after.find((p) => p.id === 'xai')?.subscriptionAccount).toEqual({
      source: 'oauth', identity: 'grok@example.test',
    });
    h.dataOwnerId = 'owner-b';
    h.generation += 1;
    const switched = await listProviders(false);
    for (const id of ['anthropic', 'xai']) {
      expect(switched.find((p) => p.id === id)?.subscriptionAccount?.identity).toBeUndefined();
    }
  });
  it('认领本机 anthropic 登录并补载一次磁盘清单(修「已连接 + 零模型」)', async () => {
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);

    expect((await connectedMap()).anthropic).toBe(true);
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    expect(getNativeProviderAuthSource('anthropic')).toBe('native-harness-inherited');
    // 启动期那次磁盘清单加载因未绑定而早退了,绑定刚建立时必须补一次(PR #548 review)。
    await vi.waitFor(() => expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1));

    // 已绑定后不再重复认领,也不再重复加载。
    await connectedMap();
    expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1);
  });

  it('首次认领要等磁盘清单补载完成后再返回本次 provider 快照', async () => {
    const anthropic = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'anthropic')!;
    const modelSeed = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'xd')!.models[
      'claude-code'
    ]![0]!;
    const cachedModel = { ...modelSeed, id: 'claude-cached', name: 'Claude Cached' };
    const cachedCatalog: Catalog = {
      ...BUNDLED_CATALOG,
      providers: BUNDLED_CATALOG.providers.map((provider) =>
        provider.id === anthropic.id
          ? { ...provider, models: { ...provider.models, 'claude-code': [cachedModel] } }
          : provider,
      ),
    };
    let releaseCache!: () => void;
    h.loadAnthropicDiskCache.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCache = () => {
            h.catalog = cachedCatalog;
            resolve();
          };
        }),
    );

    let settled = false;
    const providersPromise = listProviders(true, true).then((providers) => {
      settled = true;
      return providers;
    });

    await vi.waitFor(() => expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1));
    const settledBeforeCache = settled;
    releaseCache();

    const providers = await providersPromise;
    expect(settledBeforeCache).toBe(false);
    expect(providers.find((provider) => provider.id === 'anthropic')?.connected).toBe(true);
    expect(
      providers.find((provider) => provider.id === 'anthropic')?.models['claude-code'],
    ).toEqual([cachedModel]);
  });

  it('普通可信 provider read 不等待首次磁盘清单补载，先返回 connected', async () => {
    let releaseCache!: () => void;
    h.loadAnthropicDiskCache.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCache = resolve;
        }),
    );

    const providers = await listProviders();
    expect(providers.find((provider) => provider.id === 'anthropic')?.connected).toBe(true);
    await vi.waitFor(() => expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1));

    releaseCache();
    await listProviders(true, true);
  });

  it('fresh routing read 在磁盘清单补载失败时仍返回 connected 状态', async () => {
    h.loadAnthropicDiskCache.mockRejectedValueOnce(new Error('disk unreadable'));

    const providers = await listProviders(true, true);
    expect(providers.find((provider) => provider.id === 'anthropic')?.connected).toBe(true);
  });

  it('并发读取要共等首次认领的同一趟清单补载', async () => {
    let releaseCache!: () => void;
    h.loadAnthropicDiskCache.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCache = resolve;
        }),
    );

    const first = listProviders(true, true);
    await vi.waitFor(() => expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1));
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);

    let secondSettled = false;
    const second = listProviders(true, true).then((providers) => {
      secondSettled = true;
      return providers;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseCache();
    const [firstProviders, secondProviders] = await Promise.all([first, second]);
    expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1);
    expect(firstProviders.find((provider) => provider.id === 'anthropic')?.connected).toBe(true);
    expect(secondProviders.find((provider) => provider.id === 'anthropic')?.connected).toBe(true);
  });

  it('不把 Cindy 存在的 xAI token 当本机 CLI 凭证自动认领', async () => {
    expect((await connectedMap()).xai).toBe(false);
    expect(isNativeProviderAuthBound('xai')).toBe(false);
    expect(h.refreshXaiModels).not.toHaveBeenCalled();
    expect(h.loadXaiDiskCache).not.toHaveBeenCalled();

    bindNativeProviderAuth('xai');
    expect((await connectedMap()).xai).toBe(true);
    expect(getNativeProviderAuthSource('xai')).toBe('explicit-provider-oauth');
    expect(h.refreshXaiModels).not.toHaveBeenCalled();
    // Explicit OAuth/login owns discovery refresh. Merely reading connection state after
    // a durable binding must stay side-effect free and must not re-run media discovery.
    expect(h.refreshXaiMediaModels).not.toHaveBeenCalled();
  });

  it('认领成功要广播:其它窗口与 device-link 对端只认这条推送来失效快照', async () => {
    // Claude 本机凭证自愈后要广播；xAI 不走本机凭证认领。
    h.grokCredentialPresent = false;
    const onClaimed = vi.fn();
    setNativeProviderClaimListener(onClaimed);
    try {
      await listProviders(true, true);
      expect(isNativeProviderAuthBound('anthropic')).toBe(true);
      expect(onClaimed).toHaveBeenCalledTimes(1);

      // 已绑定后不再重复广播。
      await connectedMap();
      expect(onClaimed).toHaveBeenCalledTimes(1);
    } finally {
      setNativeProviderClaimListener(null);
    }
  });

  it('认领等待期间 owner generation 切换时不向新 owner 广播旧 claim', async () => {
    h.grokCredentialPresent = false; // 只观察 Anthropic 的异步认领广播
    let releaseCache!: () => void;
    h.loadAnthropicDiskCache.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCache = resolve;
        }),
    );
    const onClaimed = vi.fn();
    setNativeProviderClaimListener(onClaimed);
    try {
      const providersPromise = listProviders(true, true);
      await vi.waitFor(() => expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1));
      h.generation = 2;
      releaseCache();
      await providersPromise;
      expect(onClaimed).not.toHaveBeenCalled();
    } finally {
      setNativeProviderClaimListener(null);
    }
  });

  it('广播收口抛错不影响认领结果', async () => {
    setNativeProviderClaimListener(() => {
      throw new Error('broadcast boom');
    });
    try {
      await expect(connectedMap()).resolves.toMatchObject({ anthropic: true });
      expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    } finally {
      setNativeProviderClaimListener(null);
    }
  });

  it('不受信 sender(含 device-link 合成 event)只读,不触发认领与清单拉取', async () => {
    // 这条通道也服务 device-link 与可能不受信的渲染上下文:它们只该拿到只读快照,
    // 不该顺带写绑定文件、改动清单(PR #548 review)。
    const connected = await connectedMap(false);
    expect(connected.anthropic).toBe(false);
    expect(connected.xai).toBe(false);
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(h.loadAnthropicDiskCache).not.toHaveBeenCalled();

    // 本机主页面读一次即恢复自愈。
    expect((await connectedMap(true)).anthropic).toBe(true);
    await vi.waitFor(() => expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1));
  });

  it('openai 同样按 sender 分流:不受信只读,不触发 reconcile 的硬链与绑定写入', async () => {
    // hasCodexOAuthLogin 会经 getAccessToken 走 reconcileWithSystemCodex —— 建凭证硬链 +
    // 为首个 owner 补写绑定。判据不是「有没有发上游请求」,而是「不受信 sender 能不能引发
    // 特权状态变更」(PR #548 review)。
    await connectedMap(false);
    expect(h.codexLoginReadOnly).toHaveBeenCalled();
    expect(h.codexLoginWithSideEffects).not.toHaveBeenCalled();

    await connectedMap(true);
    expect(h.codexLoginWithSideEffects).toHaveBeenCalled();
  });

  it('凭证不在本机时既不认领也不误报已连接', async () => {
    h.claudeCredentialPresent = false;
    h.grokCredentialPresent = false;

    const connected = await connectedMap();
    expect(connected.anthropic).toBe(false);
    expect(connected.xai).toBe(false);
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(h.loadAnthropicDiskCache).not.toHaveBeenCalled();
  });

  it('anthropic 没有 HTTP 清单发现通道,ProviderView 不带发现失败态', async () => {
    const providers = await listProviders();
    const anthropic = providers.find((p) => p.id === 'anthropic');
    expect(anthropic?.connected).toBe(true);
    expect(anthropic?.modelDiscoveryFailure).toBeUndefined();
  });

  it('凭证已属于别的 owner 时保持 fail-closed', async () => {
    fs.writeFileSync(
      path.join(h.userDataDir, 'native-provider-auth.json'),
      JSON.stringify({ anthropic: 'owner-b', legacyClaimOwner: 'owner-b' }),
    );

    const connected = await connectedMap();
    expect(connected.anthropic).toBe(false);
    expect(h.loadAnthropicDiskCache).not.toHaveBeenCalled();
  });

  it('durable disconnect 后即使本机 Claude 凭证仍在，也不绑定、不发现、不回灌', async () => {
    fs.writeFileSync(
      path.join(h.userDataDir, 'native-provider-auth.json'),
      JSON.stringify({ revoked: { anthropic: 'owner-a' } }),
    );

    const connected = await connectedMap();
    expect(connected.anthropic).toBe(false);
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(h.loadAnthropicDiskCache).not.toHaveBeenCalled();
  });
});
