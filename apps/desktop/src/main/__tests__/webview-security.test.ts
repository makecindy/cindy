/**
 * webview-security 单测 —— 模拟恶意 will-attach-webview 输入,断言 hardener 把
 * 危险开关全部锁死、partition 强制覆盖。
 *
 * 这里只测纯函数 `applyWebviewHardening` —— 不需要起 Electron app,直接构造
 * webPreferences / params 字典喂进去 + 断言。
 *
 * 攻击面覆盖:
 *   1) Renderer 端 `<webview disablewebsecurity webpreferences="nodeIntegration=1,sandbox=0,...">`
 *      → 解析后会变成 webPreferences.nodeIntegration=true / sandbox=false / params.disablewebsecurity="true"。
 *      hardener 必须把它们覆盖回安全值。
 *   2) Renderer 端写 `<webview partition="persist:something-else">` —— hardener 必须强制
 *      覆盖成 BROWSER_PARTITION,避免 guest 跑到隔离不到位的 session。
 *   3) Renderer 端写 `<webview preload="file://..."> ` —— renderer 指定的 preload 一律
 *      不信:传了 commentPreloadPath(生产路径,页面评论注入层)时强制覆写为 main
 *      的值;没传时删除该 key。两个分支都不给恶意 preload 留活路。
 *   4) Renderer 端没指定 partition —— hardener 也要补成 BROWSER_PARTITION。
 */

import { EventEmitter } from 'node:events';

import type { BrowserWindow, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BROWSER_PARTITION } from '../../shared/webviewPartition';
import { getEffectiveAppShortcuts, type AppShortcutId } from '../../shared/appShortcuts';
import {
  BLANK_POPUP_WINDOW_WEB_PREFERENCES,
  DEFERRED_POPUP_ROUTE_TIMEOUT_MS,
  POPUP_OPENER_EVENT_WAIT_TIMEOUT_MS,
  POPUP_OPENER_WAIT_TIMEOUT_MS,
  setRsbPopupHostResolver,
  setRsbPopupOpenerReportSubscriber,
  RSB_BROWSER_POPUP_CHANNEL,
  applyGhostWebviewHardening,
  applyWebviewHardening,
  installDeferredPopupRouter,
  isGuestShortcutKeyDownType,
  resolveGuestShortcutAction,
  setRsbPopupOpenerResolver,
} from '../webview-security';

