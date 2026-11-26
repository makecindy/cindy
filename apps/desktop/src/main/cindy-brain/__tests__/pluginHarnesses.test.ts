import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { validateGhostManifest, type InstalledGhost } from '../../../shared/ghost.js';
import type { NodeWorkerProcess } from '../nodeRuntimeBroker.js';
import {
  configurePluginHarnessRegistry,
  createPluginHarnessRegistry,
  PLUGIN_HARNESS_REFRESH_COOLDOWN_MS,
  PLUGIN_USAGE_WORKER_FAILURE,
  requestPluginHarnessRefresh,
  resetPluginHarnessRefreshForTests,
  type PluginHarnessRegistryDeps,
} from '../pluginHarnesses.js';

/*
 * 测试价值
 * - 生产入口与可观察结果：createPluginHarnessRegistry（生产单例同一实现）的 list / onChange / spawn——
 *   第 3 步模型选择器与 ACP 引擎看到哪些引擎、什么名字和状态，以及能否启动。
 * - Bug／规则依据：docs/plans/acp-plugin-bridge.md「主进程注册表」（只列已启用 + 已批准 + 已声明 +
 *   协议已支持；名称按界面语言；未发布 = unknown；不在列表或不可用即拒绝启动）；
 *   plugin-security-and-authoring.md §5（旧 receipt 缺批准事实不得生效）。
 * - 现有覆盖缺口：新模块。
 * - 最小失败输入：receipt 没有 approvedHarnesses 的已启用插件；已发布 available:false 的引擎。
 * - tier：unit（内存依赖）。实测耗时：< 1s。
 */
const harness = {
  id: 'dsh', name: 'DeepSeek Harness', description: 'Local agent', protocol: 'acp', entry: 'engine.js',
  locales: { 'zh-CN': { name: '深度求索 Harness', description: '本机 Agent' } },
};

