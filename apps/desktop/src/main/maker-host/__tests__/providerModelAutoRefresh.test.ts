import { describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';
import type { BuiltinRefreshableProviderId } from '../../../shared/providerModelRefresh.js';

import {
  createAppFocusAutoRefreshTracker,
  createProviderModelRefreshCoordinator,
  PROVIDER_MODEL_AUTO_REFRESH_COOLDOWN_MS,
  PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS,
  PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS,
} from '../provider-model-auto-refresh.js';

function view(
  id: string,
  connected: boolean,
  source: 'builtin' | 'user' = 'builtin',
): ProviderView {
  return { id, connected, source } as unknown as ProviderView;
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('provider model auto-refresh coordinator', () => {
  it('refreshes the shared Catalog after cooldown even when xAI is disconnected', async () => {
    let now = 1_000;
    const refreshCatalog = vi.fn(async () => undefined);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders: async () => [
        view('openai', true),
        view('xai', false),
      ],
      refreshProvider: vi.fn(async () => undefined),
      refreshCatalog,
      now: () => now,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    // Splash 已取过公共 Catalog；startup 不重复请求，并给失败恢复留 5 分钟宽限。
    await coordinator.requestAutoRefresh('startup');
    expect(refreshCatalog).not.toHaveBeenCalled();
    await coordinator.requestAutoRefresh('providers-open');
    expect(refreshCatalog).not.toHaveBeenCalled();

    now += PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS;
    await coordinator.requestAutoRefresh('model-selector-open');
    expect(refreshCatalog).toHaveBeenCalledOnce();
    await coordinator.requestAutoRefresh('foreground');
    expect(refreshCatalog).toHaveBeenCalledOnce();
  });

  it('refreshes connected xAI media separately from the shared Catalog', async () => {
    let now = 1_000;
    const refreshCatalog = vi.fn(async () => undefined);
    const refreshProvider = vi.fn(async () => undefined);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders: async () => [view('xai', true)],
      refreshProvider,
      refreshCatalog,
      now: () => now,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    // Splash already loaded the public Catalog, but account-scoped media discovery still runs.
    await coordinator.requestAutoRefresh('startup');
    expect(refreshCatalog).not.toHaveBeenCalled();
    expect(refreshProvider).toHaveBeenCalledOnce();
    expect(refreshProvider).toHaveBeenCalledWith('xai');

    now += PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS;
    await coordinator.requestAutoRefresh('foreground');
    expect(refreshCatalog).toHaveBeenCalledOnce();
    // provider 自己的上次成功快照仍在 30 分钟冷却内，不重复打 xAI 账号端点。
    expect(refreshProvider).toHaveBeenCalledOnce();

    // Manual xAI refresh updates both the shared Catalog and account-scoped media snapshot.
    await coordinator.refreshManually('xai');
    expect(refreshCatalog).toHaveBeenCalledTimes(2);
    expect(refreshProvider).toHaveBeenCalledTimes(2);
  });

  it('refreshes only connected built-ins and applies a per-provider cooldown', async () => {
    let now = 1_000;
    const refreshProvider =
      vi.fn<(providerId: BuiltinRefreshableProviderId) => Promise<void>>();
    refreshProvider.mockResolvedValue(undefined);
    const listProviders = vi.fn(async (_options: { allowSideEffects: true }) => [
      view('xd', true),
      view('anthropic', true),
      view('openai', false),
      view('custom-provider', true),
      view('xai', true, 'user'),
    ]);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders,
      refreshProvider,
      now: () => now,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    await coordinator.requestAutoRefresh('providers-open');
    expect(listProviders).toHaveBeenLastCalledWith({ allowSideEffects: true });
    expect(refreshProvider.mock.calls.map(([id]) => id)).toEqual(['xd', 'anthropic']);

    await coordinator.requestAutoRefresh('model-selector-open');
    expect(refreshProvider).toHaveBeenCalledTimes(2);

    now += PROVIDER_MODEL_AUTO_REFRESH_COOLDOWN_MS;
    await coordinator.requestAutoRefresh('foreground');
    expect(refreshProvider.mock.calls.map(([id]) => id)).toEqual([
      'xd',
      'anthropic',
      'xd',
      'anthropic',
    ]);
  });

  it('applies the shared Catalog before provider discovery derives model capabilities', async () => {
    const catalog = deferred();
    const refreshProvider = vi.fn(async () => undefined);
    const refreshCatalog = vi.fn(() => catalog.promise);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders: async () => [view('anthropic', true)],
      refreshProvider,
      refreshCatalog,
      now: () => 1_000,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    const refresh = coordinator.requestAutoRefresh('providers-open');
    await vi.waitFor(() => expect(refreshCatalog).toHaveBeenCalledOnce());
    expect(refreshProvider).not.toHaveBeenCalled();

    catalog.resolve();
    await refresh;
    expect(refreshProvider).toHaveBeenCalledOnce();
  });

  it('honors an explicit provider filter without waiting on unrelated sources', async () => {
    const refreshProvider = vi.fn(async (_providerId: BuiltinRefreshableProviderId) => {});
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders: async () => [
        view('xd', true),
        view('anthropic', true),
        view('openai', true),
        view('xai', true),
      ],
      refreshProvider,
      now: () => 1_000,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    await coordinator.requestAutoRefresh('startup', ['anthropic']);
    expect(refreshProvider).toHaveBeenCalledOnce();
    expect(refreshProvider).toHaveBeenCalledWith('anthropic');
  });

  it('manual refresh queues behind an automatic flight instead of being represented by it', async () => {
    // 行为变更（PR #1076 review，与 forced startup 同一个不变量）：手动刷新也是 forced
    // 请求，撞上**非强制**在途时不再合并进去，而是排在它后面真跑一次。
    //
    // 理由与 startup 那条完全一致：用户点「获取模型列表」要的是这一刻的最新清单。合并到一次
    // 早于点击发起的 auto refresh，用户可能拿到几秒前的结果；那次 auto 若因凭证未就绪失败，
    // 他点了刷新却什么也没刷到。forced 请求不该被非 forced 的在途结果代表。
    const first = deferred();
    const refreshProvider = vi
      .fn<(providerId: 'xd' | 'anthropic' | 'openai' | 'xai') => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders: async () => [view('xd', true)],
      refreshProvider,
      now: () => 10_000,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    const automatic = coordinator.requestAutoRefresh('providers-open');
    await vi.waitFor(() => expect(refreshProvider).toHaveBeenCalledOnce());
    // 排队期间不重复 spawn —— in-flight 合并的收益仍在。
    const manualQueued = coordinator.refreshManually('xd');
    expect(refreshProvider).toHaveBeenCalledOnce();

    first.resolve();
    await Promise.all([automatic, manualQueued]);
    // auto settle 后手动那次真跑了。
    expect(refreshProvider).toHaveBeenCalledTimes(2);

    // 冷却仍挡住普通自动触发。
    await coordinator.requestAutoRefresh('model-selector-open');
    expect(refreshProvider).toHaveBeenCalledTimes(2);

    // 手动刷新照旧绕过冷却。
    await coordinator.refreshManually('xd');
    expect(refreshProvider).toHaveBeenCalledTimes(3);
  });

  it('starts fresh work after an account scope change and ignores stale failures', async () => {
    let now = 1_000;
    let scope = 1;
    const first = deferred();
    const refreshProvider = vi
      .fn<(providerId: BuiltinRefreshableProviderId) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders: async () => [view('openai', true)],
      refreshProvider,
      getScopeKey: () => scope,
      now: () => now,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    const oldAccountRefresh = coordinator.requestAutoRefresh('providers-open');
    await vi.waitFor(() => expect(refreshProvider).toHaveBeenCalledOnce());

    scope = 2;
    await coordinator.requestAutoRefresh('model-selector-open');
    expect(refreshProvider).toHaveBeenCalledTimes(2);

    first.reject(new Error('old account failed late'));
    await oldAccountRefresh;

    now += PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS;
    await coordinator.requestAutoRefresh('foreground');
    expect(refreshProvider).toHaveBeenCalledTimes(2);
  });

  it('lets the startup trigger bypass the cooldown so a first run is not stuck on a stale snapshot', async () => {
    // 回归全新机器首启：splash 期那次自动刷新跑在「owner 绑定还没认领、网关凭证还没下发」
    // 之前，什么都发现不到，却已经吃掉 30 分钟冷却。账号就绪后的 startup 触发必须强制放行，
    // 否则清单要等用户去打开设置页 / 模型选择器才更新。
    const now = 1_000;
    const refreshProvider =
      vi.fn<(providerId: BuiltinRefreshableProviderId) => Promise<void>>();
    refreshProvider.mockResolvedValue(undefined);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders: async () => [view('openai', true), view('xd', true)],
      refreshProvider,
      now: () => now,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    await coordinator.requestAutoRefresh('foreground');
    expect(refreshProvider.mock.calls.map(([id]) => id)).toEqual(['xd', 'openai']);

    // 冷却内的普通触发照旧被挡。
    await coordinator.requestAutoRefresh('model-selector-open');
    expect(refreshProvider).toHaveBeenCalledTimes(2);

    await coordinator.requestAutoRefresh('startup');
    expect(refreshProvider.mock.calls.map(([id]) => id)).toEqual([
      'xd',
      'openai',
      'xd',
      'openai',
    ]);
  });

  it('still merges concurrent startup work instead of spawning one refresh per trigger', async () => {
    // 强制放行不等于放弃 in-flight 合并 —— openai 的刷新会起 codex app-server，
    // 启动期几个触发同时到达时绝不能各起一个。
    const first = deferred();
    const refreshProvider = vi
      .fn<(providerId: BuiltinRefreshableProviderId) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders: async () => [view('openai', true)],
      refreshProvider,
      now: () => 5_000,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    const a = coordinator.requestAutoRefresh('startup');
    await vi.waitFor(() => expect(refreshProvider).toHaveBeenCalledOnce());
    const b = coordinator.requestAutoRefresh('startup');
    expect(refreshProvider).toHaveBeenCalledOnce();

    first.resolve();
    await Promise.all([a, b]);
    expect(refreshProvider).toHaveBeenCalledOnce();
  });

  it('forced startup 撞上非强制在途时排在它后面真跑一次,而不是合并进去', async () => {
    // 回归 PR #1076 review:refresh() 在检查 force 之前就 return existing.promise。
    // splash 期那次非强制刷新往往跑在 owner 绑定认领、网关凭证下发之前,什么都发现不到;
    // 强制请求合并进去等于这次刷新从未发生,首启清单不全原样保留到下一个触发时机。
    const first = deferred();
    const refreshProvider = vi
      .fn<(providerId: BuiltinRefreshableProviderId) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders: async () => [view('openai', true)],
      refreshProvider,
      now: () => 1_000,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    // splash 期的非强制刷新(发现不到东西)。
    const early = coordinator.requestAutoRefresh('foreground');
    await vi.waitFor(() => expect(refreshProvider).toHaveBeenCalledOnce());

    // 账号就绪后的强制刷新:此刻必须排队,不能合并。
    const forced = coordinator.requestAutoRefresh('startup');
    expect(refreshProvider).toHaveBeenCalledOnce();

    first.resolve();
    await Promise.all([early, forced]);
    // 等前一次 settle 后真跑了第二次 —— 冷却在同一时刻本会挡住它,force 让它过。
    expect(refreshProvider).toHaveBeenCalledTimes(2);
  });

  it('前一次强制在途时,后来的强制请求照常合并(同语义不重复 spawn)', async () => {
    const first = deferred();
    const refreshProvider = vi
      .fn<(providerId: BuiltinRefreshableProviderId) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders: async () => [view('openai', true)],
      refreshProvider,
      now: () => 1_000,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    const a = coordinator.requestAutoRefresh('startup');
    await vi.waitFor(() => expect(refreshProvider).toHaveBeenCalledOnce());
    const b = coordinator.requestAutoRefresh('startup');
    first.resolve();
    await Promise.all([a, b]);
    expect(refreshProvider).toHaveBeenCalledOnce();
  });

  it('非强制在途失败时,排队的强制请求仍会跑', async () => {
    const first = deferred();
    const refreshProvider = vi
      .fn<(providerId: BuiltinRefreshableProviderId) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders: async () => [view('openai', true)],
      refreshProvider,
      now: () => 1_000,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    const early = coordinator.requestAutoRefresh('foreground');
    await vi.waitFor(() => expect(refreshProvider).toHaveBeenCalledOnce());
    const forced = coordinator.requestAutoRefresh('startup');
    first.reject(new Error('splash-time attempt failed'));
    await Promise.all([early, forced]);
    expect(refreshProvider).toHaveBeenCalledTimes(2);
  });

  it('swallows and logs automatic listing/source failures', async () => {
    const warn = vi.fn();
    let now = 0;
    const sourceFailure = createProviderModelRefreshCoordinator({
      listProviders: async () => [view('xai', true)],
      refreshProvider: async () => {
        throw new Error('catalog unavailable');
      },
      now: () => now,
      log: { debug: vi.fn(), warn },
    });
    await expect(sourceFailure.requestAutoRefresh('foreground')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'provider model auto-refresh failed',
      expect.objectContaining({ providerId: 'xai', trigger: 'foreground' }),
    );
    now += PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS - 1;
    await sourceFailure.requestAutoRefresh('system-resume');
    expect(warn).toHaveBeenCalledTimes(1);
    now += 1;
    await sourceFailure.requestAutoRefresh('screen-unlock');
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockClear();
    const listingFailure = createProviderModelRefreshCoordinator({
      listProviders: async () => {
        throw new Error('registry unavailable');
      },
      refreshProvider: vi.fn(async () => {}),
      now: () => 0,
      log: { debug: vi.fn(), warn },
    });
    await expect(listingFailure.requestAutoRefresh('providers-open')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'provider model auto-refresh could not list providers',
      expect.objectContaining({ trigger: 'providers-open' }),
    );
  });
});

describe('app focus auto-refresh tracker', () => {
  it('only emits after a false-to-true transition beyond the background threshold', () => {
    let now = 0;
    const onMeaningfulForeground = vi.fn();
    const tracker = createAppFocusAutoRefreshTracker({
      now: () => now,
      onMeaningfulForeground,
    });

    tracker.sync(true);
    tracker.sync(true);
    tracker.sync(false);
    now += PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS - 1;
    tracker.sync(true);
    expect(onMeaningfulForeground).not.toHaveBeenCalled();

    tracker.sync(false);
    now += PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS;
    tracker.sync(true);
    tracker.sync(true);
    expect(onMeaningfulForeground).toHaveBeenCalledOnce();
  });

  it('does not treat the first focused observation as a foreground return', () => {
    const onMeaningfulForeground = vi.fn();
    const tracker = createAppFocusAutoRefreshTracker({
      now: () => PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS * 10,
      onMeaningfulForeground,
    });

    tracker.sync(true);
    expect(onMeaningfulForeground).not.toHaveBeenCalled();
  });
});
