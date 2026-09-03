import { beforeEach, describe, expect, it, vi } from 'vitest';

const { asyncStorage, nativeState, nativeUpdates } = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
  nativeState: {
    updateId: 'native-update' as string | null,
    runtimeVersion: 'runtime-1' as string | null,
    isEmergencyLaunch: false,
  },
  nativeUpdates: {
    checkForUpdateAsync: vi.fn(),
    fetchUpdateAsync: vi.fn(),
    reloadAsync: vi.fn(),
    setUpdateURLAndRequestHeadersOverride: vi.fn(),
  },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStorage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { asyncStorage.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { asyncStorage.delete(key); }),
  },
}));
vi.mock('expo-updates', () => ({
  get updateId() { return nativeState.updateId; },
  get runtimeVersion() { return nativeState.runtimeVersion; },
  get isEmergencyLaunch() { return nativeState.isEmergencyLaunch; },
  ...nativeUpdates,
}));
vi.mock('@/config/env', () => ({ OTA_SERVER_BASE_URL: 'https://updates.example.test' }));

import type { UpdateChannel } from '@cindy/maker-shared/update-channel';
import {
  __testing as analyticsConsentTesting,
  getAnalyticsConsentState,
  hydrateAnalyticsConsent,
} from '@/analytics/analyticsConsentStore';
import {
  __testing as canaryChannelTesting,
  hydrateCanaryChannel,
  resolveUpdateChannelForDevice,
} from './canaryChannelStore';
import {
  EAS_CLIENT_ID_HEADER,
  SHARED_OTA_CLIENT_ID,
  createOtaRequestCoordinator,
  runSelfHostedOtaRequest,
  sharedOtaRequestHeaders,
  type OtaRequestClient,
} from './otaRequestCoordinator';

const UPDATE_URL = 'https://updates.example.test/manifest';

beforeEach(async () => {
  asyncStorage.clear();
  nativeState.updateId = 'native-update';
  nativeState.runtimeVersion = 'runtime-1';
  nativeState.isEmergencyLaunch = false;
  await Promise.all([
    analyticsConsentTesting.resetMemory(),
    canaryChannelTesting.resetMemory(),
  ]);
  vi.clearAllMocks();
});

function createHarness(options: {
  stored?: string | null;
  currentUpdateId?: string | null;
  currentRuntimeVersion?: string | null;
  checkResult?: Awaited<ReturnType<OtaRequestClient['checkForUpdateAsync']>>;
  fetchResult?: Awaited<ReturnType<OtaRequestClient['fetchUpdateAsync']>>;
} = {}) {
  let stored = options.stored ?? null;
  const configs: Array<{ updateUrl: string; requestHeaders: Record<string, string> }> = [];
  const events: string[] = [];
  const client: OtaRequestClient = {
    checkForUpdateAsync: vi.fn(async () => {
      events.push('check');
      return options.checkResult ?? { isAvailable: false };
    }),
    fetchUpdateAsync: vi.fn(async () => {
      events.push('fetch');
      return options.fetchResult ?? { isNew: false };
    }),
    reloadAsync: vi.fn(async () => {
      events.push('reload');
    }),
  };
  const readBaseline = vi.fn(async () => stored);
  const writeBaseline = vi.fn(async (raw: string) => {
    events.push(`write:${JSON.parse(raw).mode}`);
    stored = raw;
  });
  const setConfigOverride = vi.fn((config: { updateUrl: string; requestHeaders: Record<string, string> }) => {
    configs.push(config);
    events.push(config.requestHeaders[EAS_CLIENT_ID_HEADER] ? 'config:shared' : 'config:legacy');
  });
  const coordinator = createOtaRequestCoordinator({
    readBaseline,
    writeBaseline,
    setConfigOverride,
    client,
  });
  const run = <T>(
    operation: (coordinatedClient: OtaRequestClient) => Promise<T>,
    channel: UpdateChannel = 'canary',
    timeouts: { checkTimeoutMs?: number; fetchTimeoutMs?: number } = {},
  ) =>
    coordinator.run({
      updateUrl: UPDATE_URL,
      channel,
      currentUpdateId: options.currentUpdateId === undefined ? 'u1' : options.currentUpdateId,
      currentRuntimeVersion: options.currentRuntimeVersion === undefined
        ? 'runtime-1'
        : options.currentRuntimeVersion,
      ...timeouts,
    }, operation);

  return {
    client,
    configs,
    events,
    getStored: () => stored,
    readBaseline,
    run,
    setConfigOverride,
    writeBaseline,
  };
}

