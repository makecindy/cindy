import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
const envState = vi.hoisted(() => ({
  platform: 'ios',
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
  readIosPushEnvironment: vi.fn(),
  setNotificationHandler: vi.fn(),
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
  setNotificationHandler: mocks.setNotificationHandler,
  getPermissionsAsync: mocks.getPermissionsAsync,
  requestPermissionsAsync: mocks.requestPermissionsAsync,
  getDevicePushTokenAsync: mocks.getDevicePushTokenAsync,
}));

vi.mock('react-native', () => ({
  Platform: { get OS() { return envState.platform; } },
}));

vi.mock('@/notifications/nativePushEnvironment', () => ({ readIosPushEnvironment: mocks.readIosPushEnvironment }));

vi.mock('@/config/env', () => ({
  get AUTH_REGION() {
    return envState.buildRegion;
  },
  BUILD_AUTH_REGION: 'cn',
  getActiveMobileSessionRealm: () => envState.activeRealm,
  loadMobileEndpointsForRealm: mocks.loadMobileEndpointsForRealm,
  getMobileEndpointForRealm: (realm: 'cn' | 'global') =>
    envState.endpointByRealm[realm],
  setDeviceLinkApiBaseOverride: () => {},
}));

vi.mock('@/config/devServerEnvironment', () => ({
  getDevServerEnvironment: () => devEnvironmentState.active,
}));

