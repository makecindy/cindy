import { beforeEach, describe, expect, it, vi } from 'vitest';

const initializeTapdb = vi.fn();
const setTapdbUserId = vi.fn();
const clearNativeTapdbUser = vi.fn();

const asyncStore = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStore.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      asyncStore.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      asyncStore.delete(key);
    }),
  },
}));

const CONSENT_KEY = 'cindy.mobile.analytics.consent';

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  asyncStore.clear();
  initializeTapdb.mockReset();
  setTapdbUserId.mockReset();
  clearNativeTapdbUser.mockReset();
  initializeTapdb.mockResolvedValue(true);
  setTapdbUserId.mockResolvedValue(undefined);
  clearNativeTapdbUser.mockResolvedValue(undefined);
  // 默认置为「已同意 + 开关开启」,让既有的配置解析用例保持原本的关注点。
  asyncStore.set(CONSENT_KEY, JSON.stringify({ consent: true, enabled: true }));
});

describe('mobile TapDB analytics', () => {
  it('does not initialize without TapTap client config', async () => {
    const tapdb = await importMobileTapdb();

    await expect(tapdb.initMobileTapdb()).resolves.toEqual({ ok: false, reason: 'missing_config' });
    expect(initializeTapdb).not.toHaveBeenCalled();
  });

  it('initializes native TapDB with mobile device-login properties', async () => {
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_ID', 'client-id');
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN', 'client-token');
    vi.stubEnv('EXPO_PUBLIC_TAPDB_CHANNEL', 'TestFlight');
    const tapdb = await importMobileTapdb();

    await expect(tapdb.initMobileTapdb()).resolves.toEqual({ ok: true });

    expect(initializeTapdb).toHaveBeenCalledWith({
      clientId: 'client-id',
      clientToken: 'client-token',
      region: 'cn',
      channel: 'TestFlight',
      properties: {
        xdt_surface: 'mobile',
        xdt_platform: 'ios',
        xdt_app_version: '1.2.3',
      },
    });
  });

  it('prefers self-host JSON config from Expo extra over ambient build env', async () => {
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_ID', 'ambient-id');
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN', 'ambient-token');
    vi.stubEnv('EXPO_PUBLIC_TAPDB_REGION', 'cn');
    const tapdb = await importMobileTapdb({
      cindy: {
        tapdb: {
          clientId: 'json-id',
          clientToken: 'json-token',
          region: 'global',
        },
      },
    });

    await expect(tapdb.initMobileTapdb()).resolves.toEqual({ ok: true });
    expect(initializeTapdb).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'json-id',
      clientToken: 'json-token',
      region: 'global',
    }));
  });

  it('uses AppStore and NPKG as default mobile channels', async () => {
    const tapdb = await importMobileTapdb();

    expect(tapdb.resolveTapdbChannel(undefined, 'ios')).toBe('AppStore');
    expect(tapdb.resolveTapdbChannel(undefined, 'android')).toBe('NPKG');
    expect(tapdb.resolveTapdbChannel(' AndroidBeta ', 'android')).toBe('AndroidBeta');
  });

  it('binds and clears TapDB user id after initialization', async () => {
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_ID', 'client-id');
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN', 'client-token');
    const tapdb = await importMobileTapdb();

    await tapdb.setTapdbUser('user-1');
    await tapdb.clearTapdbUser();

    expect(setTapdbUserId).toHaveBeenCalledWith('user-1');
    expect(clearNativeTapdbUser).toHaveBeenCalled();
  });

  // ── 同意闸(2026-07-25) ──────────────────────────────────────────────────

  it('does not touch the native SDK before the user consents', async () => {
    asyncStore.clear();
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_ID', 'client-id');
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN', 'client-token');
    const tapdb = await importMobileTapdb();

    await expect(tapdb.initMobileTapdb()).resolves.toEqual({
      ok: false,
      reason: 'not_consented',
    });
    expect(initializeTapdb).not.toHaveBeenCalled();
  });

  it('never binds a user id while unconsented', async () => {
    asyncStore.clear();
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_ID', 'client-id');
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN', 'client-token');
    const tapdb = await importMobileTapdb();

    await tapdb.setTapdbUser('user-1');
    await tapdb.clearTapdbUser();

    expect(initializeTapdb).not.toHaveBeenCalled();
    expect(setTapdbUserId).not.toHaveBeenCalled();
    expect(clearNativeTapdbUser).not.toHaveBeenCalled();
  });

  it('stays disabled when consent was given but the toggle is off', async () => {
    asyncStore.set(CONSENT_KEY, JSON.stringify({ consent: true, enabled: false }));
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_ID', 'client-id');
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN', 'client-token');
    const tapdb = await importMobileTapdb();

    await expect(tapdb.initMobileTapdb()).resolves.toEqual({
      ok: false,
      reason: 'not_consented',
    });
    expect(initializeTapdb).not.toHaveBeenCalled();
  });

  it('refuses to bind a user once consent has been revoked, even after a successful init', async () => {
    // 账号 A 同意 → SDK 已 init(initPromise 永久 resolved)→ 登出撤销同意 →
    // 账号 B 走企业 SSO 登录(SSO 被协议门豁免,B 从没同意过)。直接复用缓存的
    // { ok: true } 会给一个从未同意的用户绑定账号标识。
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_ID', 'client-id');
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN', 'client-token');
    const tapdb = await importMobileTapdb();
    const consentStore = await import('@/analytics/analyticsConsentStore');

    await tapdb.setTapdbUser('user-a');
    expect(setTapdbUserId).toHaveBeenCalledWith('user-a');

    await consentStore.clearAnalyticsConsent();
    setTapdbUserId.mockClear();

    await tapdb.setTapdbUser('user-b-via-sso');

    expect(setTapdbUserId).not.toHaveBeenCalled();
  });

  it('stops binding users once the toggle is switched off', async () => {
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_ID', 'client-id');
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN', 'client-token');
    const tapdb = await importMobileTapdb();
    const consentStore = await import('@/analytics/analyticsConsentStore');

    await tapdb.setTapdbUser('user-1');
    await consentStore.setAnalyticsEnabled(false);
    setTapdbUserId.mockClear();

    await tapdb.setTapdbUser('user-1');

    expect(setTapdbUserId).not.toHaveBeenCalled();
  });

  it('initializes on the retry that follows consent (failure is not cached)', async () => {
    asyncStore.clear();
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_ID', 'client-id');
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN', 'client-token');
    const tapdb = await importMobileTapdb();
    const consentStore = await import('@/analytics/analyticsConsentStore');

    // 冷启动那次被同意闸挡住
    await expect(tapdb.initMobileTapdb()).resolves.toEqual({
      ok: false,
      reason: 'not_consented',
    });

    // 用户在登录页点了「同意」
    await consentStore.acceptPrivacyConsent();

    await expect(tapdb.initMobileTapdb()).resolves.toEqual({ ok: true });
    expect(initializeTapdb).toHaveBeenCalledTimes(1);
  });
});

async function importMobileTapdb(extra: Record<string, unknown> = {}) {
  vi.doMock('xdt-tapdb', () => ({
    initializeTapdb,
    setTapdbUserId,
    clearTapdbUser: clearNativeTapdbUser,
  }));
  vi.doMock('react-native', () => ({
    Platform: { OS: 'ios' },
  }));
  vi.doMock('expo-constants', () => ({
    default: {
      nativeAppVersion: '1.2.3',
      expoConfig: { version: '1.0.0', extra },
    },
  }));
  return import('@/analytics/mobileTapdb');
}
