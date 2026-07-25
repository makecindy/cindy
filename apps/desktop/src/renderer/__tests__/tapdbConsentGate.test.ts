// @vitest-environment jsdom

/**
 * tapdbConsentGate.test.ts
 * ---------------------------------------------------------------------------
 * TapDB 同意闸的 renderer 侧行为。这是本次改动的核心不变量:
 *
 *   用户没有明示同意《隐私政策》之前,TapDB SDK 的 init 一次都不能被调用。
 *
 * 之前的实现是主视图一挂载就无条件 init(并立刻上报 device_login + page_view),
 * 违反 TapTap 自己的合规要求。这里把「不许 init」钉成回归测试。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tapdb = vi.hoisted(() => ({
  init: vi.fn(),
  setSuperProperties: vi.fn(),
  pvEvent: vi.fn(),
  track: vi.fn(),
  setUser: vi.fn(),
  logout: vi.fn(),
  optInTracking: vi.fn(),
  optOutTracking: vi.fn(),
}));

vi.mock('@/vendor/tapdb/tapdb.esm.min.js', () => ({ default: tapdb }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../../shared/endpoints', () => ({ TAPDB_EVENT_URL: 'https://example.invalid/event' }));

type SettingsPayload = {
  privacyConsentAccepted: boolean;
  analyticsEnabled: boolean;
  allowed: boolean;
};

let settingsListener: ((payload: SettingsPayload) => void) | null = null;
let authListener: ((state: unknown) => void) | null = null;
let getAnalyticsSettings: () => Promise<SettingsPayload>;
/** 本文件内注册过的 visibilitychange 回调(见 hidePage)。 */
const visibilityHandlers: Array<() => void> = [];

function installElectronApi(initial: SettingsPayload): void {
  getAnalyticsSettings = vi.fn(async () => initial);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    appVersion: '9.9.9',
    platform: 'darwin',
    getAnalyticsSettings,
    onAnalyticsSettingsChange: (cb: (payload: SettingsPayload) => void) => {
      settingsListener = cb;
      return () => {
        settingsListener = null;
      };
    },
    onAuthStateChange: (cb: (state: unknown) => void) => {
      authListener = cb;
      return () => {
        authListener = null;
      };
    },
    onTapdbDailyActive: () => () => {},
  };
}

async function importClient() {
  vi.resetModules();
  return import('../analytics/tapdbClient');
}

/**
 * 模拟窗口被切到后台。
 *
 * 不用 dispatchEvent:jsdom 的 document 在用例之间共享,而每次 importClient 都会
 * 再注册一个 visibilitychange 监听器,广播会把前面用例残留的监听器一起打起来。
 * 这里只调用**本用例**注册的那一个。
 */
function hidePage(): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  visibilityHandlers.at(-1)?.();
}

