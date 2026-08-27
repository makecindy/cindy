import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
const envState = vi.hoisted(() => ({
  activeRealm: 'cn' as 'cn' | 'global',
  buildRegion: 'cn' as 'cn' | 'global' | 'dev',
  endpointByRealm: {
    cn: 'https://relay.cn.example',
    global: 'https://relay.global.example',
  },
}));
const devEnvironmentState = vi.hoisted(() => ({
  active: 'dev' as 'dev' | 'release',
}));
const mocks = vi.hoisted(() => ({
  asyncGetItem: vi.fn(async (key: string) => store.get(key) ?? null),
  loadMobileEndpointsForRealm: vi.fn(async (_realm: 'cn' | 'global') => ({})),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: mocks.asyncGetItem,
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

vi.mock('expo-notifications', () => ({
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: mocks.getPermissionsAsync,
  requestPermissionsAsync: mocks.requestPermissionsAsync,
  getDevicePushTokenAsync: mocks.getDevicePushTokenAsync,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('@/config/env', () => ({
  get AUTH_REGION() {
    return envState.buildRegion;
  },
  BUILD_AUTH_REGION: 'cn',
  getActiveMobileSessionRealm: () => envState.activeRealm,
  loadMobileEndpointsForRealm: mocks.loadMobileEndpointsForRealm,
  getMobileEndpointForRealm: (realm: 'cn' | 'global') =>
    envState.endpointByRealm[realm],
}));

vi.mock('@/config/devServerEnvironment', () => ({
  getDevServerEnvironment: () => devEnvironmentState.active,
}));

import {
  retryPendingUnregister,
  syncPushRegistration,
  unregisterPushTokenBestEffort,
} from '@/notifications/pushNotifications';

const REGISTERED_KEY = 'cindy.push.registered';
const PENDING_KEY = 'cindy.push.pendingUnregister';
const DEV_REGISTERED_KEY = `${REGISTERED_KEY}.dev`;
const RELEASE_REGISTERED_KEY = `${REGISTERED_KEY}.release`;
const DEV_PENDING_KEY = `${PENDING_KEY}.dev`;
const RELEASE_PENDING_KEY = `${PENDING_KEY}.release`;

function setStoredRealms(key: string, realms: Array<'cn' | 'global'>): void {
  store.set(key, JSON.stringify({ version: 1, realms }));
}

function readStoredRealms(key: string): string[] {
  const raw = store.get(key);
  if (!raw) return [];
  if (raw === '1') return ['cn'];
  return (JSON.parse(raw) as { realms: string[] }).realms;
}

describe('push notification realm routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    envState.activeRealm = 'cn';
    envState.buildRegion = 'cn';
    devEnvironmentState.active = 'dev';
    mocks.getPermissionsAsync.mockResolvedValue({
      status: 'granted',
      canAskAgain: false,
    });
    mocks.getDevicePushTokenAsync.mockResolvedValue({
      data: 'apns-device-token',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('向当前会话区域注册，但推送构建线仍保持安装包区域', async () => {
    envState.activeRealm = 'global';
    const apiFetch = vi.fn().mockResolvedValue({ registered: true });

    await expect(
      syncPushRegistration({ enabled: true, apiFetch }),
    ).resolves.toBe('registered');

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/device-link/push-token',
      expect.objectContaining({
        baseUrl: 'https://relay.global.example',
        method: 'PUT',
        body: expect.objectContaining({
          token: 'apns-device-token',
          appVariant: 'cn',
        }),
      }),
    );
    expect(apiFetch.mock.calls[0]?.[1]?.body).not.toHaveProperty(
      'revocationToken',
    );
    expect(readStoredRealms(REGISTERED_KEY)).toEqual(['global']);
  });

  it('dev 构建复用 cn 推送构建线向开发环境注册', async () => {
    envState.buildRegion = 'dev';
    expect((await import('@/config/env')).AUTH_REGION).toBe('dev');
    const apiFetch = vi.fn().mockResolvedValue({ registered: true });

    await expect(
      syncPushRegistration({ enabled: true, apiFetch }),
    ).resolves.toBe('registered');

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/device-link/push-token',
      expect.objectContaining({
        baseUrl: 'https://relay.cn.example',
        method: 'PUT',
        body: expect.objectContaining({
          token: 'apns-device-token',
          appVariant: 'cn',
        }),
      }),
    );
    expect(readStoredRealms(DEV_REGISTERED_KEY)).toEqual(['cn']);
    expect(store.has(REGISTERED_KEY)).toBe(false);
  });

  it('CindyDev 的 Dev 与 Release 推送状态互相隔离', async () => {
    envState.buildRegion = 'dev';
    const apiFetch = vi.fn().mockResolvedValue({ registered: true });

    await syncPushRegistration({ enabled: true, apiFetch });
    devEnvironmentState.active = 'release';
    await syncPushRegistration({ enabled: true, apiFetch });

    expect(readStoredRealms(DEV_REGISTERED_KEY)).toEqual(['cn']);
    expect(readStoredRealms(RELEASE_REGISTERED_KEY)).toEqual(['cn']);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('注册期间切换 CindyDev 环境仍把补偿状态留在原 namespace', async () => {
    envState.buildRegion = 'dev';
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    mocks.asyncGetItem.mockImplementationOnce(async (key: string) => {
      expect(key).toBe(DEV_REGISTERED_KEY);
      await readGate;
      return null;
    });
    const apiFetch = vi.fn();

    const registration = syncPushRegistration({ enabled: true, apiFetch });
    await vi.waitFor(() => {
      expect(mocks.asyncGetItem).toHaveBeenCalledWith(DEV_REGISTERED_KEY);
    });
    await unregisterPushTokenBestEffort(null, 'cn');
    devEnvironmentState.active = 'release';
    releaseRead?.();

    await expect(registration).resolves.toBe('skipped');
    expect(apiFetch).not.toHaveBeenCalled();
    expect(readStoredRealms(DEV_REGISTERED_KEY)).toEqual(['cn']);
    expect(readStoredRealms(DEV_PENDING_KEY)).toEqual(['cn']);
    expect(store.has(RELEASE_REGISTERED_KEY)).toBe(false);
    expect(store.has(RELEASE_PENDING_KEY)).toBe(false);
  });

  it('Release 环境不读取旧 CindyDev 的无后缀状态', async () => {
    envState.buildRegion = 'dev';
    devEnvironmentState.active = 'release';
    setStoredRealms(REGISTERED_KEY, ['global']);
    const apiFetch = vi.fn().mockResolvedValue({ registered: true });

    await syncPushRegistration({ enabled: true, apiFetch });

    expect(readStoredRealms(RELEASE_REGISTERED_KEY)).toEqual(['cn']);
    expect(readStoredRealms(REGISTERED_KEY)).toEqual(['global']);
  });

  it('Dev 环境把旧 CindyDev 的无后缀状态迁移到环境专属 key', async () => {
    envState.buildRegion = 'dev';
    setStoredRealms(REGISTERED_KEY, ['global']);
    const apiFetch = vi.fn().mockResolvedValue({ registered: true });

    await syncPushRegistration({ enabled: true, apiFetch });

    expect(readStoredRealms(DEV_REGISTERED_KEY)).toEqual(['cn', 'global']);
    expect(store.has(REGISTERED_KEY)).toBe(false);
  });

  it('切换区域前用旧 token 向显式冻结的旧区域撤销', async () => {
    setStoredRealms(REGISTERED_KEY, ['global']);
    envState.activeRealm = 'cn';
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    await unregisterPushTokenBestEffort('old-global-token', 'global');

    expect(mocks.loadMobileEndpointsForRealm).toHaveBeenCalledWith('global');
    expect(fetch).toHaveBeenCalledWith(
      'https://relay.global.example/api/device-link/push-token',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer old-global-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token: 'apns-device-token' }),
      }),
    );
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('relay.cn.example'),
      expect.anything(),
    );
    expect(readStoredRealms(REGISTERED_KEY)).toEqual([]);
    expect(readStoredRealms(PENDING_KEY)).toEqual([]);
  });

  it('只用当前会话补偿当前区域，另一区域标记保持不动', async () => {
    setStoredRealms(REGISTERED_KEY, ['cn', 'global']);
    setStoredRealms(PENDING_KEY, ['cn', 'global']);
    envState.activeRealm = 'cn';
    const cnApiFetch = vi.fn().mockResolvedValue({ deleted: true });

    await retryPendingUnregister(cnApiFetch);

    expect(cnApiFetch).toHaveBeenCalledWith(
      '/api/device-link/push-token',
      expect.objectContaining({
        baseUrl: 'https://relay.cn.example',
        method: 'DELETE',
        body: { token: 'apns-device-token' },
      }),
    );
    expect(readStoredRealms(PENDING_KEY)).toEqual(['global']);
    expect(readStoredRealms(REGISTERED_KEY)).toEqual(['global']);

    envState.activeRealm = 'global';
    const globalApiFetch = vi.fn().mockResolvedValue({ deleted: true });
    await retryPendingUnregister(globalApiFetch);

    expect(globalApiFetch).toHaveBeenCalledWith(
      '/api/device-link/push-token',
      expect.objectContaining({
        baseUrl: 'https://relay.global.example',
      }),
    );
    expect(readStoredRealms(PENDING_KEY)).toEqual([]);
    expect(readStoredRealms(REGISTERED_KEY)).toEqual([]);
  });

  it('旧 token 不可用时不跨区请求，只保留旧区域标记', async () => {
    setStoredRealms(REGISTERED_KEY, ['global']);
    envState.activeRealm = 'cn';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await unregisterPushTokenBestEffort(null, 'global');

    expect(fetch).not.toHaveBeenCalled();
    expect(readStoredRealms(REGISTERED_KEY)).toEqual(['global']);
    expect(readStoredRealms(PENDING_KEY)).toEqual(['global']);
  });

  it('关闭通知失败时把补偿固定在请求开始时的区域', async () => {
    setStoredRealms(REGISTERED_KEY, ['global']);
    envState.activeRealm = 'global';
    const apiFetch = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(
      syncPushRegistration({ enabled: false, apiFetch }),
    ).rejects.toThrow('offline');

    envState.activeRealm = 'cn';
    expect(readStoredRealms(PENDING_KEY)).toEqual(['global']);
  });

  it('apiFetch terminal handler 内同步退登不会等待自身', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);
    const apiFetch = vi.fn(async () => {
      await unregisterPushTokenBestEffort('access-token', 'cn');
      throw new Error('account unavailable');
    });

    await expect(
      syncPushRegistration({ enabled: true, apiFetch }),
    ).rejects.toThrow('account unavailable');

    expect(fetch).toHaveBeenCalledWith(
      'https://relay.cn.example/api/device-link/push-token',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
        }),
      }),
    );
    expect(readStoredRealms(PENDING_KEY)).toEqual(['cn']);
  });

  it('关闭同步读取状态期间若发生退登，不会在旧生命周期发送认证请求', async () => {
    setStoredRealms(REGISTERED_KEY, ['cn']);
    const storedRegisteredState = store.get(REGISTERED_KEY) ?? null;
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    mocks.asyncGetItem.mockImplementationOnce(async () => {
      await readGate;
      return storedRegisteredState;
    });
    const apiFetch = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const disableSync = syncPushRegistration({ enabled: false, apiFetch });
    await vi.waitFor(() => {
      expect(mocks.asyncGetItem).toHaveBeenCalledWith(REGISTERED_KEY);
    });
    await unregisterPushTokenBestEffort(null, 'cn');
    releaseRead?.();

    await expect(disableSync).resolves.toBe('skipped');
    expect(apiFetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
