/**
 * secondary-windows 守卫单测(#5450 R01/R02):
 * - installExternalLinkGuards:顶层导航 deny-by-default——非内部 URL 一律
 *   preventDefault,仅 http(s) 额外转交系统浏览器;file:// 与解析失败 URL 不得在窗内导航。
 * - destroySecondaryWindowOnLoadFailure:主框加载失败销毁窗口,子框 / ABORTED(-3)不升级。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.fn();

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp') },
  nativeTheme: { shouldUseDarkColors: false },
  screen: { getCursorScreenPoint: vi.fn(), getAllDisplays: vi.fn(() => []) },
  shell: { openExternal: (...args: unknown[]) => openExternal(...(args as [])) },
}));

import {
  destroySecondaryWindowOnLoadFailure,
  installExternalLinkGuards,
} from '../secondary-windows.js';

// 生产由构建注入的 ambient;测试按 packaged 语义置空(isInternalUrl 恒 false)。
(globalThis as Record<string, unknown>).MAIN_WINDOW_VITE_DEV_SERVER_URL = undefined;
(globalThis as Record<string, unknown>).MAIN_WINDOW_VITE_NAME = 'index';
afterEach(() => vi.unstubAllGlobals());

interface FakeWin {
  preventDefault: ReturnType<typeof vi.fn>;
  webContents: {
    on: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
  };
  isDestroyed: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  emitWillNavigate: (url: string) => void;
  openHandler: { handler: ((o: { url: string }) => { action: string }) | null };
}

function fakeWin(): FakeWin {
  const wcListeners = new Map<string, (...args: unknown[]) => void>();
  const openHandler: FakeWin['openHandler'] = { handler: null };
  const preventDefault = vi.fn();
  const win: FakeWin = {
    preventDefault,
    webContents: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        wcListeners.set(event, cb);
      }),
      setWindowOpenHandler: vi.fn((handler: (o: { url: string }) => { action: string }) => {
        openHandler.handler = handler;
      }),
    },
    isDestroyed: vi.fn(() => false),
    destroy: vi.fn(),
    emitWillNavigate(url: string) {
      wcListeners.get('will-navigate')?.({ preventDefault }, url);
    },
    openHandler,
  };
  installExternalLinkGuards(win as unknown as Parameters<typeof installExternalLinkGuards>[0]);
  return win;
}

describe('installExternalLinkGuards — 顶层导航 deny-by-default', () => {
  beforeEach(() => {
    openExternal.mockClear();
  });

  it('http(s) 仍 preventDefault 并转交系统浏览器', () => {
    const win = fakeWin();
    win.emitWillNavigate('https://example.com/page');
    expect(win.preventDefault).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/page');
  });

  it('file:// 拦截在窗内,不外开', () => {
    const win = fakeWin();
    win.emitWillNavigate('file:///etc/hosts');
    expect(win.preventDefault).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('解析失败的 URL 也拦截,不抛错不外开', () => {
    const win = fakeWin();
    expect(() => win.emitWillNavigate('http://[%zz]:1/x')).not.toThrow();
    expect(win.preventDefault).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('window.open 非内部一律 deny;http(s) 额外外开', () => {
    const win = fakeWin();
    expect(win.openHandler.handler).not.toBeNull();

    expect(win.openHandler.handler?.({ url: 'file:///etc/hosts' })).toEqual({ action: 'deny' });
    expect(openExternal).not.toHaveBeenCalled();

    expect(win.openHandler.handler?.({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('dev 同源导航和开窗仍允许,不同源仍拦截', () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173/');
    const win = fakeWin();
    win.emitWillNavigate('http://localhost:5173/settings');
    expect(win.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(win.openHandler.handler?.({ url: 'http://localhost:5173/settings' })).toEqual({ action: 'allow' });
    win.emitWillNavigate('http://localhost:5174/settings');
    expect(win.preventDefault).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('http://localhost:5174/settings');
  });
});

describe('destroySecondaryWindowOnLoadFailure — 加载失败销毁窗口', () => {
  const sessionId = 'sess-1';

  it('主框真实错误码 → 销毁窗口', () => {
    const win = fakeWin();
    destroySecondaryWindowOnLoadFailure(win as never, sessionId, {
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      isMainFrame: true,
    });
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it('ABORTED(-3)与子框失败不销毁', () => {
    const win = fakeWin();
    destroySecondaryWindowOnLoadFailure(win as never, sessionId, {
      errorCode: -3,
      errorDescription: 'ABORTED',
      isMainFrame: true,
    });
    destroySecondaryWindowOnLoadFailure(win as never, sessionId, {
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      isMainFrame: false,
    });
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it('保留已经展示过的窗口,包括暂时隐藏后的 reload 失败', () => {
    const win = fakeWin();
    destroySecondaryWindowOnLoadFailure(win as never, sessionId, {
      errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', isMainFrame: true, hasShown: true,
    });
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it('Promise 只提供 ERR_ABORTED 字符串时也不销毁窗口', () => {
    const win = fakeWin();
    destroySecondaryWindowOnLoadFailure(win as never, sessionId, {
      errorCode: -1, errorDescription: 'ERR_ABORTED', isMainFrame: true,
    });
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it('窗口已销毁时不重复处理', () => {
    const win = fakeWin();
    win.isDestroyed.mockReturnValue(true);
    expect(() =>
      destroySecondaryWindowOnLoadFailure(win as never, sessionId, {
        errorCode: -105,
        errorDescription: 'ERR',
        isMainFrame: true,
      }),
    ).not.toThrow();
    expect(win.destroy).not.toHaveBeenCalled();
  });
});