describe('applyWebviewHardening', () => {
  it('locks down all webPreferences fields per Codex tY', () => {
    const webPreferences: Record<string, unknown> = {
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true, // 嵌套 webview
      webSecurity: false,
      allowRunningInsecureContent: true,
      plugins: true,
      devTools: false,
      disablePopups: true,
      preload: '/tmp/evil-preload.js',
    };
    const params: Record<string, string> = { src: 'https://example.com' };

    applyWebviewHardening(webPreferences, params);

    // Codex tY 安全锁字段
    expect(webPreferences.sandbox).toBe(true);
    expect(webPreferences.devTools).toBe(true);
    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.nodeIntegrationInSubFrames).toBe(false);
    expect(webPreferences.nodeIntegrationInWorker).toBe(false);
    expect(webPreferences.contextIsolation).toBe(true);
    expect(webPreferences.webSecurity).toBe(true);
    expect(webPreferences.allowRunningInsecureContent).toBe(false);
    expect(webPreferences.webviewTag).toBe(false);
    expect(webPreferences.plugins).toBe(false);
    expect(webPreferences.disableDialogs).toBe(false);
    expect(webPreferences.disablePopups).toBe(false);
    // 比 tY 多一步 preload 删除(未传 commentPreloadPath 的回落分支)
    expect('preload' in webPreferences).toBe(false);
  });

  it('overrides any renderer-set preload with the comment preload path when provided', () => {
    const webPreferences: Record<string, unknown> = {
      preload: '/tmp/evil-preload.js',
    };
    const params: Record<string, string> = { src: 'https://example.com' };

    applyWebviewHardening(webPreferences, params, {
      commentPreloadPath: '/app/.vite/build/browserCommentPreload.js',
    });

    expect(webPreferences.preload).toBe('/app/.vite/build/browserCommentPreload.js');
  });

  it('injects the comment preload even when the renderer set none', () => {
    const webPreferences: Record<string, unknown> = {};
    const params: Record<string, string> = { src: 'https://example.com' };

    applyWebviewHardening(webPreferences, params, {
      commentPreloadPath: '/app/.vite/build/browserCommentPreload.js',
    });

    expect(webPreferences.preload).toBe('/app/.vite/build/browserCommentPreload.js');
  });

  it('forces partition to BROWSER_PARTITION (overrides any renderer-set value)', () => {
    const webPreferences: Record<string, unknown> = {};
    const params: Record<string, string> = {
      partition: 'persist:evil-other-session',
    };

    applyWebviewHardening(webPreferences, params);

    expect(params.partition).toBe(BROWSER_PARTITION);
  });

  it('fills BROWSER_PARTITION when renderer did not set partition at all', () => {
    const webPreferences: Record<string, unknown> = {};
    const params: Record<string, string> = { src: 'https://example.com' };

    applyWebviewHardening(webPreferences, params);

    expect(params.partition).toBe(BROWSER_PARTITION);
  });

  it('strips dangerous webview tag params and routes popups through host handler', () => {
    const webPreferences: Record<string, unknown> = {};
    const params: Record<string, string> = {
      src: 'https://example.com',
      disablewebsecurity: 'true',
      // 关键攻击向量:`<webview webpreferences="nodeIntegration=1,sandbox=0">`
      // 字符串 override,绕过 host 锁定。Codex 显式 delete。
      webpreferences: 'nodeIntegration=1,sandbox=0',
    };

    applyWebviewHardening(webPreferences, params);

    expect('disablewebsecurity' in params).toBe(false);
    // Keep popup requests observable by setWindowOpenHandler; the handler still
    // denies native windows and routes the URL into a new RSB tab.
    expect(params.allowpopups).toBe('true');
    expect('webpreferences' in params).toBe(false);
    // 不相关的 attribute (src) 保留
    expect(params.src).toBe('https://example.com');
  });

  it('is idempotent — running twice yields the same locked state', () => {
    const webPreferences: Record<string, unknown> = {
      nodeIntegration: true,
      contextIsolation: false,
    };
    const params: Record<string, string> = {
      disablewebsecurity: 'true',
      partition: 'persist:evil',
    };

    applyWebviewHardening(webPreferences, params);
    applyWebviewHardening(webPreferences, params);

    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.contextIsolation).toBe(true);
    expect('disablewebsecurity' in params).toBe(false);
    expect(params.partition).toBe(BROWSER_PARTITION);
  });
});

describe('BLANK_POPUP_WINDOW_WEB_PREFERENCES(about:blank 中转窗口安全集)', () => {
  it('覆盖仓库 BrowserWindow 安全契约的全部显式字段', () => {
    // docs/dev-rules/electron-security-and-process-boundaries.md 第 3 节:新增
    // BrowserWindow 必须显式配置的清单。隐藏中转窗口同样是真实 BrowserWindow,
    // 少一个字段就是比主窗宽松的例外。enableBlinkFeatures 的契约是"不设置",
    // 一并断言不存在。
    expect(BLANK_POPUP_WINDOW_WEB_PREFERENCES).toMatchObject({
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
      webviewTag: false,
      partition: BROWSER_PARTITION,
    });
    expect('enableBlinkFeatures' in BLANK_POPUP_WINDOW_WEB_PREFERENCES).toBe(false);
  });
});

describe('applyGhostWebviewHardening(意识面板 webview)', () => {
  it('同一套安全锁全部生效,但保留意识专属分区、掐死 popup', () => {
    const webPreferences: Record<string, unknown> = {
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
      plugins: true,
      preload: '/tmp/evil-preload.js',
    };
    const params: Record<string, string> = {
      src: 'cindy-ghost://art/panel.html',
      partition: 'cindy-ghost-art',
      disablewebsecurity: 'true',
      webpreferences: 'nodeIntegration=1',
      allowpopups: 'true',
    };

    applyGhostWebviewHardening(webPreferences, params);

    expect(webPreferences.sandbox).toBe(true);
    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.nodeIntegrationInSubFrames).toBe(false);
    expect(webPreferences.nodeIntegrationInWorker).toBe(false);
    expect(webPreferences.contextIsolation).toBe(true);
    expect(webPreferences.webSecurity).toBe(true);
    expect(webPreferences.allowRunningInsecureContent).toBe(false);
    expect(webPreferences.webviewTag).toBe(false);
    expect(webPreferences.plugins).toBe(false);
    expect('preload' in webPreferences).toBe(false);
    // 与浏览器路径的两点差异:分区保留、popup 掐死
    expect(params.partition).toBe('cindy-ghost-art');
    expect('allowpopups' in params).toBe(false);
    expect('disablewebsecurity' in params).toBe(false);
    expect('webpreferences' in params).toBe(false);
  });
});

