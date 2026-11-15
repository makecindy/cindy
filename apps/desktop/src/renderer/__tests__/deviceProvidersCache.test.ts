/**
 * useDeviceProviders 的 deviceId-aware 缓存单测(device-link「以被控端为准」)。
 * 守住:远程走隧道 maker:provider:list、按 deviceId 隔离、inflight 去重、缓存命中不重拉、
 * evict 只清该设备、evict 在途结果丢弃不复活 —— 与 useAgentCapabilities 同范式。
 * 模块只加载一次；每例通过生产驱逐入口清理缓存。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as providerCache from '@/hooks/useDeviceProviders';
import * as capabilities from '@/hooks/useAgentCapabilities';
import { CONTROLLED_MODEL_CATALOG_CHANNEL, modelCatalogKey } from '../../shared/controlledModelCatalog';
import { refreshRemoteCatalogSnapshot } from '@/lib/remoteCatalogSnapshot';
import { invokeProviderMetadataContinuity, invalidateProviderMetadataContinuity, onProviderMetadataDenied } from '../../main/device-link/providerMetadataContinuity';
vi.mock('../../main/appSessionState.js', () => ({ activeOwnerScopeKey: () => 'catalog-test-owner', isAppSessionBoundaryPending: () => false }));
vi.mock('../../main/clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://catalog.invalid' }));
import {
  connectedProvidersForAgent,
  visibleModelUnion,
  type ProviderView,
} from '@cindy/model-providers';

beforeEach(() => {
  providerCache.evictAllDeviceProviders();
  capabilities.evictAllRemoteCapabilities();
  invalidateProviderMetadataContinuity();
});

// Unit: a direct host cache expiry must not cascade into a routed alias with its own
// budget. Uses the public cache entries and the real SDK expiry; only IPC transport and
// the in-process wall/mono clock are controlled.
it('expires only the direct host entry and keeps a routed alias until its own budget', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  const capsPayload = (label: string, remainingMs: number) => ({
    availableModels: [{ id: 'm', displayName: label, contextWindow: 1, efforts: [], defaultEffort: null }],
    hasFastMode: false, effortLevels: [], permissionModes: [],
    providerContinuity: { stale: false, remainingMs },
  });
  const providerPayload = (label: string, remainingMs: number) => ({
    ...result(label), providerContinuity: { stale: false, remainingMs },
  });
  const invoke = vi.fn(async (device: string, channel: string, args: unknown[]) => {
    const request = args[0] as { op?: string; agentDeviceId?: string; channel?: string } | undefined;
    if (channel === CONTROLLED_MODEL_CATALOG_CHANNEL && request?.op === 'read') {
      if (request.channel === 'maker:provider:list') return providerPayload('sourceB', 2000);
      if (request.channel === 'maker:get-capabilities') return capsPayload('sourceB', 2000);
    }
    if (channel === 'maker:provider:list') return providerPayload('host', 1000);
    if (channel === 'maker:get-capabilities') return capsPayload('host', 1000);
    throw new Error('unexpected channel ' + channel + ' for ' + device);
  });
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  const route = modelCatalogKey('sourceB', 'host')!;
  try {
    await Promise.all([
      providerCache.prefetchDeviceProviders('host'),
      providerCache.prefetchDeviceProviders(route),
      capabilities.prefetchDeviceCapabilities('host'),
      capabilities.prefetchDeviceCapabilities(route),
    ]);
    expect(providerCache.getCachedDeviceProviders('host')?.providers).toHaveLength(1);
    expect(providerCache.getCachedDeviceProviders(route)?.providers).toHaveLength(1);
    expect(capabilities.getCachedCapabilities('claude-code', 'host')).not.toBeNull();
    expect(capabilities.getCachedCapabilities('claude-code', route)).not.toBeNull();
    const readsBefore = invoke.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1001);
    expect(providerCache.getCachedDeviceProviders('host')).toBeNull();
    expect(providerCache.getCachedDeviceProviders(route)?.providers).toHaveLength(1);
    expect(capabilities.getCachedCapabilities('claude-code', 'host')).toBeNull();
    expect(capabilities.getCachedCapabilities('claude-code', route)).not.toBeNull();
    expect(invoke.mock.calls.length).toBe(readsBefore);

    await vi.advanceTimersByTimeAsync(1000);
    expect(providerCache.getCachedDeviceProviders(route)).toBeNull();
    expect(capabilities.getCachedCapabilities('claude-code', route)).toBeNull();
    expect(invoke.mock.calls.length).toBe(readsBefore);
  } finally {
    providerCache.evictAllDeviceProviders();
    capabilities.evictAllRemoteCapabilities();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

/**
 * 测试价值
 * - 生产入口与可观察结果：getCachedDeviceProviders / getCachedCapabilities 在 render 期同步发现过期；
 *   listener 不得在 getter 内同步 setState/fetch，微任务后收到终止事件。
 * - Bug/规则依据：过期缓存通知必须同步 retire + deferred notify；显式撤权保持同步。
 * - 现有覆盖缺口：既有 expiry 用例推进 timer（异步），没有覆盖“timer 未跑、render 读取先观察到 wall expiry”。
 * - 最小失败输入：remainingMs=1000 后只推进 wall 时间，再同步 getter；修复前 listener 同步触发。
 * - tier：unit（jsdom，fake timers）。
 */
