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

const workingStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, { isRunning: boolean }> = new Map();
  const subscribeAll = vi.fn((listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const getRunningSnapshot = vi.fn(() => snapshot);

  return {
    makerChatStore: { subscribeAll, getRunningSnapshot },
    setRunning(running: boolean): void {
      snapshot = running ? new Map([['session-working', { isRunning: true }]]) : new Map();
      for (const listener of listeners) listener();
    },
    reset(): void {
      listeners.clear();
      snapshot = new Map();
      subscribeAll.mockClear();
      getRunningSnapshot.mockClear();
    },
  };
});

vi.mock('@/vendor/tapdb/tapdb.esm.min.js', () => ({ default: tapdb }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: workingStore.makerChatStore }));
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
/**
 * tapdbClient 挂在 window 上的交互监听(focus / keydown / pointerdown)。
 * 与 visibilityHandlers 同理,每个 importClient 都会重新注册,这里按事件类型
 * 只保留最新一个,fireWindowEvent 只打本用例的监听器。
 */
const windowHandlers = new Map<string, () => void>();
let originalNavigatorLocksDescriptor: PropertyDescriptor | undefined;

function fireWindowEvent(type: 'focus' | 'keydown' | 'pointerdown'): void {
  windowHandlers.get(type)?.();
}

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

/**
 * Chromium Web Locks 的最小测试替身:同名请求严格串行,让两个独立 module 实例
 * 能在同一 fake-timer tick 内竞争,再由第二个锁持有者重读 localStorage。
 */
function installSerializedWebLocks() {
  let tail = Promise.resolve();
  const request = vi.fn((name: string, callback: (lock: { name: string }) => void) => {
    const current = tail.then(() => callback({ name }));
    tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  });
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: { request },
  });
  return request;
}

function installDeferredWebLock() {
  let acquire: (() => void) | null = null;
  const request = vi.fn(
    (name: string, callback: (lock: { name: string }) => void) =>
      new Promise<void>((resolve, reject) => {
        acquire = () => {
          Promise.resolve(callback({ name })).then(resolve, reject);
        };
      }),
  );
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: { request },
  });
  return {
    request,
    acquire(): void {
      if (!acquire) throw new Error('Web Lock request was not queued');
      acquire();
    },
  };
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
  originalNavigatorLocksDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'locks');
  settingsListener = null;
  authListener = null;
  visibilityHandlers.length = 0;
  windowHandlers.clear();
  workingStore.reset();
  Object.values(tapdb).forEach((fn) => fn.mockReset());
  vi.spyOn(document, 'addEventListener').mockImplementation(((
    type: string,
    handler: EventListenerOrEventListenerObject,
  ) => {
    if (type === 'visibilitychange' && typeof handler === 'function') {
      visibilityHandlers.push(() => handler(new Event('visibilitychange')));
    }
  }) as typeof document.addEventListener);
  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    handler: EventListenerOrEventListenerObject,
  ) => {
    if (typeof handler === 'function') {
      windowHandlers.set(type, () => handler(new Event(type)));
    }
  }) as typeof window.addEventListener);
});

afterEach(() => {
  if (originalNavigatorLocksDescriptor) {
    Object.defineProperty(window.navigator, 'locks', originalNavigatorLocksDescriptor);
  } else {
    Reflect.deleteProperty(window.navigator, 'locks');
  }
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
    (
      window as unknown as { electronAPI: { getAnalyticsSettings: unknown } }
    ).electronAPI.getAnalyticsSettings = vi.fn(
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
    (
      window as unknown as { electronAPI: { getAnalyticsSettings: unknown } }
    ).electronAPI.getAnalyticsSettings = vi.fn(async () => {
      throw new Error('ipc down');
    });
    const client = await importClient();

    client.initTapdb();
    await flush();

    expect(tapdb.init).not.toHaveBeenCalled();
  });
});

// ── 交互驱动的活跃上报 ───────────────────────────────────────────────────────
//
// 活跃事件由真实交互(focus / keydown / pointerdown)或会话 working 触发,
// 共用 30 分钟节流;working timer 不对齐 0 点。历史背景见 tapdbClient.ts 头部。

