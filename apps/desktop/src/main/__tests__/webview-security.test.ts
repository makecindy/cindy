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
  DEFERRED_POPUP_ROUTE_TIMEOUT_MS,
  RSB_BROWSER_POPUP_CHANNEL,
  applyGhostWebviewHardening,
  applyWebviewHardening,
  installDeferredPopupRouter,
  isGuestShortcutKeyDownType,
  resolveGuestShortcutAction,
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