it('defers provider and capability listener notifications when a render-time getter observes expiry', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  const capsPayload = {
    availableModels: [{ id: 'm', displayName: 'M', contextWindow: 1, efforts: [], defaultEffort: null }],
    hasFastMode: false, effortLevels: [], permissionModes: [],
    providerContinuity: { stale: false, remainingMs: 1000 },
  };
  const invoke = vi.fn(async (_device: string, channel: string) => channel === 'maker:provider:list'
    ? { ...result('host'), providerContinuity: { stale: false, remainingMs: 1000 } }
    : capsPayload);
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  await providerCache.prefetchDeviceProviders('host');
  await capabilities.prefetchDeviceCapabilities('host');
  const providerEvents = vi.fn();
  const capabilityEvents = vi.fn();
  const offProvider = providerCache.subscribeDeviceProviders('host', providerEvents);
  const offCapability = capabilities.subscribeDeviceCapabilities('host', 'claude-code', capabilityEvents);
  try {
    vi.setSystemTime(Date.now() + 2000);
    expect(providerCache.getCachedDeviceProviders('host')).toBeNull();
    expect(capabilities.getCachedCapabilities('claude-code', 'host')).toBeNull();
    expect(providerEvents).not.toHaveBeenCalled();
    expect(capabilityEvents).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(providerEvents).toHaveBeenCalled();
    expect(capabilityEvents).toHaveBeenCalled();
  } finally {
    offProvider();
    offCapability();
    providerCache.evictAllDeviceProviders();
    capabilities.evictAllRemoteCapabilities();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

// Unit: a direct host expiry must not invalidate a newer in-flight routed alias read.
it('keeps an in-flight routed alias read current when its direct host cache expires', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  const capsPayload = (label: string, remainingMs: number) => ({
    availableModels: [{ id: 'm', displayName: label, contextWindow: 1, efforts: [], defaultEffort: null }],
    hasFastMode: false, effortLevels: [], permissionModes: [],
    providerContinuity: { stale: false, remainingMs },
  });
  const providerPayload = (label: string, remainingMs: number) => ({
    ...result(label), providerContinuity: { stale: false, remainingMs },
  });
  let releaseRoute!: () => void;
  const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve; });
  const invoke = vi.fn(async (_device: string, channel: string, args: unknown[]) => {
    const request = args[0] as { op?: string; agentDeviceId?: string; channel?: string } | undefined;
    if (channel === CONTROLLED_MODEL_CATALOG_CHANNEL && request?.op === 'read') {
      await routeGate;
      if (request.channel === 'maker:provider:list') return providerPayload('sourceB', 1500);
      if (request.channel === 'maker:get-capabilities') return capsPayload('sourceB', 1500);
    }
    if (channel === 'maker:provider:list') return providerPayload('host', 1000);
    if (channel === 'maker:get-capabilities') return capsPayload('host', 1000);
    throw new Error('unexpected channel ' + channel);
  });
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  const route = modelCatalogKey('sourceB', 'host')!;
  try {
    await providerCache.prefetchDeviceProviders('host');
    await capabilities.prefetchDeviceCapabilities('host');
    const routeProvider = providerCache.prefetchDeviceProviders(route);
    const routeCaps = capabilities.prefetchDeviceCapabilities(route);
    await Promise.resolve();
    await Promise.resolve();
    const readsBefore = invoke.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1001);
    expect(providerCache.getCachedDeviceProviders('host')).toBeNull();
    expect(capabilities.getCachedCapabilities('claude-code', 'host')).toBeNull();

    releaseRoute();
    await Promise.all([routeProvider, routeCaps]);
    expect(providerCache.getCachedDeviceProviders(route)?.providers).toHaveLength(1);
    expect(capabilities.getCachedCapabilities('claude-code', route)).not.toBeNull();
    expect(invoke.mock.calls.length).toBe(readsBefore);
  } finally {
    providerCache.evictAllDeviceProviders();
    capabilities.evictAllRemoteCapabilities();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

// Unit: the directOnly expiry fix must not weaken a real device/owner eviction, which
// still has to retire that host's routed aliases.
it('still cascades routed aliases on an explicit device eviction', async () => {
  const capsPayload = (label: string) => ({
    availableModels: [{ id: 'm', displayName: label, contextWindow: 1, efforts: [], defaultEffort: null }],
    hasFastMode: false, effortLevels: [], permissionModes: [],
  });
  const invoke = vi.fn(async (device: string, channel: string, args: unknown[]) => {
    const request = args[0] as { op?: string; agentDeviceId?: string; channel?: string } | undefined;
    if (channel === CONTROLLED_MODEL_CATALOG_CHANNEL && request?.op === 'read') {
      if (request.channel === 'maker:provider:list') return result(request.agentDeviceId!);
      return capsPayload(request.agentDeviceId!);
    }
    if (channel === 'maker:provider:list') return result(device);
    if (channel === 'maker:get-capabilities') return capsPayload(device);
    throw new Error('unexpected channel ' + channel);
  });
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  const routeA = modelCatalogKey('sourceA', 'host')!;
  const routeB = modelCatalogKey('sourceB', 'host')!;
  try {
    await Promise.all([
      providerCache.prefetchDeviceProviders('host'),
      providerCache.prefetchDeviceProviders(routeA),
      providerCache.prefetchDeviceProviders(routeB),
      capabilities.prefetchDeviceCapabilities('host'),
      capabilities.prefetchDeviceCapabilities(routeA),
      capabilities.prefetchDeviceCapabilities(routeB),
    ]);
    expect(providerCache.getCachedDeviceProviders(routeA)).not.toBeNull();
    expect(providerCache.getCachedDeviceProviders(routeB)).not.toBeNull();
    providerCache.evictDeviceProviders('host');
    capabilities.evictDeviceCapabilities('host');
    expect(providerCache.getCachedDeviceProviders('host')).toBeNull();
    expect(providerCache.getCachedDeviceProviders(routeA)).toBeNull();
    expect(providerCache.getCachedDeviceProviders(routeB)).toBeNull();
    expect(capabilities.getCachedCapabilities('claude-code', 'host')).toBeNull();
    expect(capabilities.getCachedCapabilities('claude-code', routeA)).toBeNull();
    expect(capabilities.getCachedCapabilities('claude-code', routeB)).toBeNull();
  } finally {
    providerCache.evictAllDeviceProviders();
    capabilities.evictAllRemoteCapabilities();
    vi.unstubAllGlobals();
  }
});

// Unit: one agent-kind deadline must not retire or error a healthy sibling kind,
// nor invalidate its in-flight result. Public cache + subscription + SDK expiry only.
it('expires only the affected agent kind and keeps healthy in-flight kinds', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const capsFor = (label: string, remainingMs: number) => ({
    availableModels: [{ id: 'm', displayName: label, contextWindow: 1, efforts: [], defaultEffort: null }],
    hasFastMode: false, effortLevels: [], permissionModes: [],
    providerContinuity: { stale: false, remainingMs },
  });
  const invoke = vi.fn(async (_device: string, channel: string, args: unknown[]) => {
    if (channel !== 'maker:get-capabilities') throw new Error('unexpected channel ' + channel);
    const kind = args[0];
    if (kind === 'claude-code') return capsFor('claude', 1000);
    await gate;
    return capsFor(String(kind), 2000);
  });
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  const events = vi.fn();
  const off = capabilities.subscribeDeviceCapabilities('host', 'codex', events);
  try {
    const all = capabilities.prefetchDeviceCapabilities('host');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(capabilities.getCachedCapabilities('claude-code', 'host')).not.toBeNull();
    expect(capabilities.getCachedCapabilities('codex', 'host')).toBeNull();

    await vi.advanceTimersByTimeAsync(1001);
    expect(capabilities.getCachedCapabilities('claude-code', 'host')).toBeNull();
    // Codex has its own 2000ms budget and is still in flight; it must not get
    // the expired kind's terminal error or be discarded.
    expect(events.mock.calls.filter(([event]) => event.status === 'error')).toEqual([]);

    release();
    await all;
    expect(capabilities.getCachedCapabilities('codex', 'host')).not.toBeNull();
    expect(capabilities.getCachedCapabilities('pi', 'host')).not.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(3);

    const beforeExpiry = events.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(capabilities.getCachedCapabilities('codex', 'host')).toBeNull();
    expect(capabilities.getCachedCapabilities('pi', 'host')).toBeNull();
    expect(events.mock.calls.slice(beforeExpiry).some(([event]) => event.status === 'error')).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(3);
  } finally {
    off();
    capabilities.evictAllRemoteCapabilities();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

// Unit integration: real Main fallback/late denial -> IPC notification adapter ->
// real renderer cache publisher. Previously a returned stale display survived its denial.
it('clears a displayed fallback immediately on Main late denial, even while its fresh read is offline, without clearing a neighbour', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  let phase = 'fresh', deny!: (value: import('@cindy/device-link').InvokeResultPayload) => void;
  const invoke = async (target: string, channel: string, args: unknown[]) => {
    if (channel !== 'maker:provider:list') return { availableModels: [], hasFastMode: false, effortLevels: [], permissionModes: [] };
    const reply = await invokeProviderMetadataContinuity(target, channel, args, async () => {
      if (target === 'N' || phase === 'fresh') return { ok: true, result: { ...result(target),
        providerContinuity: { stale: false, remainingMs: 30 * 60_000 } } };
      if (phase === 'hold') return new Promise(resolve => { deny = resolve; });
      throw Object.assign(new Error('offline'), { code: 'NOT_CONNECTED' });
    });
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  };
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  const events = vi.fn(), unsubscribe = providerCache.subscribeDeviceProviders('M', events);
  const off = onProviderMetadataDenied(target => { void refreshRemoteCatalogSnapshot(target,
    { providerContinuity: { stale: true, remainingMs: 0 } }); });
  try {
    await Promise.all(['M', 'N'].map(id => providerCache.prefetchDeviceProviders(id)));
    phase = 'hold'; const refreshing = refreshRemoteCatalogSnapshot('M');
    await vi.advanceTimersByTimeAsync(2000); await refreshing;
    expect(providerCache.getCachedDeviceProviders('M')?.providers).toHaveLength(1);
    events.mockClear(); phase = 'offline'; deny({ ok: false, error: { code: 'ACCESS_REVOKED', message: 'revoked' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(providerCache.getCachedDeviceProviders('M')).toBeNull();
    expect(providerCache.getCachedDeviceProviders('N')?.providers).toHaveLength(1);
    expect(events).toHaveBeenCalledWith({ status: 'loading' });
  } finally { off(); unsubscribe(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});

// Unit: a mounted/forwarded catalog must not outlive the Main-owned trust budget.
it('expires a retained host snapshot without renewing it on cache reads or at expiry', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  const invoke = vi.fn().mockResolvedValueOnce({ ...result('host'), providerContinuity: { stale: true, remainingMs: 1000 } })
    .mockRejectedValue(new Error('[DEVICE_LINK_NOT_CONNECTED] offline'));
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  try {
    await providerCache.prefetchDeviceProviders('host');
    await vi.advanceTimersByTimeAsync(500);
    await providerCache.prefetchDeviceProviders('host');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(providerCache.getCachedDeviceProviders('host')?.providers[0].id).toBe('host-xd');
    await vi.advanceTimersByTimeAsync(501);
    expect(providerCache.getCachedDeviceProviders('host')).toBeNull();
    // Expiry retires the display; it must not issue a background read that
    // would establish a new source for the expired target.
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally { providerCache.evictAllDeviceProviders(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});

// Regression: a retained refresh deletes the cache but must keep the host deadline.
// Minimal input: one stamped success, then refreshRemoteCatalogSnapshot() hangs.
it('keeps the original host deadline while a retained refresh stays in flight', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  let hold = false;
  const invoke = vi.fn(async (device: string, channel: string) => {
    if (channel !== 'maker:provider:list') {
      return { availableModels: [], hasFastMode: false, effortLevels: [], permissionModes: [] };
    }
    if (hold) return new Promise<Providers>(() => undefined);
    return { ...result(device), providerContinuity: { stale: true, remainingMs: 1000 } };
  });
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  try {
    await providerCache.prefetchDeviceProviders('host');
    const events = vi.fn();
    const unsubscribe = providerCache.subscribeDeviceProviders('host', events);
    hold = true;
    void refreshRemoteCatalogSnapshot('host');
    await vi.advanceTimersByTimeAsync(0);
    events.mockClear();
    await vi.advanceTimersByTimeAsync(1001);
    expect(events).toHaveBeenCalledWith({ status: 'loading' });
    unsubscribe();
  } finally { providerCache.evictAllDeviceProviders(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});// #8010 unit: the same source can have different access through two task hosts;
// existing per-device cache tests did not exercise host-mediated reads.
it('reads through each task host and invalidates only that host without resurrecting late catalogs', async () => {
  let finish!: (value: Providers) => void;
  const invoke = vi.fn(async (device: string) => device === 'host-b'
    ? new Promise<Providers>(resolve => { finish = resolve; }) : result(device));
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  const b = modelCatalogKey('self-a', 'host-b')!;
  const c = modelCatalogKey('self-a', 'host-c')!;
  const pending = providerCache.prefetchDeviceProviders(b);
  await providerCache.prefetchDeviceProviders(c);
  await providerCache.prefetchDeviceProviders('host-local');
  expect(invoke).toHaveBeenCalledWith('host-b', 'maker:model-catalog:read', [{
    op: 'read', agentDeviceId: 'self-a', channel: 'maker:provider:list', args: [{ capabilities: ['provider-logo-kinds-v2'] }],
  }]);
  providerCache.evictControlledDeviceProviders('host-b');
  finish(result('old'));
  await pending;
  expect(providerCache.getCachedDeviceProviders(b)).toBeNull();
  expect(providerCache.getCachedDeviceProviders(c)?.providers[0].id).toBe('host-c-xd');
  expect(providerCache.getCachedDeviceProviders('host-local')?.providers[0].id).toBe('host-local-xd');
});

it('expires only subscription share snapshots and preserves ordinary API discovery cache semantics', async () => {
  const login = { ...provider('subscription'), subscriptionFastPolicy: { allowFast: true, groupAllowsFast: true } };
  const api = provider('openai');
  const invoke = vi.fn(async (device: string) => ({ providers: [device === 'share:subscription' ? login : api] }));
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  const mod = await import('@/hooks/useDeviceProviders');
  await mod.prefetchDeviceProviders('share:subscription');
  await mod.prefetchDeviceProviders('share:api');
  expect(mod.isSubscriptionShareCatalogStale('share:subscription')).toBe(false);
  const later = Date.now() + 61_000;
  expect(mod.isSubscriptionShareCatalogStale('share:subscription', later)).toBe(true);
  expect(mod.isSubscriptionShareCatalogStale('share:api', later)).toBe(false);
  expect(mod.isSubscriptionShareCatalogStale('same-account-computer', later)).toBe(false);
  mod.evictDeviceProviders('share:subscription');
  expect(mod.isSubscriptionShareCatalogStale('share:subscription', later)).toBe(false);
  await mod.prefetchDeviceProviders('share:api');
  expect(invoke.mock.calls.filter(([device]) => device === 'share:api')).toHaveLength(1);
});

// A failed policy refresh evicts the authoritative cache. Its subscription
// identity must survive that soft eviction so the next membership poll retries;
// account/disconnect eviction must still discard the hint and any late result.
it('retains subscription freshness after a failed soft refresh and clears it at the owner boundary', async () => {
  const login = { ...provider('subscription'), subscriptionFastPolicy: { allowFast: true, groupAllowsFast: true } };
  const invoke = vi.fn().mockResolvedValueOnce({ providers: [login] }).mockRejectedValueOnce(Error('temporary disconnect'));
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  const mod = await import('@/hooks/useDeviceProviders');
  await mod.prefetchDeviceProviders('share:subscription');
  const later = Date.now() + 61_000;
  mod.evictDeviceProviders('share:subscription', { retainDisplaySnapshot: true });
  await mod.prefetchDeviceProviders('share:subscription');
  expect(mod.getCachedDeviceProviders('share:subscription')).toBeNull();
  expect(mod.isSubscriptionShareCatalogStale('share:subscription', later)).toBe(true);
  mod.evictAllDeviceProviders();
  expect(mod.isSubscriptionShareCatalogStale('share:subscription', later)).toBe(false);
});

type Providers = {
  providers: ProviderView[];
  modelVisibilityOverrides?: Record<string, boolean>;
};
const provider = (id: string): ProviderView => ({
  id,
  name: id,
  source: 'builtin',
  agents: ['claude-code'],
  auth: { method: 'none' },
  routing: {
    'claude-code': { upstream: 'https://example.invalid', authStrategy: 'none' },
  },
  models: { 'claude-code': [] },
  connected: true,
});
const result = (deviceId: string): Providers => ({ providers: [provider(`${deviceId}-xd`)] });

const providerWithModel = (id: string) => ({
  ...provider(id),
  models: {
    'claude-code': [
      {
        id: `${id}-model`,
        name: `${id} Model`,
        contextWindow: 200_000,
        efforts: ['medium'],
        defaultEffort: 'medium',
      },
    ],
  },
});

/** stub window.electronAPI.deviceLink.invoke,返回 spy。 */
function stubDeviceLink() {
  const invoke = vi.fn(async (deviceId: string) => result(deviceId));
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  return invoke;
}

describe('useDeviceProviders deviceId-aware cache', () => {
  it('远程路径:prefetch 命中 deviceLink.invoke(maker:provider:list, [])', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-1');
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:provider:list', [
      {
        capabilities: ['provider-logo-kinds-v2'],
      },
    ]);
  });

  it('非法 provider 响应进入 error，不得把 null 当成权威空列表', async () => {
    const invoke = vi.fn(async () => null);
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders('dev-invalid', listener);

    await mod.prefetchDeviceProviders('dev-invalid');

    expect(listener).toHaveBeenCalledWith({
      status: 'error',
      error: 'Invalid provider list response',
      unsupported: false,
    });
    expect(mod.getCachedDeviceProviders('dev-invalid')).toBeNull();
  });

  it('provider 数组混入非法元素时丢掉坏项，保留合法供应商', async () => {
    const invoke = vi.fn(async () => ({ providers: [provider('valid'), null] }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders('dev-invalid-item', listener);

    await mod.prefetchDeviceProviders('dev-invalid-item');

    expect(mod.getCachedDeviceProviders('dev-invalid-item')?.providers.map((row) => row.id)).toEqual([
      'valid',
    ]);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ready',
        providers: [expect.objectContaining({ id: 'valid' })],
      }),
    );
  });

  it('接受不含执行字段的安全投影 provider', async () => {
    const projected = {
      id: 'projected',
      name: 'Projected',
      agents: ['claude-code'],
      models: {
        'claude-code': [
          {
            id: 'projected-model',
            name: 'Projected Model',
            contextWindow: 200_000,
            efforts: ['medium'],
            defaultEffort: 'medium',
          },
        ],
      },
      connected: true,
    };
    const invoke = vi.fn(async () => ({ providers: [projected] }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');

    await mod.prefetchDeviceProviders('dev-projected');

    const cached = mod.getCachedDeviceProviders('dev-projected');
    expect(cached).toEqual({
      providers: [{ ...projected, routing: { 'claude-code': {} } }],
    });
    expect(connectedProvidersForAgent(cached?.providers ?? [], 'claude-code')).toHaveLength(1);
    expect(
      visibleModelUnion(cached?.providers ?? [], 'claude-code', () => true).map((m) => m.id),
    ).toEqual(['projected-model']);
  });

  it('补齐 agents 声明但缺失的远程 routing entry,保留已有 disabled 标记', async () => {
    const projected = {
      ...providerWithModel('partial-routing'),
      agents: ['claude-code', 'codex'],
      routing: { codex: { disabled: true } },
    };
    const invoke = vi.fn(async () => ({ providers: [projected] }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');

    await mod.prefetchDeviceProviders('dev-partial-routing');

    const cached = mod.getCachedDeviceProviders('dev-partial-routing');
    expect(cached?.providers[0]?.routing).toEqual({
      codex: { disabled: true },
      'claude-code': {},
    });
    expect(connectedProvidersForAgent(cached?.providers ?? [], 'claude-code')).toHaveLength(1);
    expect(connectedProvidersForAgent(cached?.providers ?? [], 'codex')).toEqual([]);
  });

  it('嵌套模型损坏时丢掉坏模型，保留供应商', async () => {
    const malformed = {
      ...provider('malformed-model'),
      models: {
        'claude-code': [
          null,
          {
            id: 'kept',
            name: 'Kept',
            contextWindow: 200_000,
            efforts: ['medium'],
            defaultEffort: 'medium',
          },
        ],
      },
    };
    const invoke = vi.fn(async () => ({ providers: [malformed] }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');

    await mod.prefetchDeviceProviders('dev-malformed-model');

    expect(
      mod.getCachedDeviceProviders('dev-malformed-model')?.providers[0]?.models['claude-code'],
    ).toEqual([
      expect.objectContaining({ id: 'kept' }),
    ]);
  });

  it('缺默认思考深度的远程模型保留，并按实际支持档位补默认', async () => {
    const invoke = vi.fn(async () => ({
      providers: [
        {
          ...provider('openai'),
          models: {
            'claude-code': [
              {
                id: 'gpt-5.6-luna',
                name: 'GPT-5.6-Luna',
                contextWindow: 1_050_000,
                efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
              },
              {
                id: 'claude-opus-5',
                name: 'Claude Opus 5',
                contextWindow: 200_000,
                efforts: ['high'],
                defaultEffort: 'high',
              },
            ],
          },
        },
      ],
    }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');

    await mod.prefetchDeviceProviders('dev-luna');

    expect(
      mod.getCachedDeviceProviders('dev-luna')?.providers[0]?.models['claude-code']?.map((m) => m.id),
    ).toEqual(['gpt-5.6-luna', 'claude-opus-5']);
    expect(mod.getCachedDeviceProviders('dev-luna')?.providers[0]?.models['claude-code']?.[0]?.defaultEffort).toBe('medium');
  });

  it.each([undefined, true, false])('preserves provider effort capability marker %s without inferring legacy emptiness', async (effortsUnknown) => {
    const mod = await import('@/hooks/useDeviceProviders');
    const base = providerWithModel('remote');
    const model = {
      ...base.models['claude-code'][0],
      efforts: [],
      defaultEffort: null,
      ...(effortsUnknown === undefined ? {} : { effortsUnknown }),
    };
    const result = mod.parseDeviceProvidersPayload({ providers: [{
      ...base, models: { 'claude-code': [model] },
    }] });

    expect(result.providers[0]?.models['claude-code']?.[0]?.effortsUnknown).toBe(effortsUnknown);
  });

  it('preserves explicit no-thinking and rejects malformed remote defaults', async () => {
    const mod = await import('@/hooks/useDeviceProviders');
    const base = providerWithModel('remote');
    const model = base.models['claude-code'][0];
    const result = mod.parseDeviceProvidersPayload({ providers: [{ ...base, models: {
      'claude-code': [
        { ...model, id: 'empty', efforts: [], defaultEffort: undefined },
        { ...model, id: 'explicit-null', defaultEffort: null },
        { ...model, id: 'invalid', defaultEffort: { value: 'medium' } },
      ],
    } }] });
    expect(result.providers[0]?.models['claude-code']?.map(m => [m.id, m.defaultEffort])).toEqual([
      ['empty', null], ['explicit-null', null],
    ]);
  });

  it.each([
    ['provider.suspended', { ...provider('bad-suspended'), suspended: 'true' }],
    [
      'routing.disabled',
      {
        ...provider('bad-route-disabled'),
        routing: { 'claude-code': { disabled: 'true' } },
      },
    ],
    [
      'routing.wireProtocol',
      {
        ...provider('bad-wire-protocol'),
        routing: { 'claude-code': { wireProtocol: 'future-protocol' } },
      },
    ],
  ])('%s 类型损坏时整份 provider 响应失败', async (field, malformed) => {
    const deviceId = `dev-invalid-${field}`;
    const invoke = vi.fn(async () => ({ providers: [malformed] }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders(deviceId, listener);

    await mod.prefetchDeviceProviders(deviceId);

    expect(listener).toHaveBeenCalledWith({
      status: 'error',
      error: 'Invalid provider list response',
      unsupported: false,
    });
    expect(mod.getCachedDeviceProviders(deviceId)).toBeNull();
  });

  it.each([
    ['model.disabled', 'true'],
    ['model.supportsFastMode', 'true'],
    ['model.defaultEnabled', 'false'],
  ])('%s 类型损坏时丢掉该模型，不整表失败', async (field, badValue) => {
    const key = field.split('.')[1] as 'disabled' | 'supportsFastMode' | 'defaultEnabled';
    const invoke = vi.fn(async () => ({
      providers: [
        {
          ...providerWithModel('kept-provider'),
          models: {
            'claude-code': [
              {
                ...providerWithModel('kept-provider').models['claude-code'][0],
                [key]: badValue,
              },
              {
                id: 'good',
                name: 'Good',
                contextWindow: 200_000,
                efforts: ['medium'],
                defaultEffort: 'medium',
              },
            ],
          },
        },
      ],
    }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');

    await mod.prefetchDeviceProviders(`dev-drop-${key}`);

    expect(
      mod
        .getCachedDeviceProviders(`dev-drop-${key}`)
        ?.providers[0]?.models['claude-code']?.map((model) => model.id),
    ).toEqual(['good']);
  });

  it('模型可见性 override 含非布尔值时不得缓存', async () => {
    const invoke = vi.fn(async () => ({
      providers: [provider('invalid-override')],
      modelVisibilityOverrides: { 'claude-code:invalid-override:model': 'hidden' },
    }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders('dev-invalid-override', listener);

    await mod.prefetchDeviceProviders('dev-invalid-override');

    expect(listener).toHaveBeenCalledWith({
      status: 'error',
      error: 'Invalid provider visibility response',
      unsupported: false,
    });
    expect(mod.getCachedDeviceProviders('dev-invalid-override')).toBeNull();
  });

  it('缓存命中:同设备二次 prefetch 不再发请求', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-1');
    await mod.prefetchDeviceProviders('dev-1');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('缓存并通知被控端的模型可见性 override 快照', async () => {
    const overrides = { 'codex:openai:hidden-model': false };
    const invoke = vi.fn(async () => ({
      ...result('dev-1'),
      modelVisibilityOverrides: overrides,
    }));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders('dev-1', listener);

    await mod.prefetchDeviceProviders('dev-1');

    expect(mod.getCachedDeviceProviders('dev-1')).toEqual({
      providers: [provider('dev-1-xd')],
      modelVisibilityOverrides: overrides,
    });
    expect(listener).toHaveBeenCalledWith({
      status: 'ready',
      providers: [provider('dev-1-xd')],
      modelVisibilityOverrides: overrides,
    });
  });

  it('inflight 去重:同设备并发只发一次', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await Promise.all([mod.prefetchDeviceProviders('dev-1'), mod.prefetchDeviceProviders('dev-1')]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('key 隔离:dev-1 / dev-2 各拉各的,互不影响', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-1');
    await mod.prefetchDeviceProviders('dev-2');
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:provider:list', [
      {
        capabilities: ['provider-logo-kinds-v2'],
      },
    ]);
    expect(invoke).toHaveBeenCalledWith('dev-2', 'maker:provider:list', [
      {
        capabilities: ['provider-logo-kinds-v2'],
      },
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
    // dev-2 已缓存:再 prefetch 不重拉(隔离 + 命中)。
    await mod.prefetchDeviceProviders('dev-2');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('驱逐:evict 后同设备重新拉取;只清该设备(dev-2 仍命中缓存)', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-1');
    await mod.prefetchDeviceProviders('dev-2');
    expect(invoke).toHaveBeenCalledTimes(2);
    mod.evictDeviceProviders('dev-1');
    await mod.prefetchDeviceProviders('dev-1'); // 缓存已清 → 重拉(+1)
    await mod.prefetchDeviceProviders('dev-2'); // 未清 → 命中(+0)
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('evict 在途 prefetch → 结果丢弃,不复活缓存(重连/升级目标端后串旧)', async () => {
    const resolvers: Array<(v: Providers) => void> = [];
    const invoke = vi.fn(() => new Promise<Providers>((r) => resolvers.push(r)));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');

    const p = mod.prefetchDeviceProviders('dev-1'); // 在途(invoke 未 resolve)
    mod.evictDeviceProviders('dev-1'); // 设备下线 → 驱逐(代际自增)
    resolvers.forEach((r) => r(result('dev-1-stale'))); // 在途请求随后才回来
    await p;

    // 被驱逐的在途结果不得回写缓存 → 再 prefetch 必须重新发请求(总计 2 次)。
    const p2 = mod.prefetchDeviceProviders('dev-1');
    resolvers.forEach((r) => r(result('dev-1-fresh'))); // resolve 第二轮(含已 resolve 的第一轮,no-op)
    await p2;
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('reject(旧版被控端不识别通道)→ 不缓存,下次重试', async () => {
    let call = 0;
    const invoke = vi.fn(async () => {
      call += 1;
      throw new Error(
        "[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel 'maker:provider:list' not allowed remotely",
      );
    });
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('dev-old'); // swallow
    await mod.prefetchDeviceProviders('dev-old'); // 上次失败未缓存 → 再发
    expect(call).toBe(2);
  });

  it('错误事件区分旧端不支持与真实连接失败', async () => {
    const unsupported = new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel not allowed remotely');
    const policyFailure = new Error('proxy policy: request not allowed remotely');
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(unsupported)
      .mockRejectedValueOnce(new Error('[DEVICE_LINK_TIMEOUT] timed out'))
      .mockRejectedValueOnce(policyFailure);
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const oldDeviceListener = vi.fn();
    const offlineListener = vi.fn();
    const policyFailureListener = vi.fn();
    mod.subscribeDeviceProviders('dev-old', oldDeviceListener);
    mod.subscribeDeviceProviders('dev-offline', offlineListener);
    mod.subscribeDeviceProviders('dev-policy-failure', policyFailureListener);

    await mod.prefetchDeviceProviders('dev-old');
    await mod.prefetchDeviceProviders('dev-offline');
    await mod.prefetchDeviceProviders('dev-policy-failure');

    expect(mod.isDeviceProvidersUnsupportedError(unsupported)).toBe(true);
    expect(mod.isDeviceProvidersUnsupportedError(policyFailure)).toBe(false);
    expect(oldDeviceListener).toHaveBeenCalledWith({
      status: 'error',
      error: unsupported.message,
      unsupported: true,
    });
    expect(offlineListener).toHaveBeenCalledWith({
      status: 'error',
      error: '[DEVICE_LINK_TIMEOUT] timed out',
      unsupported: false,
    });
    expect(policyFailureListener).toHaveBeenCalledWith({
      status: 'error',
      error: policyFailure.message,
      unsupported: false,
    });
  });

  it('新快照只通知对应 deviceId 的已挂载订阅者', async () => {
    const invoke = stubDeviceLink();
    const mod = await import('@/hooks/useDeviceProviders');
    const dev1 = vi.fn();
    const dev2 = vi.fn();
    const off1 = mod.subscribeDeviceProviders('dev-1', dev1);
    const off2 = mod.subscribeDeviceProviders('dev-2', dev2);

    await mod.prefetchDeviceProviders('dev-1');
    expect(dev1).toHaveBeenCalledWith({
      status: 'ready',
      providers: [provider('dev-1-xd')],
    });
    expect(dev2).not.toHaveBeenCalled();

    off1();
    off2();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('revision 后新请求先完成、旧请求后完成时只通知新快照', async () => {
    const resolvers: Array<(value: Providers) => void> = [];
    const invoke = vi.fn(() => new Promise<Providers>((resolve) => resolvers.push(resolve)));
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders('dev-1', listener);

    const stale = mod.prefetchDeviceProviders('dev-1');
    mod.evictDeviceProviders('dev-1');
    const fresh = mod.prefetchDeviceProviders('dev-1');
    resolvers[1](result('fresh'));
    await fresh;
    resolvers[0](result('stale'));
    await stale;

    expect(listener).toHaveBeenNthCalledWith(1, { status: 'loading' });
    expect(listener).toHaveBeenNthCalledWith(2, {
      status: 'ready',
      providers: [provider('fresh-xd')],
    });
  });
});


describe('provider visibility readiness retry', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('retries a serialized typed readiness error, deduplicates callers, then retains hidden switches', async () => {
    vi.useFakeTimers();
    const invoke = stubDeviceLink();
    invoke.mockRejectedValueOnce(new Error('[MODEL_VISIBILITY_NOT_READY] waiting'));
    invoke.mockResolvedValue({ ...result('host'), modelVisibilityOverrides: { 'codex:xd:hidden': false } });
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders('host', listener);
    const requests = [mod.prefetchDeviceProviders('host'), mod.prefetchDeviceProviders('host')];
    await vi.runAllTimersAsync();
    await Promise.all(requests);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready', modelVisibilityOverrides: { 'codex:xd:hidden': false } }));
  });

  it('stops after three not-ready attempts and reports a real error without legacy fallback', async () => {
    vi.useFakeTimers();
    const invoke = stubDeviceLink().mockRejectedValue(new Error('[MODEL_VISIBILITY_NOT_READY] waiting'));
    const mod = await import('@/hooks/useDeviceProviders');
    const listener = vi.fn();
    mod.subscribeDeviceProviders('host', listener);
    const pending = mod.prefetchDeviceProviders('host');
    await vi.runAllTimersAsync();
    await pending;
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', unsupported: false }));
    expect(mod.getCachedDeviceProviders('host')).toBeNull();
  });

  it.each(['[INTERNAL] failed', 'MODEL_VISIBILITY_NOT_READY: untyped'])('does not retry other errors: %s', async (message) => {
    const invoke = stubDeviceLink().mockRejectedValue(new Error(message));
    const mod = await import('@/hooks/useDeviceProviders');
    await mod.prefetchDeviceProviders('host');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(mod.isDeviceProvidersUnsupportedError(new Error(message))).toBe(false);
  });

  it('eviction cancels delayed retries without disturbing another device', async () => {
    vi.useFakeTimers();
    const invoke = stubDeviceLink();
    invoke.mockRejectedValueOnce(new Error('[MODEL_VISIBILITY_NOT_READY] waiting'));
    const mod = await import('@/hooks/useDeviceProviders');
    const pending = mod.prefetchDeviceProviders('retired');
    await vi.advanceTimersByTimeAsync(0);
    mod.evictDeviceProviders('retired');
    await mod.prefetchDeviceProviders('healthy');
    await vi.runAllTimersAsync();
    await pending;
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(mod.getCachedDeviceProviders('retired')).toBeNull();
    expect(mod.getCachedDeviceProviders('healthy')).toEqual(result('healthy'));
  });
});