describe('installDeferredPopupRouter', () => {
  afterEach(() => {
    vi.useRealTimers();
    setRsbPopupOpenerResolver(null);
    setRsbPopupOpenerReportSubscriber(null);
    setRsbPopupHostResolver(null);
  });

  function makePopupHarness() {
    let windowOpenHandler: ((details: { url: string }) => { action: 'deny' }) | null = null;
    const childContents = new EventEmitter() as EventEmitter & {
      setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => void;
    };
    childContents.setWindowOpenHandler = vi.fn((handler) => {
      windowOpenHandler = handler;
    });
    const popupWindow = new EventEmitter() as EventEmitter & {
      webContents: typeof childContents;
      close: () => void;
      isDestroyed: () => boolean;
    };
    popupWindow.webContents = childContents;
    popupWindow.close = vi.fn(() => popupWindow.emit('closed'));
    popupWindow.isDestroyed = vi.fn(() => false);
    const hostContents = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    } as unknown as WebContents & {
      isDestroyed: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };

    return {
      childContents,
      hostContents,
      popupWindow,
      getWindowOpenHandler: () => windowOpenHandler,
    };
  }

  it('closes an about:blank popup that never routes to a real URL', () => {
    vi.useFakeTimers();
    const { hostContents, popupWindow } = makePopupHarness();

    installDeferredPopupRouter(
      hostContents,
      popupWindow as unknown as BrowserWindow,
      'foreground-tab',
    );

    expect(popupWindow.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEFERRED_POPUP_ROUTE_TIMEOUT_MS);

    expect(hostContents.send).not.toHaveBeenCalled();
    expect(popupWindow.close).toHaveBeenCalledTimes(1);
  });

  it('routes the first http URL and cancels the about:blank cleanup timer', () => {
    vi.useFakeTimers();
    const { childContents, hostContents, popupWindow } = makePopupHarness();

    installDeferredPopupRouter(
      hostContents,
      popupWindow as unknown as BrowserWindow,
      'foreground-tab',
    );

    childContents.emit('will-navigate', {}, 'https://accounts.taptap.cn/login');
    vi.advanceTimersByTime(DEFERRED_POPUP_ROUTE_TIMEOUT_MS);

    expect(hostContents.send).toHaveBeenCalledTimes(1);
    expect(hostContents.send).toHaveBeenCalledWith(RSB_BROWSER_POPUP_CHANNEL, {
      url: 'https://accounts.taptap.cn/login',
      disposition: 'foreground-tab',
    });
    expect(popupWindow.close).toHaveBeenCalledTimes(1);
  });

  it('carries opener attribution through to the routed payload when resolvable', async () => {
    // popup 归属修复:payload 带 openerTabId / openerSessionId 时,renderer 端
    // 才能把 popup tab 落进发起方 session 的 bucket,而不是用户正在看的 session。
    // 归属反查现在在 popup 创建时就发起(异步),所以断言要等 promise 落定。
    const { childContents, hostContents, popupWindow } = makePopupHarness();
    setRsbPopupOpenerResolver((id) =>
      id === 42 ? { tabId: 'tab-1', sessionId: 'session-a' } : null,
    );

    installDeferredPopupRouter(
      hostContents,
      popupWindow as unknown as BrowserWindow,
      'foreground-tab',
      42,
    );

    childContents.emit('will-navigate', {}, 'https://accounts.example.com/oauth');

    await vi.waitFor(() => expect(hostContents.send).toHaveBeenCalledTimes(1));
    expect(hostContents.send).toHaveBeenCalledWith(RSB_BROWSER_POPUP_CHANNEL, {
      url: 'https://accounts.example.com/oauth',
      disposition: 'foreground-tab',
      openerTabId: 'tab-1',
      openerSessionId: 'session-a',
    });
  });

  it('retains opener attribution even if opener tab is released before real URL arrives', async () => {
    // Greptile 指出的竞态:about:blank 中转期间 opener tab 被关闭,registry release
    // 后反查落空,popup 会落进当前活跃会话。修复后在 popup 创建时就捕获归属。
    const { childContents, hostContents, popupWindow } = makePopupHarness();
    let registered: { tabId: string; sessionId: string } | null = {
      tabId: 'tab-1',
      sessionId: 'session-a',
    };
    setRsbPopupOpenerResolver((id) => (id === 42 ? registered : null));

    installDeferredPopupRouter(
      hostContents,
      popupWindow as unknown as BrowserWindow,
      'foreground-tab',
      42,
    );

    // opener tab 在 about:blank → 真实 URL 之间被关闭 / registry release
    registered = null;

    childContents.emit('will-navigate', {}, 'https://accounts.example.com/oauth');

    await vi.waitFor(() => expect(hostContents.send).toHaveBeenCalledTimes(1));
    expect(hostContents.send).toHaveBeenCalledWith(RSB_BROWSER_POPUP_CHANNEL, {
      url: 'https://accounts.example.com/oauth',
      disposition: 'foreground-tab',
      openerTabId: 'tab-1',
      openerSessionId: 'session-a',
    });
  });

  it('defers routing until the opener lands in the registry', async () => {
    // guest 页面 head 里的同步脚本能在 renderer 的 did-attach report 落库前就
    // window.open() —— 同步反查必然落空。此时必须等 registry 收到记录再路由,
    // 否则 popup 会落进"用户正在看的 session"。
    const { childContents, hostContents, popupWindow } = makePopupHarness();
    let registered: { tabId: string; sessionId: string } | null = null;
    setRsbPopupOpenerResolver((id) => (id === 42 ? registered : null));

    installDeferredPopupRouter(
      hostContents,
      popupWindow as unknown as BrowserWindow,
      'foreground-tab',
      42,
    );

    childContents.emit('will-navigate', {}, 'https://accounts.example.com/oauth');
    // 反查还落空 —— 中转窗口已收掉,但 popup 尚未路由给 renderer。
    expect(hostContents.send).not.toHaveBeenCalled();
    expect(popupWindow.close).toHaveBeenCalledTimes(1);

    // report 到达 main(registry 有记录了)→ 等待循环下一轮命中。
    registered = { tabId: 'tab-1', sessionId: 'session-a' };
    await vi.waitFor(() => expect(hostContents.send).toHaveBeenCalledTimes(1));
    expect(hostContents.send).toHaveBeenCalledWith(RSB_BROWSER_POPUP_CHANNEL, {
      url: 'https://accounts.example.com/oauth',
      disposition: 'foreground-tab',
      openerTabId: 'tab-1',
      openerSessionId: 'session-a',
    });
  });

  it('event-driven wait: report 落地的瞬间完成反查路由,不赌固定窗口', async () => {
    // 事件驱动档(生产路径):bootstrap 注入 report 订阅钩子后,归属等待不再是
    // 25ms 轮询 + 1s 硬超时 —— report 到达即命中,晚于 1s 的 report 也不丢归属。
    const { childContents, hostContents, popupWindow } = makePopupHarness();
    let registered: { tabId: string; sessionId: string } | null = null;
    const reportListeners = new Set<(id: number) => void>();
    setRsbPopupOpenerResolver((id) => (id === 42 ? registered : null));
    setRsbPopupOpenerReportSubscriber((listener) => {
      reportListeners.add(listener);
      return () => reportListeners.delete(listener);
    });

    installDeferredPopupRouter(
      hostContents,
      popupWindow as unknown as BrowserWindow,
      'foreground-tab',
      42,
    );
    childContents.emit('will-navigate', {}, 'https://accounts.example.com/oauth');
    expect(hostContents.send).not.toHaveBeenCalled();

    // 无关 guest 的 report 不触发路由。
    for (const l of [...reportListeners]) l(99);
    expect(hostContents.send).not.toHaveBeenCalled();

    // 目标 guest 的 report 落地(可以远晚于旧的 1s 轮询窗口)→ 立即带归属路由。
    registered = { tabId: 'tab-1', sessionId: 'session-a' };
    for (const l of [...reportListeners]) l(42);
    await vi.waitFor(() => expect(hostContents.send).toHaveBeenCalledTimes(1));
    expect(hostContents.send).toHaveBeenCalledWith(RSB_BROWSER_POPUP_CHANNEL, {
      url: 'https://accounts.example.com/oauth',
      disposition: 'foreground-tab',
      openerTabId: 'tab-1',
      openerSessionId: 'session-a',
    });
    // 路由完成后订阅已退订,不泄漏 listener。
    expect(reportListeners.size).toBe(0);
  });

  it('延迟路由发送时按当前宿主形态动态解析 host,不发给捕获时的旧 renderer', async () => {
    // 归属等待期间用户 detach 侧边栏 / 切视图:捕获的 hostContents 的 Shell 已
    // 退订(fanOut 不缓冲),发过去就是丢 popup。发送时刻经 host resolver 取当前
    // renderer(与 tab-op bridge 同源),消息落到活着的订阅者。
    const { childContents, hostContents, popupWindow } = makePopupHarness();
    let registered: { tabId: string; sessionId: string } | null = null;
    const reportListeners = new Set<(id: number) => void>();
    setRsbPopupOpenerResolver((id) => (id === 42 ? registered : null));
    setRsbPopupOpenerReportSubscriber((listener) => {
      reportListeners.add(listener);
      return () => reportListeners.delete(listener);
    });
    // 等待期间宿主形态切换:resolver 现在解析到"新窗口"的 webContents。
    const newHost = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
    setRsbPopupHostResolver(() => newHost);

    installDeferredPopupRouter(
      hostContents,
      popupWindow as unknown as BrowserWindow,
      'foreground-tab',
      42,
    );
    childContents.emit('will-navigate', {}, 'https://accounts.example.com/oauth');

    registered = { tabId: 'tab-1', sessionId: 'session-a' };
    for (const l of [...reportListeners]) l(42);

    await vi.waitFor(() => expect(newHost.send).toHaveBeenCalledTimes(1));
    expect(newHost.send).toHaveBeenCalledWith(RSB_BROWSER_POPUP_CHANNEL, {
      url: 'https://accounts.example.com/oauth',
      disposition: 'foreground-tab',
      openerTabId: 'tab-1',
      openerSessionId: 'session-a',
    });
    // 旧 host 不再收到 —— 它的 Shell 已退订,发它就是丢消息。
    expect(hostContents.send).not.toHaveBeenCalled();
  });

  it('host resolver 解析失败或返回已销毁 host 时回落捕获的 hostContents', () => {
    const { childContents, hostContents, popupWindow } = makePopupHarness();
    setRsbPopupHostResolver(() => null);

    installDeferredPopupRouter(
      hostContents,
      popupWindow as unknown as BrowserWindow,
      'foreground-tab',
    );
    childContents.emit('will-navigate', {}, 'https://accounts.example.com/oauth');

    expect(hostContents.send).toHaveBeenCalledWith(RSB_BROWSER_POPUP_CHANNEL, {
      url: 'https://accounts.example.com/oauth',
      disposition: 'foreground-tab',
    });
  });

  it('注入的 report 订阅器抛错时退化为超时兜底,popup 路由不中断', async () => {
    vi.useFakeTimers();
    const { childContents, hostContents, popupWindow } = makePopupHarness();
    setRsbPopupOpenerResolver(() => null);
    setRsbPopupOpenerReportSubscriber(() => {
      throw new Error('subscriber exploded');
    });

    installDeferredPopupRouter(
      hostContents,
      popupWindow as unknown as BrowserWindow,
      'foreground-tab',
      42,
    );
    childContents.emit('will-navigate', {}, 'https://accounts.example.com/oauth');

    // 不产生 unhandled rejection,超时兜底后照常无归属路由。
    await vi.advanceTimersByTimeAsync(POPUP_OPENER_EVENT_WAIT_TIMEOUT_MS + 50);
    expect(hostContents.send).toHaveBeenCalledWith(RSB_BROWSER_POPUP_CHANNEL, {
      url: 'https://accounts.example.com/oauth',
      disposition: 'foreground-tab',
    });
  });

  it('event-driven wait: 兜底超时后无归属路由(report 永不来的极端场景)', async () => {
    vi.useFakeTimers();
    const { childContents, hostContents, popupWindow } = makePopupHarness();
    setRsbPopupOpenerResolver(() => null);
    setRsbPopupOpenerReportSubscriber(() => () => undefined);

    installDeferredPopupRouter(
      hostContents,
      popupWindow as unknown as BrowserWindow,
      'foreground-tab',
      42,
    );
    childContents.emit('will-navigate', {}, 'https://accounts.example.com/oauth');
    expect(hostContents.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(POPUP_OPENER_EVENT_WAIT_TIMEOUT_MS + 50);
    expect(hostContents.send).toHaveBeenCalledWith(RSB_BROWSER_POPUP_CHANNEL, {
      url: 'https://accounts.example.com/oauth',
      disposition: 'foreground-tab',
    });
  });

  it('routes without attribution once the opener wait times out', async () => {
    // 永久落空(guest 不属于任何已上报的 RSB tab)时不能把 popup 一直扣着 ——
    // 有界等待到点后照常路由,只是没有 opener 字段(回落到旧行为)。
    vi.useFakeTimers();
    const { childContents, hostContents, popupWindow } = makePopupHarness();
    setRsbPopupOpenerResolver(() => null);

    installDeferredPopupRouter(
      hostContents,
      popupWindow as unknown as BrowserWindow,
      'foreground-tab',
      42,
    );

    childContents.emit('will-navigate', {}, 'https://accounts.example.com/oauth');
    expect(hostContents.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(POPUP_OPENER_WAIT_TIMEOUT_MS + 50);

    expect(hostContents.send).toHaveBeenCalledWith(RSB_BROWSER_POPUP_CHANNEL, {
      url: 'https://accounts.example.com/oauth',
      disposition: 'foreground-tab',
    });
  });

  it('routes synchronously when no opener resolver is installed', () => {
    // 启动早期 / 无 RSB bridge 的环境:没有可等的东西,等待只会白白延迟 popup。
    vi.useFakeTimers();
    const { childContents, hostContents, popupWindow } = makePopupHarness();

    installDeferredPopupRouter(
      hostContents,
      popupWindow as unknown as BrowserWindow,
      'foreground-tab',
      42,
    );

    childContents.emit('will-navigate', {}, 'https://accounts.example.com/oauth');

    expect(hostContents.send).toHaveBeenCalledWith(RSB_BROWSER_POPUP_CHANNEL, {
      url: 'https://accounts.example.com/oauth',
      disposition: 'foreground-tab',
    });
  });
});

describe('resolveGuestShortcutAction', () => {
  // 用 registry 的真实平台默认组合驱动断言 —— 保证「按键 → 动作」映射与
  // app-shortcuts 单一事实来源不漂移。
  const combosFor = (platform: string) => {
    const effective = getEffectiveAppShortcuts({}, platform);
    return (id: AppShortcutId) => effective.get(id) ?? [];
  };
  const key = (
    code: string,
    mods: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = {},
    keyValue?: string,
  ) => ({ code, key: keyValue, meta: false, control: false, alt: false, shift: false, ...mods });

  it('maps darwin default combos to host actions (incl. ⌘W close-tab)', () => {
    const getCombos = combosFor('darwin');
    expect(resolveGuestShortcutAction(key('KeyL', { meta: true }), getCombos)).toEqual({
      kind: 'focus-url-bar',
    });
    expect(resolveGuestShortcutAction(key('ArrowLeft', { alt: true }), getCombos)).toEqual({
      kind: 'command',
      command: 'go-back',
    });
    expect(resolveGuestShortcutAction(key('ArrowRight', { alt: true }), getCombos)).toEqual({
      kind: 'command',
      command: 'go-forward',
    });
    expect(resolveGuestShortcutAction(key('KeyR', { meta: true }), getCombos)).toEqual({
      kind: 'command',
      command: 'reload',
    });
    expect(resolveGuestShortcutAction(key('KeyW', { meta: true }), getCombos)).toEqual({
      kind: 'command',
      command: 'close-tab',
    });
    expect(
      resolveGuestShortcutAction(key('BracketLeft', { meta: true, shift: true }), getCombos),
    ).toEqual({
      kind: 'command',
      command: 'right-tab-prev',
    });
    expect(
      resolveGuestShortcutAction(key('BracketRight', { meta: true, shift: true }), getCombos),
    ).toEqual({
      kind: 'command',
      command: 'right-tab-next',
    });
    expect(
      resolveGuestShortcutAction(key('Tab', { control: true, shift: true }), getCombos),
    ).toEqual({
      kind: 'command',
      command: 'right-tab-prev',
    });
    expect(resolveGuestShortcutAction(key('Tab', { control: true }), getCombos)).toEqual({
      kind: 'command',
      command: 'right-tab-next',
    });
  });

  it('matches darwin bracket tab cycling in webview input even when code is unreliable', () => {
    const getCombos = combosFor('darwin');
    expect(
      resolveGuestShortcutAction(
        key('Unidentified', { meta: true, shift: true }, '}'),
        getCombos,
      ),
    ).toEqual({
      kind: 'command',
      command: 'right-tab-next',
    });
    expect(
      resolveGuestShortcutAction(
        key('Unidentified', { meta: true, shift: true }, '{'),
        getCombos,
      ),
    ).toEqual({
      kind: 'command',
      command: 'right-tab-prev',
    });
    expect(
      resolveGuestShortcutAction(
        { key: '}', meta: true, control: false, alt: false, shift: true },
        getCombos,
      ),
    ).toEqual({
      kind: 'command',
      command: 'right-tab-next',
    });
  });

  it('handles CDP rawKeyDown as a shortcut keydown event', () => {
    expect(isGuestShortcutKeyDownType('keyDown')).toBe(true);
    expect(isGuestShortcutKeyDownType('rawKeyDown')).toBe(true);
    expect(isGuestShortcutKeyDownType('char')).toBe(false);
    expect(isGuestShortcutKeyDownType('keyUp')).toBe(false);
  });

  it('maps Ctrl+W and right tab cycling keys with win32 defaults', () => {
    expect(resolveGuestShortcutAction(key('KeyW', { control: true }), combosFor('win32'))).toEqual({
      kind: 'command',
      command: 'close-tab',
    });
    expect(
      resolveGuestShortcutAction(key('PageUp', { control: true }), combosFor('win32')),
    ).toEqual({ kind: 'command', command: 'right-tab-prev' });
    expect(
      resolveGuestShortcutAction(key('PageDown', { control: true }), combosFor('win32')),
    ).toEqual({ kind: 'command', command: 'right-tab-next' });
    expect(
      resolveGuestShortcutAction(key('Tab', { control: true, shift: true }), combosFor('win32')),
    ).toEqual({ kind: 'command', command: 'right-tab-prev' });
    expect(resolveGuestShortcutAction(key('Tab', { control: true }), combosFor('win32'))).toEqual({
      kind: 'command',
      command: 'right-tab-next',
    });
  });

  it('close-tab wins over a stale browser-action override colliding on Ctrl+W', () => {
    // 存量用户可能在 close-tab-or-window 引入之前就把浏览器动作 override 到
    // Ctrl+W(load 归一化不清洗历史冲突)。撞键时保留键的关 tab 语义必须胜出。
    const effective = getEffectiveAppShortcuts(
      {
        'browser-reload': {
          code: 'KeyW',
          meta: false,
          ctrl: true,
          alt: false,
          shift: false,
        },
      },
      'win32',
    );
    expect(
      resolveGuestShortcutAction(
        key('KeyW', { control: true }),
        (id) => effective.get(id) ?? [],
      ),
    ).toEqual({ kind: 'command', command: 'close-tab' });
  });

  it('returns null for unrelated keys or wrong modifier state', () => {
    const getCombos = combosFor('darwin');
    expect(resolveGuestShortcutAction(key('KeyW'), getCombos)).toBeNull();
    expect(
      resolveGuestShortcutAction(key('KeyW', { meta: true, shift: true }), getCombos),
    ).toBeNull();
    expect(resolveGuestShortcutAction(key('KeyT', { meta: true }), getCombos)).toBeNull();
  });
});