describe('sharedOtaRequestHeaders', () => {
  it('所有自建通道都用同一个共享 UUID，并保留 Canary/Beta 路由头', () => {
    expect(sharedOtaRequestHeaders('release')).toEqual({
      [EAS_CLIENT_ID_HEADER]: SHARED_OTA_CLIENT_ID,
    });
    expect(sharedOtaRequestHeaders('canary')).toEqual({
      'x-cindy-update-channel': 'canary',
      [EAS_CLIENT_ID_HEADER]: SHARED_OTA_CLIENT_ID,
    });
    expect(sharedOtaRequestHeaders('beta')).toEqual({
      'x-cindy-update-channel': 'beta',
      [EAS_CLIENT_ID_HEADER]: SHARED_OTA_CLIENT_ID,
    });
  });
});

describe('createOtaRequestCoordinator', () => {
  it('U1 无 U2 时临时使用共享 UUID，并在结束前恢复 U1 的旧请求头', async () => {
    const h = createHarness();

    await h.run((client) => client.checkForUpdateAsync());

    expect(h.configs).toEqual([
      {
        updateUrl: UPDATE_URL,
        requestHeaders: {
          'x-cindy-update-channel': 'canary',
          [EAS_CLIENT_ID_HEADER]: SHARED_OTA_CLIENT_ID,
        },
      },
      {
        updateUrl: UPDATE_URL,
        requestHeaders: { 'x-cindy-update-channel': 'canary' },
      },
    ]);
    expect(JSON.parse(h.getStored()!)).toEqual({
      version: 1,
      mode: 'legacy',
      updateId: 'u1',
      runtimeVersion: 'runtime-1',
      updateUrl: UPDATE_URL,
      channel: 'canary',
    });
  });

  it('共享 header 下服务端仍返回 U1 时按无更新收口，不尝试重下载同一 ID', async () => {
    const h = createHarness({
      checkResult: { isAvailable: true, manifest: { id: 'U1' } },
    });

    const result = await h.run(async (client) => {
      const checked = await client.checkForUpdateAsync();
      if (checked.isAvailable) await client.fetchUpdateAsync();
      return checked;
    });

    expect(result).toMatchObject({ isAvailable: false, manifest: undefined });
    expect(h.client.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(h.configs.at(-1)?.requestHeaders).toEqual({ 'x-cindy-update-channel': 'canary' });
  });

  it('SSO + consent=false + Canary 可用共享 UUID 下载不同 ID 的 U2 并提交新基线', async () => {
    asyncStorage.set(analyticsConsentTesting.storageKey, JSON.stringify({ consent: false }));
    asyncStorage.set(canaryChannelTesting.storageKey, 'true');
    await Promise.all([hydrateAnalyticsConsent(), hydrateCanaryChannel()]);
    const channel = resolveUpdateChannelForDevice();
    const h = createHarness({
      checkResult: { isAvailable: true, manifest: { id: 'u2' } },
      fetchResult: { isNew: true, manifest: { id: 'U2' } },
    });

    const result = await h.run(async (client) => {
      const checked = await client.checkForUpdateAsync();
      if (!checked.isAvailable) return 'up-to-date';
      const fetched = await client.fetchUpdateAsync();
      return fetched.isNew ? 'fetched' : 'up-to-date';
    }, channel);

    expect(getAnalyticsConsentState().consent).toBe(false);
    expect(asyncStorage.get(analyticsConsentTesting.storageKey)).toBe('{"consent":false}');
    expect(channel).toBe('canary');
    expect(result).toBe('fetched');
    expect(JSON.parse(h.getStored()!)).toEqual({
      version: 1,
      mode: 'shared',
      updateId: 'u2',
      runtimeVersion: 'runtime-1',
      updateUrl: UPDATE_URL,
      channel: 'canary',
    });
    expect(h.configs.at(-1)?.requestHeaders).toEqual({
      'x-cindy-update-channel': 'canary',
      [EAS_CLIENT_ID_HEADER]: SHARED_OTA_CLIENT_ID,
    });
    expect(h.events.indexOf('write:shared')).toBeGreaterThan(h.events.indexOf('fetch'));
    expect(h.events.at(-1)).toBe('write:shared');
  });

  it('U1 下载 U2 后跨协调器重建，U2 以共享请求头成为稳定基线', async () => {
    const first = createHarness({
      checkResult: { isAvailable: true, manifest: { id: 'u2' } },
      fetchResult: { isNew: true, manifest: { id: 'u2' } },
    });
    await first.run(async (client) => {
      await client.checkForUpdateAsync();
      await client.fetchUpdateAsync();
    });

    // 新 coordinator 模拟 JS reload / 冷启动：只共享真实持久层，不复用内存 baseline。
    const h = createHarness({
      currentUpdateId: 'u2',
      stored: first.getStored(),
    });

    await h.run((client) => client.checkForUpdateAsync());

    expect(h.writeBaseline).not.toHaveBeenCalled();
    expect(h.configs).toHaveLength(1);
    expect(h.configs.every((config) => (
      config.requestHeaders[EAS_CLIENT_ID_HEADER] === SHARED_OTA_CLIENT_ID
    ))).toBe(true);
  });

  it('目标通道变化但没有新 bundle 时，仍恢复当前 U1 下载时的通道', async () => {
    const h = createHarness({
      stored: JSON.stringify({
        version: 1,
        mode: 'legacy',
        updateId: 'u1',
        runtimeVersion: 'runtime-1',
        updateUrl: UPDATE_URL,
        channel: 'canary',
      }),
    });

    await h.run((client) => client.checkForUpdateAsync(), 'beta');

    expect(h.configs[0]?.requestHeaders).toEqual({
      'x-cindy-update-channel': 'beta',
      [EAS_CLIENT_ID_HEADER]: SHARED_OTA_CLIENT_ID,
    });
    expect(h.configs.at(-1)?.requestHeaders).toEqual({ 'x-cindy-update-channel': 'canary' });
  });

  it('更新服务地址变化但没有新 bundle 时，仍恢复 U1 下载时的地址', async () => {
    const previousUrl = 'https://old-updates.example.test/manifest';
    const h = createHarness({
      stored: JSON.stringify({
        version: 1,
        mode: 'legacy',
        updateId: 'u1',
        runtimeVersion: 'runtime-1',
        updateUrl: previousUrl,
        channel: 'canary',
      }),
    });

    await h.run((client) => client.checkForUpdateAsync());

    expect(h.configs[0]?.updateUrl).toBe(UPDATE_URL);
    expect(h.configs.at(-1)).toEqual({
      updateUrl: previousUrl,
      requestHeaders: { 'x-cindy-update-channel': 'canary' },
    });
  });

  it('runtime 变化时丢弃旧 runtime 的 pending marker', async () => {
    const h = createHarness({
      currentUpdateId: 'new-embedded',
      currentRuntimeVersion: 'runtime-2',
      stored: JSON.stringify({
        version: 1,
        mode: 'shared',
        updateId: 'old-u2',
        runtimeVersion: 'runtime-1',
        updateUrl: UPDATE_URL,
        channel: 'canary',
      }),
    });

    await h.run((client) => client.checkForUpdateAsync(), 'release');

    expect(JSON.parse(h.getStored()!)).toEqual({
      version: 1,
      mode: 'legacy',
      updateId: 'new-embedded',
      runtimeVersion: 'runtime-2',
      updateUrl: UPDATE_URL,
      channel: 'release',
    });
    expect(h.configs.at(-1)?.requestHeaders).toEqual({});
  });

  it('check/fetch 失败时恢复旧基线，永不把临时共享配置留到下次启动', async () => {
    const h = createHarness();
    vi.mocked(h.client.checkForUpdateAsync).mockRejectedValueOnce(new Error('offline'));

    await expect(h.run((client) => client.checkForUpdateAsync())).rejects.toThrow('offline');

    expect(h.configs.at(-1)?.requestHeaders).toEqual({ 'x-cindy-update-channel': 'canary' });
  });

  it('U2 marker 写入失败时中止迁移并恢复旧基线', async () => {
    const h = createHarness({
      stored: JSON.stringify({
        version: 1,
        mode: 'legacy',
        updateId: 'u1',
        runtimeVersion: 'runtime-1',
        updateUrl: UPDATE_URL,
        channel: 'canary',
      }),
      checkResult: { isAvailable: true, manifest: { id: 'u2' } },
      fetchResult: { isNew: true, manifest: { id: 'u2' } },
    });
    // 已有 legacy 基线，下一次写就是提交 shared 基线。
    h.writeBaseline.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(h.run(async (client) => {
      await client.checkForUpdateAsync();
      await client.fetchUpdateAsync();
    })).rejects.toThrow('storage unavailable');

    expect(h.configs.at(-1)?.requestHeaders).toEqual({ 'x-cindy-update-channel': 'canary' });
    expect(JSON.parse(h.getStored()!)).toMatchObject({ mode: 'legacy', updateId: 'u1' });
  });

  it('fetch 超时先恢复 U1，原生结果晚到时仍在队列锁内提交 U2', async () => {
    const h = createHarness();
    let finishNativeFetch!: (result: { isNew: boolean; manifest: { id: string } }) => void;
    vi.mocked(h.client.fetchUpdateAsync).mockImplementationOnce(() => new Promise((resolve) => {
      finishNativeFetch = resolve;
    }));

    const first = h.run(
      (client) => client.fetchUpdateAsync(),
      'canary',
      { fetchTimeoutMs: 10 },
    );
    await expect(first).rejects.toThrow('ota-request-timeout(10ms)');
    expect(h.configs.at(-1)?.requestHeaders).toEqual({ 'x-cindy-update-channel': 'canary' });

    const secondOperation = vi.fn((client: OtaRequestClient) => client.checkForUpdateAsync());
    const second = h.run(secondOperation);
    await Promise.resolve();
    expect(secondOperation).not.toHaveBeenCalled();

    finishNativeFetch({ isNew: true, manifest: { id: 'u2' } });
    await expect(second).resolves.toMatchObject({ isAvailable: false });

    expect(secondOperation).toHaveBeenCalledOnce();
    expect(JSON.parse(h.getStored()!)).toMatchObject({
      mode: 'shared',
      updateId: 'u2',
      updateUrl: UPDATE_URL,
    });
    expect(h.configs.at(-1)?.requestHeaders[EAS_CLIENT_ID_HEADER]).toBe(SHARED_OTA_CLIENT_ID);
  });

  it('check 超时先恢复 U1，并等待原生结果晚到后才放行下一笔事务', async () => {
    const h = createHarness();
    let finishNativeCheck!: (result: { isAvailable: boolean }) => void;
    vi.mocked(h.client.checkForUpdateAsync).mockImplementationOnce(() => new Promise((resolve) => {
      finishNativeCheck = resolve;
    }));

    const first = h.run(
      (client) => client.checkForUpdateAsync(),
      'canary',
      { checkTimeoutMs: 10 },
    );
    await expect(first).rejects.toThrow('ota-request-timeout(10ms)');
    expect(h.configs.at(-1)?.requestHeaders).toEqual({ 'x-cindy-update-channel': 'canary' });

    const secondOperation = vi.fn((client: OtaRequestClient) => client.checkForUpdateAsync());
    const second = h.run(secondOperation);
    await Promise.resolve();
    expect(secondOperation).not.toHaveBeenCalled();

    finishNativeCheck({ isAvailable: false });
    await expect(second).resolves.toMatchObject({ isAvailable: false });
    expect(secondOperation).toHaveBeenCalledOnce();
    expect(h.configs.at(-1)?.requestHeaders).toEqual({ 'x-cindy-update-channel': 'canary' });
  });

  it('首次 legacy baseline 写入失败时不改原生配置，也不发 OTA 请求', async () => {
    const h = createHarness();
    h.writeBaseline.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(h.run((client) => client.checkForUpdateAsync()))
      .rejects.toThrow('storage unavailable');

    expect(h.setConfigOverride).not.toHaveBeenCalled();
    expect(h.client.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(h.getStored()).toBeNull();
  });

  it('首次设置 shared override 抛错时尽力恢复 U1 配置', async () => {
    const h = createHarness();
    h.setConfigOverride.mockImplementationOnce(() => {
      throw new Error('native override rejected');
    });

    await expect(h.run((client) => client.checkForUpdateAsync()))
      .rejects.toThrow('native override rejected');

    expect(h.client.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(h.configs.at(-1)).toEqual({
      updateUrl: UPDATE_URL,
      requestHeaders: { 'x-cindy-update-channel': 'canary' },
    });
  });

  it('启动、回前台和手动检查共用串行队列，不会交错改写 override', async () => {
    const h = createHarness();
    let releaseFirst!: () => void;
    const first = h.run(async (client) => {
      await client.checkForUpdateAsync();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return 'first';
    });
    const secondOperation = vi.fn(async (client: OtaRequestClient) => {
      await client.checkForUpdateAsync();
      return 'second';
    });
    const second = h.run(secondOperation);

    await vi.waitFor(() => expect(h.client.checkForUpdateAsync).toHaveBeenCalledTimes(1));
    expect(secondOperation).not.toHaveBeenCalled();
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(secondOperation).toHaveBeenCalledOnce();
    expect(h.client.checkForUpdateAsync).toHaveBeenCalledTimes(2);
  });

  it('拿不到当前 update ID 时不改原生配置也不发请求', async () => {
    const h = createHarness({ currentUpdateId: null });

    await expect(h.run((client) => client.checkForUpdateAsync()))
      .rejects.toThrow('ota-request-current-update-id-unavailable');

    expect(h.setConfigOverride).not.toHaveBeenCalled();
    expect(h.client.checkForUpdateAsync).not.toHaveBeenCalled();
  });

  it('emergency launch 没有 update ID 时仍可执行后台恢复请求', async () => {
    nativeState.updateId = null;
    nativeState.isEmergencyLaunch = true;
    nativeUpdates.checkForUpdateAsync.mockResolvedValueOnce({ isAvailable: false });

    await expect(runSelfHostedOtaRequest(
      'release',
      (client) => client.checkForUpdateAsync(),
    )).resolves.toMatchObject({ isAvailable: false });

    expect(nativeUpdates.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(nativeUpdates.setUpdateURLAndRequestHeadersOverride).toHaveBeenNthCalledWith(1, {
      updateUrl: UPDATE_URL,
      requestHeaders: { [EAS_CLIENT_ID_HEADER]: SHARED_OTA_CLIENT_ID },
    });
    expect(nativeUpdates.setUpdateURLAndRequestHeadersOverride).toHaveBeenLastCalledWith({
      updateUrl: UPDATE_URL,
      requestHeaders: {},
    });
  });
});