describe('engagement-driven activity reporting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 28, 12, 0, 0));
    // 跨窗口共享节流存 localStorage,不随 resetModules 清空,测试间必须显式隔离。
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function initAllowed() {
    installElectronApi(ALLOWED);
    const client = await importClient();
    client.initTapdb();
    await flush();
    return client;
  }

  it('app_start consumes the throttle window — input right after startup does not double-report', async () => {
    await initAllowed();
    expect(tapdb.pvEvent).toHaveBeenCalledTimes(1); // app_start

    fireWindowEvent('keydown');

    expect(tapdb.pvEvent).toHaveBeenCalledTimes(1);
  });

  it('reports app_engaged at most once per throttle window across rapid inputs', async () => {
    await initAllowed();

    vi.advanceTimersByTime(30 * 60 * 1000);
    fireWindowEvent('keydown');
    fireWindowEvent('keydown');
    fireWindowEvent('pointerdown');

    expect(tapdb.pvEvent).toHaveBeenCalledTimes(2); // app_start + 1 × app_engaged
    expect(tapdb.pvEvent).toHaveBeenLastCalledWith({ '#tag': 'app_engaged' });

    vi.advanceTimersByTime(30 * 60 * 1000);
    fireWindowEvent('focus');

    expect(tapdb.pvEvent).toHaveBeenCalledTimes(3);
  });

  it('each of focus / keydown / pointerdown can trigger a report', async () => {
    await initAllowed();

    for (const type of ['focus', 'keydown', 'pointerdown'] as const) {
      vi.advanceTimersByTime(30 * 60 * 1000);
      const before = tapdb.pvEvent.mock.calls.length;
      fireWindowEvent(type);
      expect(tapdb.pvEvent.mock.calls.length).toBe(before + 1);
    }
  });

  it('reports every 30 minutes while a session remains working', async () => {
    await initAllowed();

    workingStore.setRunning(true);
    expect(tapdb.pvEvent).toHaveBeenCalledTimes(1); // app_start 已占用首个窗口

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(tapdb.pvEvent).toHaveBeenCalledTimes(2);
    expect(tapdb.pvEvent).toHaveBeenLastCalledWith({ '#tag': 'app_engaged' });

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(tapdb.pvEvent).toHaveBeenCalledTimes(3);
    expect(tapdb.pvEvent).toHaveBeenLastCalledWith({ '#tag': 'app_engaged' });
  });

  it('starts the rolling report when a session was already working before TapDB initializes', async () => {
    workingStore.setRunning(true);
    await initAllowed();

    expect(tapdb.pvEvent).toHaveBeenCalledTimes(1); // app_start
    vi.advanceTimersByTime(30 * 60 * 1000);

    expect(tapdb.pvEvent).toHaveBeenCalledTimes(2);
    expect(tapdb.pvEvent).toHaveBeenLastCalledWith({ '#tag': 'app_engaged' });
  });

  it('does not postpone the next report when working progress notifies repeatedly', async () => {
    await initAllowed();
    workingStore.setRunning(true);

    vi.advanceTimersByTime(29 * 60 * 1000);
    workingStore.setRunning(true); // 模拟 text/tool progress 的高频全局 notify
    vi.advanceTimersByTime(60 * 1000);

    expect(tapdb.pvEvent).toHaveBeenCalledTimes(2);
    expect(tapdb.pvEvent).toHaveBeenLastCalledWith({ '#tag': 'app_engaged' });
  });

  it('serializes aligned working timers across renderer windows', async () => {
    const lockRequest = installSerializedWebLocks();
    await initAllowed();
    // resetModules 模拟独立 renderer 的 module state;TapDB mock、working store 与
    // localStorage 仍按真实同源窗口共享。
    await initAllowed();
    tapdb.pvEvent.mockClear();

    workingStore.setRunning(true);
    vi.advanceTimersByTime(30 * 60 * 1000);
    await flush();
    await flush();

    expect(lockRequest).toHaveBeenCalledTimes(2);
    expect(tapdb.pvEvent).toHaveBeenCalledTimes(1);
    expect(tapdb.pvEvent).toHaveBeenCalledWith({ '#tag': 'app_engaged' });
  });

  it('drops a queued working report if work stops before the lock is acquired', async () => {
    const lock = installDeferredWebLock();
    await initAllowed();
    tapdb.pvEvent.mockClear();

    workingStore.setRunning(true);
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(lock.request).toHaveBeenCalledTimes(1);

    workingStore.setRunning(false);
    lock.acquire();
    await flush();
    await flush();

    expect(tapdb.pvEvent).not.toHaveBeenCalled();
  });

  it('stops the rolling report as soon as no session is working', async () => {
    await initAllowed();
    workingStore.setRunning(true);

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(tapdb.pvEvent).toHaveBeenCalledTimes(2);

    workingStore.setRunning(false);
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(tapdb.pvEvent).toHaveBeenCalledTimes(2);
  });

  it('shares one throttle window between working and human input', async () => {
    await initAllowed();
    workingStore.setRunning(true);

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(tapdb.pvEvent).toHaveBeenCalledTimes(2); // working

    fireWindowEvent('keydown');
    expect(tapdb.pvEvent).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(tapdb.pvEvent).toHaveBeenCalledTimes(3); // working 继续
  });

  it('sends nothing at local midnight without user input', async () => {
    // 本次改造的核心断言:过夜挂机不再产生活跃事件,0 点尖峰结构性消失。
    vi.setSystemTime(new Date(2026, 6, 28, 23, 59, 0));
    await initAllowed();
    tapdb.pvEvent.mockClear();
    tapdb.setUser.mockClear();

    vi.advanceTimersByTime(2 * 60 * 1000); // 23:59 → 次日 00:01,期间无交互

    expect(tapdb.pvEvent).not.toHaveBeenCalled();
    expect(tapdb.setUser).not.toHaveBeenCalled();
  });

  it('uses a rolling working timer across midnight instead of firing at 00:00', async () => {
    vi.setSystemTime(new Date(2026, 6, 28, 23, 59, 0));
    await initAllowed();
    authListener?.({ isAuthenticated: true, user: { id: 'user-1' } });
    workingStore.setRunning(true);
    tapdb.pvEvent.mockClear();
    tapdb.setUser.mockClear();

    vi.advanceTimersByTime(2 * 60 * 1000); // 00:01
    workingStore.setRunning(true); // 0 点后的 progress notify 也不能绕过滚动窗口
    expect(tapdb.pvEvent).not.toHaveBeenCalled();
    expect(tapdb.setUser).not.toHaveBeenCalled();

    vi.advanceTimersByTime(28 * 60 * 1000); // 00:29,距上次 app_start 30 分钟
    expect(tapdb.pvEvent).toHaveBeenCalledWith({ '#tag': 'app_engaged' });
    expect(tapdb.setUser).toHaveBeenCalledTimes(1);
  });

  it('first engagement of a new day re-binds the account, later windows do not', async () => {
    await initAllowed();
    authListener?.({ isAuthenticated: true, user: { id: 'user-1' } });
    expect(tapdb.setUser).toHaveBeenCalledTimes(1); // 当天登录时绑定

    // 次日 09:00 用户回来:首条交互既发 app_engaged,也重新 setUser(账号 DAU)。
    vi.setSystemTime(new Date(2026, 6, 29, 9, 0, 0));
    fireWindowEvent('pointerdown');

    expect(tapdb.pvEvent).toHaveBeenLastCalledWith({ '#tag': 'app_engaged' });
    expect(tapdb.setUser).toHaveBeenCalledTimes(2);

    // 同日后续窗口只发 pvEvent,不重复 setUser。
    vi.advanceTimersByTime(30 * 60 * 1000);
    fireWindowEvent('keydown');

    expect(tapdb.setUser).toHaveBeenCalledTimes(2);
  });

  it('seeds identity via authInitialize so a secondary window does not misread refresh as login', async () => {
    // 登录后才打开的二级窗口错过初始广播:补种身份后,半夜 token 刷新广播的
    // 同一账号不得被当成「身份变化」触发 setUser。
    installElectronApi(ALLOWED);
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.authInitialize =
      vi.fn(async () => ({ isAuthenticated: true, user: { id: 'user-1' } }));
    const client = await importClient();
    client.initTapdb();
    await flush();
    tapdb.setUser.mockClear();

    vi.setSystemTime(new Date(2026, 6, 29, 3, 0, 0));
    authListener?.({ isAuthenticated: true, user: { id: 'user-1' } });

    expect(tapdb.setUser).not.toHaveBeenCalled();
  });

  it('a token-refresh auth broadcast on a new day does not emit setUser (no interaction)', async () => {
    // auth:state-change 也由定时 token 刷新广播:挂机过夜的机器不得凭空产生
    // 当日账号活跃 —— 跨天重绑只走交互路径(reportActive)。
    await initAllowed();
    authListener?.({ isAuthenticated: true, user: { id: 'user-1' } });
    expect(tapdb.setUser).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(2026, 6, 29, 3, 0, 0));
    authListener?.({ isAuthenticated: true, user: { id: 'user-1' } });

    expect(tapdb.setUser).toHaveBeenCalledTimes(1);
  });

  it('a window opened before midnight does not swallow the next day’s first interaction', async () => {
    // 23:55 上报后窗口本该到 00:25 —— 但已换日,00:03 的交互必须放行并补当日 setUser,
    // 否则「只在次日凌晨窗口内用了一下」的用户从第二天的活跃里整个消失。
    vi.setSystemTime(new Date(2026, 6, 28, 23, 55, 0));
    await initAllowed(); // app_start 消耗窗口至次日 00:25
    authListener?.({ isAuthenticated: true, user: { id: 'user-1' } });
    tapdb.pvEvent.mockClear();
    tapdb.setUser.mockClear();

    vi.setSystemTime(new Date(2026, 6, 29, 0, 3, 0));
    fireWindowEvent('keydown');

    expect(tapdb.pvEvent).toHaveBeenCalledWith({ '#tag': 'app_engaged' });
    expect(tapdb.setUser).toHaveBeenCalledTimes(1);
  });

  it('a recent report from another window suppresses this window’s app_engaged (shared throttle)', async () => {
    // detached 侧栏窗口与主窗口各有一份 module 态:共享节流经 localStorage 生效,
    // 本窗口静默让位,窗口过期后恢复正常上报。
    await initAllowed();
    tapdb.pvEvent.mockClear();

    vi.advanceTimersByTime(30 * 60 * 1000); // 本窗口内存窗口已过期
    window.localStorage.setItem('tapdb.lastEngagedReportAt', String(Date.now() - 30 * 1000));
    fireWindowEvent('keydown');

    expect(tapdb.pvEvent).not.toHaveBeenCalled();

    // 让位后本窗口对齐共享窗口终点(还剩 29.5 分钟),而不是自己再吃满 30 分钟 ——
    // 共享窗口一过就能上报,交替交互不会把间隔拉到近 60 分钟。
    vi.advanceTimersByTime(29 * 60 * 1000 + 31 * 1000);
    fireWindowEvent('keydown');

    expect(tapdb.pvEvent).toHaveBeenCalledWith({ '#tag': 'app_engaged' });
  });

  it('ignores input while unconsented, then reports normally after consent', async () => {
    installElectronApi(DENIED);
    const client = await importClient();
    client.initTapdb();
    await flush();

    fireWindowEvent('keydown');
    expect(tapdb.pvEvent).not.toHaveBeenCalled();

    // 未放行期间的交互不消耗节流窗口:同意后立刻能发 app_start。
    settingsListener?.(ALLOWED);
    expect(tapdb.pvEvent).toHaveBeenCalledWith({ '#tag': 'app_start' });
  });

  it('stops engagement reports immediately after opt-out', async () => {
    await initAllowed();
    workingStore.setRunning(true);
    settingsListener?.({ privacyConsentAccepted: true, analyticsEnabled: false, allowed: false });
    tapdb.pvEvent.mockClear();

    vi.advanceTimersByTime(60 * 60 * 1000);
    fireWindowEvent('keydown');

    expect(tapdb.pvEvent).not.toHaveBeenCalled();
  });
});