function ghost(overrides: Partial<InstalledGhost> = {}, harnesses: unknown[] = [harness], id = 'dsh-plugin'): InstalledGhost {
  const parsed = validateGhostManifest({
    schemaVersion: 3, minCindyVersion: '0.1.61', id, name: 'DSH', version: '1.0.0', entry: 'main.js',
    node: { entry: 'worker.js', protocol: 'json-rpc-stdio', entries: ['engine.js'] }, harnesses,
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  return {
    manifest: parsed.manifest, dir: `/plugins/${id}`, enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    approvedHarnesses: ['dsh'], ...overrides,
  };
}

const NO_USAGE_CACHE_TIMING = {
  activeThrottleMs: 0,
  idleThrottleMs: 0,
  resetMinIntervalMs: 0,
  failureBackoffInitialMs: 0,
  failureBackoffMaxMs: 0,
} as const;

function setup(
  ghosts: InstalledGhost[],
  published: Record<string, unknown> = {},
  locale = 'en',
  extraDeps: Partial<PluginHarnessRegistryDeps> = {},
) {
  const process = {} as NodeWorkerProcess;
  let list = ghosts;
  let stored = published;
  let uiLocale = locale;
  const deps: PluginHarnessRegistryDeps = {
    listGhosts: () => list,
    isAvailable: (id) => id !== 'account-only',
    readAvailability: () => stored,
    uiLocale: () => uiLocale,
    spawn: vi.fn(async () => process),
    ...extraDeps,
  };
  const registry = createPluginHarnessRegistry(deps);
  return {
    registry, deps, process,
    setGhosts: (next: InstalledGhost[]) => { list = next; },
    publish: (value: Record<string, unknown>) => { stored = value; },
    setLocale: (value: string) => { uiLocale = value; },
  };
}

describe('plugin harness registry', () => {
  // Account data belongs only to the approved engine. A worker can return extra private fields,
  // or outlive revocation while its provider request is in flight. Exercise the production read.
  it('reads only opted-in engines and drops private or late account data', async () => {
    const { registry, deps, publish, setGhosts } = setup([ghost()], {}, 'en', { usageTiming: NO_USAGE_CACHE_TIMING });
    const key = 'dsh-plugin:dsh';
    const row = { currency: 'CNY', amount: '0.00' };
    const read = vi.fn(async () => ({ updatedAt: 1234, balances: [{ ...row, account: 'private' }] }));
    deps.readUsage = read;
    expect(await registry.readUsage(key)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    publish({ harnesses: [{ id: 'dsh', available: true, reportsUsage: true }] });
    expect(await registry.readUsage('dsh-plugin:other')).toBeNull();
    expect(await registry.readUsage(key)).toEqual({ updatedAt: 1234, balances: [row] });
    expect(read).toHaveBeenCalledExactlyOnceWith('dsh-plugin', 'dsh');
    deps.readUsage = async () => ({ updatedAt: 1234, windows: [{ label: 'Week', remainingPercent: -1 }] });
    expect(await registry.readUsage(key)).toBeNull();
    deps.readUsage = async () => {
      setGhosts([ghost({ approvedHarnesses: [] })]);
      return { updatedAt: 1234, balances: [row] };
    };
    expect(await registry.readUsage(key)).toBeNull();
  });

  it('reports retryable worker failures only to remote readers of a still-approved engine', async () => {
    const { registry, deps, publish, setGhosts } = setup([ghost()], {}, 'en', { usageTiming: NO_USAGE_CACHE_TIMING });
    publish({ harnesses: [{ id: 'dsh', available: true, reportsUsage: true }] });
    const key = 'dsh-plugin:dsh';
    const remote = { reportWorkerFailure: true };
    deps.readUsage = async () => null;
    expect(await registry.readUsage(key, undefined, remote)).toBeNull();
    deps.readUsage = async () => PLUGIN_USAGE_WORKER_FAILURE;
    expect(await registry.readUsage(key)).toBeNull();
    await expect(registry.readUsage(key, undefined, remote)).rejects.toThrow('Plugin usage worker unavailable');
    deps.readUsage = async () => {
      setGhosts([ghost({ approvedHarnesses: [] })]);
      return PLUGIN_USAGE_WORKER_FAILURE;
    };
    expect(await registry.readUsage(key, undefined, remote)).toBeNull();
  });

  // Host-level adaptive usage caching: protects plugin CLI/API workers across all surfaces
  // (menubar, widget, composer chip, remote device-link) with 45m idle / 10m active / 5m reset
  // recheck, in-flight dedup, failure backoff, owner isolation, and immediate revocation eviction.
  it('caches and adaptively throttles plugin usage across idle, active, reset, force, and login transitions', async () => {
    let now = 1_000_000;
    let ownerScope = 'owner-a:1';
    const resetAt = now + 15 * 60_000;
    const usage = (remainingPercent: number) => ({
      updatedAt: now,
      windows: [{ label: '5h', remainingPercent, resetsAt: resetAt }],
    });
    const read = vi.fn(async () => usage(80));
    const callAccount = vi.fn(async () => ({ ok: true }));
    const { registry, publish, setGhosts } = setup(
      [ghost()],
      { harnesses: [{ id: 'dsh', available: true, reportsUsage: true, accounts: { methods: [{ id: 'api-key', label: 'Key', kind: 'secret' }] } }] },
      'en',
      { now: () => now, ownerScopeKey: () => ownerScope, readUsage: read, callAccount },
    );
    const key = 'dsh-plugin:dsh';

    // Concurrent calls share one in-flight worker request.
    let release!: (value: ReturnType<typeof usage>) => void;
    const initial = usage(80);
    read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const [p1, p2] = [registry.readUsage(key), registry.readUsage(key)];
    release(initial);
    expect(await Promise.all([p1, p2])).toEqual([initial, initial]);
    expect(read).toHaveBeenCalledTimes(1);

    // Idle reads within 45m (before resetAt) reuse cached snapshot.
    now += 10 * 60_000;
    expect(await registry.readUsage(key)).toEqual(initial);
    expect(read).toHaveBeenCalledTimes(1);

    // Crossing resetAt (+15m, age >= 5m) rechecks once even while idle.
    now += 5 * 60_000;
    const afterReset = usage(100);
    read.mockResolvedValueOnce(afterReset);
    expect(await registry.readUsage(key)).toEqual(afterReset);
    expect(read).toHaveBeenCalledTimes(2);

    // After crossing reset, idle reads stay cached for 45m.
    now += 44 * 60_000;
    expect(await registry.readUsage(key)).toEqual(afterReset);
    expect(read).toHaveBeenCalledTimes(2);

    // Real task activity switches to the 10m active tier (already >= 10m since last refresh).
    registry.recordActivity(key);
    const afterActivity1 = usage(70);
    read.mockResolvedValueOnce(afterActivity1);
    expect(await registry.readUsage(key)).toEqual(afterActivity1);
    expect(read).toHaveBeenCalledTimes(3);

    // Further activity within 10m stays throttled until 10m elapses.
    now += 9 * 60_000;
    registry.recordActivity(key);
    expect(await registry.readUsage(key)).toEqual(afterActivity1);
    expect(read).toHaveBeenCalledTimes(3);
    now += 60_000;
    const afterActivity2 = usage(60);
    read.mockResolvedValueOnce(afterActivity2);
    expect(await registry.readUsage(key)).toEqual(afterActivity2);
    expect(read).toHaveBeenCalledTimes(4);

    // Manual force respects the 15s cooldown, then bypasses adaptive TTL.
    now += 10_000;
    expect(await registry.readUsage(key, undefined, { force: true })).toEqual(afterActivity2);
    expect(read).toHaveBeenCalledTimes(4);
    now += 5_000;
    const afterForce = usage(55);
    read.mockResolvedValueOnce(afterForce);
    expect(await registry.readUsage(key, undefined, { force: true })).toEqual(afterForce);
    expect(read).toHaveBeenCalledTimes(5);

    // Login invalidates cached usage immediately.
    await registry.loginAccount(key, undefined, 'api-key', 'sk-new');
    const afterLogin = usage(95);
    read.mockResolvedValueOnce(afterLogin);
    expect(await registry.readUsage(key)).toEqual(afterLogin);
    expect(read).toHaveBeenCalledTimes(6);

    // Owner switch isolates and clears cache.
    ownerScope = 'owner-b:2';
    const afterOwner = usage(42);
    read.mockResolvedValueOnce(afterOwner);
    expect(await registry.readUsage(key)).toEqual(afterOwner);
    expect(read).toHaveBeenCalledTimes(7);

    // Revocation immediately stops returning cached account data.
    setGhosts([ghost({ approvedHarnesses: [] })]);
    expect(await registry.readUsage(key)).toBeNull();
    publish({ harnesses: [{ id: 'dsh', available: true, reportsUsage: true }] });
    setGhosts([ghost()]);
    // Re-enabling starts fresh (cache was evicted on revocation).
    const afterReenable = usage(88);
    read.mockResolvedValueOnce(afterReenable);
    expect(await registry.readUsage(key)).toEqual(afterReenable);
    expect(read).toHaveBeenCalledTimes(8);
  });

  it('backs off exponentially on plugin usage worker failures and preserves last known snapshot locally', async () => {
    let now = 1_000_000;
    const good = { updatedAt: now, balances: [{ currency: 'USD', amount: '12.00' }] };
    const read = vi.fn()
      .mockResolvedValueOnce(good)
      .mockResolvedValueOnce(PLUGIN_USAGE_WORKER_FAILURE)
      .mockResolvedValueOnce(PLUGIN_USAGE_WORKER_FAILURE)
      .mockResolvedValueOnce({ updatedAt: now + 99, balances: [{ currency: 'USD', amount: '11.00' }] });
    const { registry } = setup(
      [ghost()],
      { harnesses: [{ id: 'dsh', available: true, reportsUsage: true }] },
      'en',
      { now: () => now, readUsage: read },
    );
    const key = 'dsh-plugin:dsh';

    expect(await registry.readUsage(key)).toEqual(good);
    // Advance past 45m idle TTL -> worker failure keeps last good snapshot locally and backs off 10m.
    now += 45 * 60_000;
    expect(await registry.readUsage(key)).toEqual(good);
    expect(read).toHaveBeenCalledTimes(2);

    // Inside 10m backoff: remote caller still learns worker failed without hitting worker again.
    now += 9 * 60_000;
    await expect(registry.readUsage(key, undefined, { reportWorkerFailure: true }))
      .rejects.toThrow('Plugin usage worker unavailable');
    expect(await registry.readUsage(key)).toEqual(good);
    expect(read).toHaveBeenCalledTimes(2);

    // At +10m: retries once, fails -> doubles backoff to 20m.
    now += 60_000;
    expect(await registry.readUsage(key)).toEqual(good);
    expect(read).toHaveBeenCalledTimes(3);
    now += 19 * 60_000;
    expect(await registry.readUsage(key)).toEqual(good);
    expect(read).toHaveBeenCalledTimes(3);

    // At +20m: succeeds and clears backoff.
    now += 60_000;
    expect(await registry.readUsage(key)).toMatchObject({ balances: [{ amount: '11.00' }] });
    expect(read).toHaveBeenCalledTimes(4);
  });

  // 引擎账号(subscription-account-pools.md 插件引擎的账号)：账号目录只给声明了登录方式的引擎，且只能是 Cindy
  // 为这个引擎建的目录；Key 只交给要求 Key 的方式。最小失败输入：没声明账号的引擎带账号目录启动；目录在根之外。
  it('starts an engine on an account directory only when its plugin keeps accounts apart', async () => {
    const root = path.resolve('/data/owners/u/plugin-engine-accounts/dsh-plugin/dsh');
    const account = path.join(root, 'cindy-0123456789ab-00000000-0000-4000-8000-00000000000a');
    const r = setup([ghost()], { harnesses: [{ id: 'dsh', available: true }] });
    r.deps.accountRoot = () => root;
    const call = vi.fn(async (_ghost: string, method: string) => method === 'accountLogin' ? { ok: true } : { state: 'signed-in', identity: { email: 'a@example.com' }, token: 'x' });
    r.deps.callAccount = call;
    await expect(r.registry.spawn('dsh-plugin:dsh', { accountDir: account })).rejects.toThrow('cannot run on this account');
    expect(await r.registry.readAccountStatus('dsh-plugin:dsh')).toBeNull();

    r.publish({ harnesses: [{ id: 'dsh', available: true, accounts: { methods: [{ id: 'api-key', label: 'API Key', kind: 'secret' }] } }] });
    r.registry.reconcile();
    await expect(r.registry.spawn('dsh-plugin:dsh', { accountDir: path.join(root, '..', 'other') })).rejects.toThrow('cannot run on this account');
    await expect(r.registry.spawn('dsh-plugin:dsh', { accountDir: account })).resolves.toBe(r.process);
    expect(r.deps.spawn).toHaveBeenLastCalledWith('dsh-plugin', 'dsh', { accountDir: account });
    // Only display fields of the status leave the worker.
    expect(await r.registry.readAccountStatus('dsh-plugin:dsh', account)).toEqual({ state: 'signed-in', identity: { email: 'a@example.com' } });
    expect(await r.registry.loginAccount('dsh-plugin:dsh', account, 'api-key')).toEqual({ ok: false, error: 'invalid-secret' });
    expect(await r.registry.loginAccount('dsh-plugin:dsh', account, 'api-key', 'sk-1')).toEqual({ ok: true });
    expect(call).toHaveBeenLastCalledWith('dsh-plugin', 'accountLogin',
      { harnessId: 'dsh', accountDir: account, methodId: 'api-key', secret: 'sk-1' }, expect.objectContaining({ maxTotalMs: expect.any(Number) }));
  });

  it('lists only enabled, approved, declared, receipt-approved engines with a known protocol', () => {
    const { registry } = setup([
      ghost(),
      ghost({ enabled: false }, [harness], 'disabled'),
      ghost({ approval: { state: 'legacy-unapproved' } }, [harness], 'unapproved'),
      ghost({ approvedHarnesses: undefined }, [harness], 'old-receipt'),
      ghost({}, [{ ...harness, protocol: 'acp/2' }], 'future-protocol'),
      ghost({}, [harness], 'account-only'),
    ]);
    expect(registry.list()).toEqual([{
      key: 'dsh-plugin:dsh', ghostId: 'dsh-plugin', harnessId: 'dsh', name: 'DeepSeek Harness',
      description: 'Local agent', protocol: 'acp', availability: { state: 'unknown' },
    }]);
  });

  it('localizes names and reports published availability', () => {
    const { registry } = setup([ghost()], {
      harnesses: [{ id: 'dsh', available: false, reason: 'not-installed', message: 'npm i -g @deepseek-ai/dsh' }],
    }, 'zh-CN');
    expect(registry.list()).toMatchObject([{ name: '深度求索 Harness', description: '本机 Agent',
      availability: { state: 'unavailable', reason: 'not-installed', message: 'npm i -g @deepseek-ai/dsh' } }]);
  });

  // 2026-11-18 用户要求：引擎图标由插件定义；模型列表由插件提供，获取与展示同普通供应商。
  it('carries the plugin icon and the models and agent modes the plugin publishes for its engine', () => {
    const models = [{ id: 'v4-pro', name: 'DeepSeek-V4-Pro', group: 'DeepSeek', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }];
    const { registry } = setup([ghost({ iconDataUrl: 'data:image/png;base64,AAAA' })], {
      harnesses: [{ id: 'dsh', available: true, models, modes: ['default', 'plan'], defaultMode: 'default' }],
    });
    expect(registry.list()).toMatchObject([{ iconDataUrl: 'data:image/png;base64,AAAA', models, modes: ['default', 'plan'], defaultMode: 'default' }]);
  });

  it('asks only engine plugins to refresh when a picker opens, at most once per cooldown', () => {
    resetPluginHarnessRefreshForTests();
    const requestRefresh = vi.fn((ghostId: string) => ghostId !== 'offline-plugin');
    configurePluginHarnessRegistry({
      listGhosts: () => [ghost(), ghost({}, [harness], 'offline-plugin'), ghost({ enabled: false }, [harness], 'disabled')],
      isAvailable: () => true,
      readAvailability: () => ({}),
      uiLocale: () => 'en',
      spawn: vi.fn(),
      requestRefresh,
    });
    requestPluginHarnessRefresh(1_000);
    expect(requestRefresh.mock.calls.map(([id]) => id).sort()).toEqual(['dsh-plugin', 'offline-plugin']);
    // Within the cooldown only the plugin whose page was offline is asked again.
    requestPluginHarnessRefresh(1_000 + PLUGIN_HARNESS_REFRESH_COOLDOWN_MS - 1);
    expect(requestRefresh.mock.calls.slice(2).map(([id]) => id)).toEqual(['offline-plugin']);
    requestPluginHarnessRefresh(1_000 + PLUGIN_HARNESS_REFRESH_COOLDOWN_MS);
    expect(requestRefresh.mock.calls.slice(3).map(([id]) => id).sort()).toEqual(['dsh-plugin', 'offline-plugin']);
    // Targeting a single shared plugin never wakes or burns cooldowns on unshared plugins.
    requestPluginHarnessRefresh(1_000 + PLUGIN_HARNESS_REFRESH_COOLDOWN_MS * 2, 'dsh-plugin');
    expect(requestRefresh.mock.calls.slice(5).map(([id]) => id)).toEqual(['dsh-plugin']);
  });

  it('notifies listeners only when a reconcile changes the list', () => {
    const r = setup([]);
    const listener = vi.fn();
    const unsubscribe = r.registry.onChange(listener);
    r.registry.reconcile();
    expect(listener).not.toHaveBeenCalled();
    r.setGhosts([ghost()]);
    r.registry.reconcile();
    expect(listener).toHaveBeenLastCalledWith([expect.objectContaining({ key: 'dsh-plugin:dsh', availability: { state: 'unknown' } })]);
    r.registry.reconcile();
    expect(listener).toHaveBeenCalledTimes(1);
    r.publish({ harnesses: [{ id: 'dsh', available: true, version: '0.2.2' }] });
    r.registry.reconcile();
    expect(listener).toHaveBeenLastCalledWith([expect.objectContaining({ availability: { state: 'available', version: '0.2.2' } })]);
    r.setLocale('zh-CN');
    r.registry.reconcile();
    expect(listener).toHaveBeenLastCalledWith([expect.objectContaining({ name: '深度求索 Harness' })]);
    unsubscribe();
    r.setGhosts([]);
    r.registry.reconcile();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(r.registry.list()).toEqual([]);
  });

  it('starts a listed engine and rejects unknown, revoked or unavailable ones', async () => {
    const r = setup([ghost()]);
    await expect(r.registry.spawn('dsh-plugin:dsh')).resolves.toBe(r.process);
    expect(r.deps.spawn).toHaveBeenCalledWith('dsh-plugin', 'dsh');
    await expect(r.registry.spawn('dsh-plugin:other')).rejects.toThrow('not available');
    // Revocation takes effect at spawn time even before the next roster reconcile.
    r.setGhosts([ghost({ enabled: false })]);
    await expect(r.registry.spawn('dsh-plugin:dsh')).rejects.toThrow('not available');
    r.setGhosts([ghost()]);
    r.publish({ harnesses: [{ id: 'dsh', available: false, message: 'Install DSH first' }] });
    await expect(r.registry.spawn('dsh-plugin:dsh')).rejects.toThrow('Install DSH first');
    expect(r.deps.spawn).toHaveBeenCalledTimes(1);
  });

  // 任务的文件在另一台电脑时，引擎自带的文件与命令工具只会作用在本机。只有插件声明自己能把这些交给 Cindy
  // (remoteWorkspace)才允许这样启动；没声明就启动，Agent 会在错误的电脑上读写(docs/plans/acp-plugin-bridge.md 第三期)。
  // 最小失败输入：未发布 remoteWorkspace 的引擎以远程工作区方式启动。
  it('starts an engine for a task on another computer only when its plugin offers that mode', async () => {
    const r = setup([ghost()], { harnesses: [{ id: 'dsh', available: true }] });
    expect(r.registry.list()[0]).not.toHaveProperty('remoteWorkspace');
    await expect(r.registry.spawn('dsh-plugin:dsh', { remoteWorkspace: true })).rejects.toThrow('another computer');
    expect(r.deps.spawn).not.toHaveBeenCalled();

    r.publish({ harnesses: [{ id: 'dsh', available: true, remoteWorkspace: true }] });
    r.registry.reconcile();
    expect(r.registry.list()[0]).toMatchObject({ remoteWorkspace: true });
    expect(r.registry.list()[0]).not.toHaveProperty('guestWorkspace');
    await expect(r.registry.spawn('dsh-plugin:dsh', { remoteWorkspace: true })).resolves.toBe(r.process);
    expect(r.deps.spawn).toHaveBeenLastCalledWith('dsh-plugin', 'dsh', { remoteWorkspace: true });
    // Cross-account shared tasks additionally require guestWorkspace: true from the plugin.
    await expect(r.registry.spawn('dsh-plugin:dsh', { remoteWorkspace: true, guestWorkspace: true })).rejects.toThrow('shared');
    expect(r.deps.spawn).toHaveBeenCalledTimes(1);

    r.publish({ harnesses: [{ id: 'dsh', available: true, remoteWorkspace: true, guestWorkspace: true }] });
    r.registry.reconcile();
    expect(r.registry.list()[0]).toMatchObject({ remoteWorkspace: true, guestWorkspace: true });
    await expect(r.registry.spawn('dsh-plugin:dsh', { remoteWorkspace: true, guestWorkspace: true })).resolves.toBe(r.process);
    expect(r.deps.spawn).toHaveBeenLastCalledWith('dsh-plugin', 'dsh', { remoteWorkspace: true, guestWorkspace: true });
    // An unavailable engine cannot keep the mode: it is not startable either way.
    r.publish({ harnesses: [{ id: 'dsh', available: false, remoteWorkspace: true, guestWorkspace: true }] });
    r.registry.reconcile();
    expect(r.registry.list()[0]).not.toHaveProperty('remoteWorkspace');
    expect(r.registry.list()[0]).not.toHaveProperty('guestWorkspace');
  });
});
