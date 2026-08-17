/**
 * 连接态读取路径上的 native provider 绑定自愈(anthropic / xai)。
 *
 * 回归的是 #294 同族缺陷的另一半:本机 CLI 凭证的自动继承只在「cloud 模式 + 持有
 * legacy 命名空间认领」时才由一次性迁移建立,local 模式 owner 与没跑到迁移的 cloud
 * owner 永远拿不到 —— 设置页与聊天门禁于是各说各话。anthropic 还多一层:清单唯一
 * 来源是动态发现,绑定建立后不补拉一次就会停在「已连接 + 零模型」。
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
  catalog: null as Catalog | null,
  claudeCredentialPresent: true,
  grokCredentialPresent: true,
  refreshAnthropicModels: vi.fn(async () => true),
  refreshXaiModels: vi.fn(async () => true),
  loadXaiDiskCache: vi.fn(async () => false),
  refreshXaiMediaModels: vi.fn(async () => true),
  loadAnthropicDiskCache: vi.fn(async () => {}),
  codexLoginWithSideEffects: vi.fn(async () => false),
  codexLoginReadOnly: vi.fn(() => false),
  anthropicDiscoveryFailure: null as {
    kind: string;
    at: string;
    detail?: string;
  } | null,
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

// 本机凭证库:*Unbound 是「blob 里有凭证吗」,无绑定语义;带绑定的读取叠加 owner 校验,
// 与真实实现(readClaudeAiOAuth / hasGrokOAuthLogin)的分层一致。
vi.mock('../claude-credentials-store.js', () => ({
  hasClaudeAiOAuthUnbound: () => h.claudeCredentialPresent,
  hasClaudeAiOAuth: () => h.claudeCredentialPresent && isBoundToCurrentOwner('anthropic'),
}));
vi.mock('../grok-oauth-login.js', () => ({
  hasGrokOAuthLoginUnbound: () => h.grokCredentialPresent,
  hasGrokOAuthLogin: () => h.grokCredentialPresent && isBoundToCurrentOwner('xai'),
  getGrokAccessToken: () => null,
  peekGrokAccessToken: () => null,
  resetGrokOAuthMemoryCache: () => {},
}));

vi.mock('../model-discovery/anthropic.js', () => ({
  loadAnthropicModelsFromDiskCache: h.loadAnthropicDiskCache,
  refreshAnthropicModelsFromHttp: h.refreshAnthropicModels,
  getAnthropicModelDiscoveryFailure: () => h.anthropicDiscoveryFailure,
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
    hasCodexOAuthLoginUnbound: () => false,
  },
}));

vi.mock('../../authManager.js', () => ({
  getAuthState: () => ({ mode: 'local' as const, user: null }),
}));
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: false }),
}));
vi.mock('../../ownerNamespaceMigration.js', () => ({ hasLegacyOwnerNamespaceClaim: () => false }));
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
  getProviderSecretStore: () => ({ get: () => null }),
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
  return getDesktopProviderService().listProviders({ allowSideEffects, waitForDiscovery });
}

async function connectedMap(allowSideEffects = true): Promise<Record<string, boolean>> {
  const providers = await listProviders(allowSideEffects);
  return Object.fromEntries(providers.map((p) => [p.id, p.connected]));
}

beforeEach(() => {
  h.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-native-conn-claim-'));
  h.dataOwnerId = 'owner-a';
  h.generation = 1;
  h.catalog = BUNDLED_CATALOG;
  h.claudeCredentialPresent = true;
  h.grokCredentialPresent = true;
  h.anthropicDiscoveryFailure = null;
  h.refreshAnthropicModels.mockClear();
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
  it('认领本机 anthropic 凭证并补拉一次清单(修「已连接 + 零模型」)', async () => {
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);

    expect((await connectedMap()).anthropic).toBe(true);
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    expect(getNativeProviderAuthSource('anthropic')).toBe('native-harness-inherited');
    // 绑定刚建立 —— 启动期那次发现早被登录态 gate 掉,必须在这里补一次。
    expect(h.refreshAnthropicModels).toHaveBeenCalledTimes(1);
    // 磁盘缓存同样要补:启动期那次 load 也因未绑定而早退了。不先摆出上次成功的清单,
    // 这次 HTTP 一旦失败,明明有可用缓存用户还是零模型(PR #548 review)。
    expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1);

    // 已绑定后不再重复认领,也不再反复打网络。
    await connectedMap();
    expect(h.refreshAnthropicModels).toHaveBeenCalledTimes(1);
    expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1);
  });

  it('首次认领要等缓存与 HTTP 清单完成后再返回本次 provider 快照', async () => {
    const anthropic = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'anthropic')!;
    const modelSeed = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'xd')!.models[
      'claude-code'
    ]![0]!;
    const cachedModel = { ...modelSeed, id: 'claude-cached', name: 'Claude Cached' };
    const discoveredModel = { ...modelSeed, id: 'claude-first-fire', name: 'Claude First Fire' };
    const withAnthropicModel = (model: typeof modelSeed): Catalog => ({
      ...BUNDLED_CATALOG,
      providers: BUNDLED_CATALOG.providers.map((provider) =>
        provider.id === anthropic.id
          ? {
              ...provider,
              models: { ...provider.models, 'claude-code': [model] },
            }
          : provider,
      ),
    });
    const cachedCatalog = withAnthropicModel(cachedModel);
    const discoveredCatalog = withAnthropicModel(discoveredModel);
    let releaseCache!: () => void;
    let releaseRefresh!: () => void;
    h.loadAnthropicDiskCache.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCache = () => {
            h.catalog = cachedCatalog;
            resolve();
          };
        }),
    );
    h.refreshAnthropicModels.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseRefresh = () => {
            h.catalog = discoveredCatalog;
            resolve(true);
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
    await vi.waitFor(() => expect(h.refreshAnthropicModels).toHaveBeenCalledTimes(1));
    const settledBeforeRefresh = settled;
    releaseRefresh();

    const providers = await providersPromise;
    expect(settledBeforeCache).toBe(false);
    expect(settledBeforeRefresh).toBe(false);
    expect(providers.find((provider) => provider.id === 'anthropic')?.connected).toBe(true);
    expect(
      providers.find((provider) => provider.id === 'anthropic')?.models['claude-code'],
    ).toEqual([discoveredModel]);
  });

  it('普通可信 provider read 不等待首次清单网络，仍先返回 connected + LKG', async () => {
    let releaseCache!: () => void;
    let releaseRefresh!: () => void;
    h.loadAnthropicDiskCache.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCache = resolve;
        }),
    );
    h.refreshAnthropicModels.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseRefresh = () => resolve(true);
        }),
    );

    const providers = await listProviders();
    expect(providers.find((provider) => provider.id === 'anthropic')?.connected).toBe(true);
    await vi.waitFor(() => expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1));

    releaseCache();
    await vi.waitFor(() => expect(h.refreshAnthropicModels).toHaveBeenCalledTimes(1));
    releaseRefresh();
    await listProviders(true, true);
  });

  it('fresh routing read 在 HTTP 失败时仍返回缓存 LKG 与 connected 状态', async () => {
    const anthropic = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'anthropic')!;
    const modelSeed = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'xd')!.models[
      'claude-code'
    ]![0]!;
    const cachedModel = { ...modelSeed, id: 'claude-cached', name: 'Claude Cached' };
    h.catalog = {
      ...BUNDLED_CATALOG,
      providers: BUNDLED_CATALOG.providers.map((provider) =>
        provider.id === anthropic.id
          ? {
              ...provider,
              models: { ...provider.models, 'claude-code': [cachedModel] },
            }
          : provider,
      ),
    };
    h.refreshAnthropicModels.mockRejectedValueOnce(new Error('network down'));

    const providers = await listProviders(true, true);
    const anthropicView = providers.find((provider) => provider.id === anthropic.id);
    expect(anthropicView?.connected).toBe(true);
    expect(anthropicView?.models['claude-code']).toEqual([cachedModel]);
  });

  it('并发读取要共等首次认领的同一趟清单刷新', async () => {
    let releaseCache!: () => void;
    let releaseRefresh!: () => void;
    h.loadAnthropicDiskCache.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCache = resolve;
        }),
    );
    h.refreshAnthropicModels.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseRefresh = () => resolve(true);
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
    await vi.waitFor(() => expect(h.refreshAnthropicModels).toHaveBeenCalledTimes(1));
    expect(secondSettled).toBe(false);

    releaseRefresh();
    const [firstProviders, secondProviders] = await Promise.all([first, second]);
    expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1);
    expect(h.refreshAnthropicModels).toHaveBeenCalledTimes(1);
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
    let releaseRefresh!: () => void;
    h.loadAnthropicDiskCache.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCache = resolve;
        }),
    );
    h.refreshAnthropicModels.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseRefresh = () => resolve(true);
        }),
    );
    const onClaimed = vi.fn();
    setNativeProviderClaimListener(onClaimed);
    try {
      const providersPromise = listProviders(true, true);
      await vi.waitFor(() => expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1));
      h.generation = 2;
      releaseCache();
      await vi.waitFor(() => expect(h.refreshAnthropicModels).toHaveBeenCalledTimes(1));
      releaseRefresh();
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
    // 不该顺带写绑定文件、读凭证缓存、发起带凭证的上游请求(PR #548 review)。
    const connected = await connectedMap(false);
    expect(connected.anthropic).toBe(false);
    expect(connected.xai).toBe(false);
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(h.refreshAnthropicModels).not.toHaveBeenCalled();
    expect(h.loadAnthropicDiskCache).not.toHaveBeenCalled();

    // 本机主页面读一次即恢复自愈。
    expect((await connectedMap(true)).anthropic).toBe(true);
    await vi.waitFor(() => expect(h.refreshAnthropicModels).toHaveBeenCalledTimes(1));
    expect(h.refreshAnthropicModels).toHaveBeenCalledTimes(1);
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
    expect(h.refreshAnthropicModels).not.toHaveBeenCalled();
  });

  it('清单发现失败时把归因挂到 ProviderView 上(UI 据此讲明理由而非「正在发现」)', async () => {
    h.anthropicDiscoveryFailure = {
      kind: 'network',
      at: '2026-07-27T00:00:00.000Z',
      detail: 'TypeError: fetch failed (ENOTFOUND)',
    };

    const providers = await listProviders();
    const anthropic = providers.find((p) => p.id === 'anthropic');
    expect(anthropic?.connected).toBe(true);
    expect(anthropic?.modelDiscoveryFailure).toMatchObject({ kind: 'network' });
    // 没有失败态的供应商不该凭空长出这个字段。
    expect(providers.find((p) => p.id === 'xai')?.modelDiscoveryFailure).toBeUndefined();
  });

  it('凭证已属于别的 owner 时保持 fail-closed', async () => {
    fs.writeFileSync(
      path.join(h.userDataDir, 'native-provider-auth.json'),
      JSON.stringify({ anthropic: 'owner-b', legacyClaimOwner: 'owner-b' }),
    );

    const connected = await connectedMap();
    expect(connected.anthropic).toBe(false);
    expect(h.refreshAnthropicModels).not.toHaveBeenCalled();
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
    expect(h.refreshAnthropicModels).not.toHaveBeenCalled();
  });
});