/** 让 initTapdb 内部那条 getAnalyticsSettings().then(...) 跑完。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const DENIED: SettingsPayload = {
  privacyConsentAccepted: false,
  analyticsEnabled: true,
  allowed: false,
};
const ALLOWED: SettingsPayload = {
  privacyConsentAccepted: true,
  analyticsEnabled: true,
  allowed: true,
};

beforeEach(() => {
  settingsListener = null;
  authListener = null;
  visibilityHandlers.length = 0;
  Object.values(tapdb).forEach((fn) => fn.mockReset());
  vi.spyOn(document, 'addEventListener').mockImplementation(((
    type: string,
    handler: EventListenerOrEventListenerObject,
  ) => {
    if (type === 'visibilitychange' && typeof handler === 'function') {
      visibilityHandlers.push(() => handler(new Event('visibilitychange')));
    }
  }) as typeof document.addEventListener);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TapDB consent gate', () => {
  it('does not initialize the SDK when consent has not been given', async () => {
    installElectronApi(DENIED);
    const client = await importClient();

    client.initTapdb();
    await flush();

    expect(tapdb.init).not.toHaveBeenCalled();
    expect(tapdb.pvEvent).not.toHaveBeenCalled();
  });

  it('initializes and reports app_start once consent is present at startup', async () => {
    installElectronApi(ALLOWED);
    const client = await importClient();

    client.initTapdb();
    await flush();

    expect(tapdb.init).toHaveBeenCalledTimes(1);
    expect(tapdb.pvEvent).toHaveBeenCalledWith({ '#tag': 'app_start' });
  });

  it('stays silent on auth changes while unconsented', async () => {
    installElectronApi(DENIED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    authListener?.({ isAuthenticated: true, user: { id: 'user-1' } });

    expect(tapdb.init).not.toHaveBeenCalled();
    expect(tapdb.setUser).not.toHaveBeenCalled();
  });

  it('initializes as soon as the user consents, and binds the already-known user id', async () => {
    installElectronApi(DENIED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    // 冷启动已登录:auth 事件早于同意到达,userId 必须被记住而不是丢掉。
    authListener?.({ isAuthenticated: true, user: { id: 'user-1' } });
    expect(tapdb.init).not.toHaveBeenCalled();

    settingsListener?.(ALLOWED);

    expect(tapdb.init).toHaveBeenCalledTimes(1);
    expect(tapdb.setUser).toHaveBeenCalledWith('user-1');
  });

  it('opts out of tracking when the user turns the toggle off', async () => {
    installElectronApi(ALLOWED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    expect(tapdb.init).toHaveBeenCalledTimes(1);

    settingsListener?.({ privacyConsentAccepted: true, analyticsEnabled: false, allowed: false });

    expect(tapdb.optOutTracking).toHaveBeenCalledTimes(1);
  });

  it('opts back in without re-initializing, restoring super properties', async () => {
    installElectronApi(ALLOWED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    tapdb.setSuperProperties.mockClear();

    settingsListener?.({ privacyConsentAccepted: true, analyticsEnabled: false, allowed: false });
    settingsListener?.(ALLOWED);

    // optOutTracking 会清空 superProperties,重新放行时必须补回来。
    expect(tapdb.init).toHaveBeenCalledTimes(1);
    expect(tapdb.optInTracking).toHaveBeenCalled();
    expect(tapdb.setSuperProperties).toHaveBeenCalledWith({
      '#app_version': '9.9.9',
      '#platform': 'darwin',
    });
  });

  // ── page_hide 不能走 SDK 的 beacon 路径 ──────────────────────────────────
  //
  // vendored SDK 的 trackWithBeacon() 没有 _isCollectData() 闸,而 PageLifeCycle
  // 的 trackPageHideEvent() 正是用它。若开着 autoTrack.pageHide,用户关掉统计后
  // 每次切走窗口仍会发出一条带 deviceId 的 beacon。

  it('never enables the SDK-side auto page-hide beacon', async () => {
    installElectronApi(ALLOWED);
    const client = await importClient();

    client.initTapdb();
    await flush();

    expect(tapdb.init).toHaveBeenCalledWith(
      expect.objectContaining({ autoTrack: { pageShow: true, pageHide: false } }),
    );
  });

  it('reports page_hide itself while allowed', async () => {
    installElectronApi(ALLOWED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    hidePage();

    expect(tapdb.track).toHaveBeenCalledWith('page_hide');
  });

  it('does not report page_hide after opting out', async () => {
    installElectronApi(ALLOWED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    settingsListener?.({ privacyConsentAccepted: true, analyticsEnabled: false, allowed: false });
    tapdb.track.mockClear();

    hidePage();

    expect(tapdb.track).not.toHaveBeenCalled();
  });

  it('does not report page_hide while unconsented', async () => {
    installElectronApi(DENIED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    hidePage();

    expect(tapdb.track).not.toHaveBeenCalled();
  });

  it('discards an initial snapshot that lost the race to a newer broadcast', async () => {
    // getAnalyticsSettings 的 IPC 往返期间用户关掉了开关,关闭广播先到。那条广播
    // 比初始快照新,旧快照不能把 optInTracking() 又打开。
    let resolveRead: (payload: SettingsPayload) => void = () => {};
    installElectronApi(ALLOWED);
    (window as unknown as { electronAPI: { getAnalyticsSettings: unknown } }).electronAPI
      .getAnalyticsSettings = vi.fn(
        () =>
          new Promise<SettingsPayload>((resolve) => {
            resolveRead = resolve;
          }),
      );
    const client = await importClient();

    client.initTapdb();
    await flush();

    settingsListener?.({ privacyConsentAccepted: true, analyticsEnabled: false, allowed: false });
    resolveRead(ALLOWED);
    await flush();

    expect(tapdb.init).not.toHaveBeenCalled();
    expect(tapdb.optInTracking).not.toHaveBeenCalled();
  });

  it('retries the opt-out when the SDK call throws', async () => {
    // optOutTracking 可能抛(比如它依赖的 localStorage 不可用)。如果在调用之前就把
    // reportingAllowed 改成 false,后续每个 allowed:false 的快照都会被 guard 早返回、
    // 永不重试 —— 设置和 UI 都说已关闭,SDK 却还在采集。
    installElectronApi(ALLOWED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    tapdb.optOutTracking.mockImplementationOnce(() => {
      throw new Error('localStorage unavailable');
    });

    const off: SettingsPayload = {
      privacyConsentAccepted: true,
      analyticsEnabled: false,
      allowed: false,
    };
    settingsListener?.(off);
    expect(tapdb.optOutTracking).toHaveBeenCalledTimes(1);

    // 同一个 allowed:false 再来一次,必须重试而不是被 guard 挡掉。
    settingsListener?.(off);
    expect(tapdb.optOutTracking).toHaveBeenCalledTimes(2);
  });

  it('stops our own reporting immediately even if the SDK opt-out throws', async () => {
    // fail closed:用户已经表达了关闭意图,本模块主动发起的上报必须**立刻**停,
    // 不能等 SDK 侧同步成功。SDK 内部还在采集是另一回事,靠后续广播重试。
    installElectronApi(ALLOWED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    tapdb.optOutTracking.mockImplementation(() => {
      throw new Error('localStorage unavailable');
    });

    settingsListener?.({ privacyConsentAccepted: true, analyticsEnabled: false, allowed: false });
    tapdb.track.mockClear();
    hidePage();

    expect(tapdb.track).not.toHaveBeenCalled();
  });

  it('does not bind users after a failed opt-out either', async () => {
    installElectronApi(ALLOWED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    tapdb.optOutTracking.mockImplementation(() => {
      throw new Error('localStorage unavailable');
    });
    settingsListener?.({ privacyConsentAccepted: true, analyticsEnabled: false, allowed: false });
    tapdb.setUser.mockClear();

    authListener?.({ isAuthenticated: true, user: { id: 'user-2' } });

    expect(tapdb.setUser).not.toHaveBeenCalled();
  });

  it('fails closed when the settings read rejects', async () => {
    installElectronApi(DENIED);
    (window as unknown as { electronAPI: { getAnalyticsSettings: unknown } }).electronAPI
      .getAnalyticsSettings = vi.fn(async () => {
        throw new Error('ipc down');
      });
    const client = await importClient();

    client.initTapdb();
    await flush();

    expect(tapdb.init).not.toHaveBeenCalled();
  });
});