import {
  type AuthedApiFetch,
  configureForegroundNotificationBehavior,
  retryPendingUnregister,
  syncPushRegistration,
  enablePushNotifications,
  writePushEnabled,
  readPushEnabled,
  unregisterPushTokenBestEffort,
} from '@/notifications/pushNotifications';
import { setActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';
import { readAndroidPushAvailability, setAndroidPushAvailability } from '../notifications/androidPushAvailability';

import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';

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
  // Real mutation module + native token event simulation: old code re-PUT after logout DELETE.
  // Also covers duplicate bootstrap events, which the separately mocked bridge test cannot prove.
  it('fences native token callbacks during logout and permits a new authenticated lifecycle', async () => {
    const requests: string[] = [], events: Promise<unknown>[] = [];
    const apiFetch: AuthedApiFetch = async (_path, opts) => { requests.push(opts.method!); return {registered:true} as never; };
    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => { requests.push(opts.method); return {ok:true,status:200}; }));
    mocks.getDevicePushTokenAsync.mockImplementation(async () => {
      const token = { type:'ios' as const, data:'apns-device-token' };
      events.push(syncPushRegistration({enabled:true,apiFetch,deviceToken:token}));
      return token;
    });
    await syncPushRegistration({enabled:true,apiFetch});
    await Promise.all(events.splice(0));
    expect(requests).toEqual(['PUT','PUT']);
    // AuthContext clears the synchronous owner before its async cleanup, while React still
    // presents isAuthenticated=true. Both listener and bootstrap work must be rejected here.
    setMobileAuthOwner(null);
    await unregisterPushTokenBestEffort('fixture-access-token','cn');
    await syncPushRegistration({enabled:true,apiFetch});
    await Promise.all(events.splice(0));
    expect(requests).toEqual(['PUT','PUT','DELETE','DELETE']);
    setMobileAuthOwner('next-user','cn');
    await syncPushRegistration({enabled:true,apiFetch});
    await Promise.all(events.splice(0));
    expect(requests.slice(4)).toEqual(['PUT','PUT']);
  });
  // Codex review r4525360529: a failed first registration leaves no lease, which used to make
  // every later valid token event a silent no-op until restart or re-login.
  it('lets a later token event recover after the first registration failed', async () => {
    const offline = vi.fn(async () => { throw new Error('offline'); });
    await expect(syncPushRegistration({ enabled: true, apiFetch: offline as any })).rejects.toThrow();
    const online = vi.fn().mockResolvedValue({ registered: true });
    const token = { type: 'ios' as const, data: 'apns-device-token' };
    await expect(syncPushRegistration({ enabled: true, apiFetch: online, deviceToken: token })).resolves.toBe('registered');
    expect(online).toHaveBeenCalled();
    await expect(syncPushRegistration({ enabled: true, apiFetch: online, deviceToken: token })).resolves.toBe('skipped');
  });
  it('retains per-service registration failure without leaking tokens or errors', async () => {
    const apiFetch = vi.fn(async (path: string) => {
      if (path === '/v1/push-token') throw Object.assign(new Error('secret-token-in-error'), { status: 503 });
      return { registered: true };
    });
    await expect(syncPushRegistration({ enabled: true, apiFetch: apiFetch as any })).rejects.toThrow();
    const raw = store.get('cindy.push.lastRegistration')!;
    const result = JSON.parse(raw);
    expect(result).toMatchObject({ realm: 'cn', appVariant: 'cn', apnsEnv: 'sandbox', stage: 'failed:registering' });
    expect(result.endpoints).toEqual(expect.arrayContaining([
      { service: 'device-link', outcome: 'accepted' },
      { service: 'chat', outcome: 'failed', status: 503 },
    ]));
    expect(raw).not.toContain('secret-token-in-error');
    expect(raw).not.toContain('apns-device-token');
    expect(raw).not.toContain('https://');
  });

  // Codex review r4525113907: the deduped token-listener callback queued by the bootstrap
  // read used to overwrite the real result with a bare `skipped` record.
  it('keeps the registration result when the queued token event is deduplicated', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ registered: true });
    const events: Promise<unknown>[] = [];
    mocks.getDevicePushTokenAsync.mockImplementation(async () => {
      const token = { type: 'ios' as const, data: 'apns-device-token' };
      events.push(syncPushRegistration({ enabled: true, apiFetch, deviceToken: token }));
      return token;
    });
    await syncPushRegistration({ enabled: true, apiFetch });
    await Promise.all(events.splice(0));
    const record = JSON.parse(store.get('cindy.push.lastRegistration')!);
    expect(record).toMatchObject({ stage: 'registered', apnsEnv: 'sandbox' });
    expect(record.endpoints).toEqual(expect.arrayContaining([{ service: 'device-link', outcome: 'accepted' }]));
  });

  it('records native failure before HTTP and replaces it after a successful retry', async () => {
    mocks.getDevicePushTokenAsync.mockRejectedValueOnce(new Error('private native details'));
    const apiFetch = vi.fn().mockResolvedValue({ registered: true });
    await expect(syncPushRegistration({ enabled: true, apiFetch })).rejects.toThrow();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(JSON.parse(store.get('cindy.push.lastRegistration')!)).toMatchObject({ stage: 'failed:device-token' });
    await syncPushRegistration({ enabled: true, apiFetch });
    expect(JSON.parse(store.get('cindy.push.lastRegistration')!)).toMatchObject({ stage: 'registered' });
  });

  // Unit r4512939585: first opt-in must notify the direct receiver before Google
  // resolves. Existing registration tests only inspect the final sync result.
  // Minimal input: permission granted, Google token promise pending indefinitely.
  it('activates Android delivery after permission and before waiting for Google', async () => {
    envState.platform = 'android';
    await writePushEnabled(false);
    let tokenEntered!: () => void;
    const entered = new Promise<void>(resolve => { tokenEntered = resolve; });
    let failToken!: (error: Error) => void;
    mocks.getDevicePushTokenAsync.mockImplementationOnce(() => {
      tokenEntered(); return new Promise((_, reject) => { failToken = reject; });
    });
    const onEnabled = vi.fn();
    const sync = enablePushNotifications({ apiFetch: vi.fn(), onEnabled });
    await entered;
    try {
      expect(await readPushEnabled()).toBe(true);
      expect(onEnabled).toHaveBeenCalledTimes(1);
    } finally { failToken(new Error('Google unavailable')); await sync; }
  });
  it.each(['ios', 'denied'])('does not early-activate delivery for %s', async condition => {
    envState.platform = condition === 'ios' ? 'ios' : 'android';
    if (condition === 'denied') mocks.getPermissionsAsync.mockResolvedValueOnce({ status: 'denied', canAskAgain: false });
    const onEnabled = vi.fn();
    mocks.getDevicePushTokenAsync.mockImplementationOnce(async () => {
      expect(onEnabled).not.toHaveBeenCalled();
      return { data: 'native-token' };
    });
    const result = await enablePushNotifications({ apiFetch: async <T,>() => ({} as T), onEnabled });
    expect(result).toBe(condition === 'ios' ? 'registered' : 'permission-denied');
    expect(onEnabled).toHaveBeenCalledTimes(condition === 'ios' ? 1 : 0);
  });
  // Unit: task-only registration cannot turn off the shared native fallback.
  // Existing tests only covered throwing registration failures, not optional 404/405.
  it.each([404, 405])('keeps direct delivery when task push succeeds but chat registration returns %s', async status => {
    envState.platform = 'android'; envState.activeRealm = 'global';
    setAndroidPushAvailability('available');
    const apiFetch = vi.fn(async (path: string) => {
      if (path === '/v1/push-token') throw Object.assign(new Error('unsupported'), { status });
      return {};
    });
    await expect(syncPushRegistration({ enabled: true, apiFetch: apiFetch as any })).resolves.toBe('registered');
    expect(readAndroidPushAvailability()).toBe('unavailable');
    expect(readStoredRealms(REGISTERED_KEY)).toEqual(['global']);
  });
  it('allows stopping the shared direct service only after both push registrations succeed', async () => {
    envState.platform = 'android';
    setAndroidPushAvailability('unavailable');
    await expect(syncPushRegistration({ enabled: true, apiFetch: vi.fn(async () => ({})) as any })).resolves.toBe('registered');
    expect(readAndroidPushAvailability()).toBe('available');
  });
  // Unit: a cached FCM token must not make first enable fail when cloud registration is offline.
  it('keeps Android opt-in usable through the direct channel when cloud registration fails', async () => {
    envState.platform = 'android';
    const apiFetch = vi.fn(async () => { throw new Error('offline'); });
    await expect(syncPushRegistration({ enabled: true, apiFetch })).resolves.toBe('local-only');
    expect(readStoredRealms(REGISTERED_KEY)).toEqual(['cn']);
    const { readAndroidPushAvailability } = await import('../notifications/androidPushAvailability');
    expect(readAndroidPushAvailability()).toBe('unavailable');
  });
  it('compensates both endpoints when first enable partially fails, retaining retry state if DELETE fails', async () => {
    let failDelete = true;
    const apiFetch = vi.fn(async (path: string, opts: { method?: string }) => {
      if (path === '/v1/push-token' && (opts.method === 'PUT' || failDelete)) throw new Error('offline');
      return {};
    });
    await expect(syncPushRegistration({ enabled: true, apiFetch: apiFetch as any })).rejects.toThrow('offline');
    expect(apiFetch.mock.calls.filter(call => call[1].method === 'DELETE').map(call => call[0]))
      .toEqual(['/api/device-link/push-token', '/v1/push-token']);
    expect(readStoredRealms(PENDING_KEY)).toEqual(['cn']);
    expect(readStoredRealms(REGISTERED_KEY)).toEqual(['cn']);
    failDelete = false;
    await retryPendingUnregister(apiFetch as any);
    expect(readStoredRealms(PENDING_KEY)).toEqual([]);
    expect(readStoredRealms(REGISTERED_KEY)).toEqual([]);
  });
  // Same group, another thread must still be noticeable while reading the main timeline.
  it('passes the thread route to the foreground visibility gate', async () => {
    const room = '00000000-0000-4000-8000-000000000001';
    const message = '00000000-0000-4000-8000-000000000002';
    const thread = '00000000-0000-4000-8000-000000000003';
    const reading = vi.fn((_route: string) => false);
    configureForegroundNotificationBehavior(reading);
    const handler = mocks.setNotificationHandler.mock.calls.at(-1)![0];
    const notification = { request: { content: { data: { deepLink: `/companions/groups/${room}?messageId=${message}&threadRootId=${thread}` } } } };
    expect(await handler.handleNotification(notification)).toMatchObject({ shouldShowBanner: true });
    expect(reading.mock.calls[0][0]).toContain(`threadRootId=${thread}`);
    reading.mockReturnValue(true);
    expect(await handler.handleNotification(notification)).toMatchObject({ shouldShowBanner: false, shouldPlaySound: false });
  });
  beforeEach(() => {
    setMobileAuthOwner(null);
    setMobileAuthOwner('fixture-user', 'cn');
    vi.clearAllMocks();
    store.clear();
    envState.platform = 'ios';
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
    mocks.readIosPushEnvironment.mockResolvedValue('development');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers a development-signed Release build with sandbox APNs', async () => {
    vi.stubGlobal('__DEV__', false);
    const apiFetch = vi.fn().mockResolvedValue({ registered: true });
    await expect(syncPushRegistration({ enabled: true, apiFetch })).resolves.toBe('registered');
    expect(apiFetch.mock.calls[0][1].body).toMatchObject({ apnsEnv: 'sandbox' });
  });

  // Regression: iOS token reads emit another token event. A rotation callback
  // must upload the supplied token, not request a token and feed itself forever.
  it('registers a rotated token without requesting another native token', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ registered: true });
    await syncPushRegistration({ enabled: true, apiFetch });
    apiFetch.mockClear(); mocks.getDevicePushTokenAsync.mockClear();
    await expect(syncPushRegistration({ enabled: true, apiFetch,
      deviceToken: { type: 'ios', data: 'rotated-device-token' },
    })).resolves.toBe('registered');
    expect(mocks.getDevicePushTokenAsync).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(2);
    for (const [, options] of apiFetch.mock.calls) {
      expect(options.body).toMatchObject({ token: 'rotated-device-token', apnsEnv: 'sandbox' });
    }
  });

  it('never uploads a token with an unknown signing environment', async () => {
    mocks.readIosPushEnvironment.mockResolvedValue(null);
    const apiFetch = vi.fn();
    await expect(syncPushRegistration({ enabled: true, apiFetch })).rejects.toThrow('unknown APNs');
    expect(apiFetch).not.toHaveBeenCalled();
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

  // 自建中转不转发系统推送(docs/self-hosted-relay-plan.md §5.3、§7):不在官方 device-link 登记 token
  // (伙伴消息的 Chat Server 登记不受影响),关闭时仍向官方地址注销以前的登记。
  it('自建中转下不登记 device-link 推送,注销仍发往官方地址', async () => {
    setActiveSelfHostedRelay({ relayId: 'relay-1', name: 'Home', baseUrl: 'https://relay.home.example', credential: 'relay-credential', signing: null });
    try {
      const apiFetch = vi.fn().mockResolvedValue({});
      await expect(syncPushRegistration({ enabled: true, apiFetch })).resolves.toBe('registered');
      expect(apiFetch.mock.calls.map(([path, opts]) => `${opts.method} ${path}`)).toEqual(['PUT /v1/push-token']);
      apiFetch.mockClear();
      await expect(syncPushRegistration({ enabled: false, apiFetch })).resolves.toBe('unregistered');
      expect(apiFetch).toHaveBeenCalledWith('/api/device-link/push-token', expect.objectContaining({
        baseUrl: 'https://relay.cn.example',
        method: 'DELETE',
      }));
    } finally {
      setActiveSelfHostedRelay(null);
    }
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
    expect(apiFetch).toHaveBeenCalledTimes(4); // Each environment registers task and chat delivery.
    expect(apiFetch.mock.calls.filter(([path]) => path === '/v1/push-token')).toHaveLength(2);
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
    envState.platform = 'ios';
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
    envState.platform = 'ios';
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
    envState.platform = 'ios';
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

    envState.platform = 'ios';
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
