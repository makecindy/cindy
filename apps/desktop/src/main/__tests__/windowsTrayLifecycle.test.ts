import { describe, expect, it, vi } from 'vitest';

import {
  hideWindowToWindowsTray,
  popUpWindowsTrayMenu,
  requestWindowsCloseBehavior,
  requestWindowsTrayQuit,
  type WindowsClosePromptWindow,
  type WindowsTrayMenuHost,
  type WindowsTrayWindow,
} from '../windowsTrayLifecycle';

/** Controllable BrowserWindow fake for fullscreen transition tests. */
function makeWindow(fullScreen: boolean): WindowsTrayWindow & {
  destroyed: boolean;
  emitLeaveFullScreen(): void;
} {
  let leaveFullScreenListener: (() => void) | null = null;
  return {
    destroyed: false,
    hide: vi.fn(),
    isDestroyed() {
      return this.destroyed;
    },
    isFullScreen: () => fullScreen,
    once: (_event, listener) => {
      leaveFullScreenListener = listener;
    },
    setFullScreen: vi.fn((next: boolean) => {
      fullScreen = next;
    }),
    emitLeaveFullScreen() {
      leaveFullScreenListener?.();
    },
  };
}

function makePromptWindow(): WindowsClosePromptWindow & {
  destroyed: boolean;
  minimized: boolean;
  visible: boolean;
  webContentsDestroyed: boolean;
} {
  const window = {
    destroyed: false,
    minimized: false,
    visible: true,
    webContentsDestroyed: false,
    focus: vi.fn(),
    isDestroyed() {
      return this.destroyed;
    },
    isMinimized() {
      return this.minimized;
    },
    isVisible() {
      return this.visible;
    },
    restore: vi.fn(() => {
      window.minimized = false;
    }),
    show: vi.fn(() => {
      window.visible = true;
    }),
    webContents: {
      isDestroyed: () => window.webContentsDestroyed,
      send: vi.fn(),
    },
  };
  return window;
}

describe('Windows tray lifecycle', () => {
  it('hides a regular window immediately', () => {
    const window = makeWindow(false);

    hideWindowToWindowsTray(window);

    expect(window.hide).toHaveBeenCalledTimes(1);
    expect(window.setFullScreen).not.toHaveBeenCalled();
  });

  it('leaves fullscreen before hiding the window', () => {
    const window = makeWindow(true);

    hideWindowToWindowsTray(window);

    expect(window.setFullScreen).toHaveBeenCalledWith(false);
    expect(window.hide).not.toHaveBeenCalled();

    window.emitLeaveFullScreen();
    expect(window.hide).toHaveBeenCalledTimes(1);
  });

  it('does not hide a window destroyed during the fullscreen transition', () => {
    const window = makeWindow(true);

    hideWindowToWindowsTray(window);
    window.destroyed = true;
    window.emitLeaveFullScreen();

    expect(window.hide).not.toHaveBeenCalled();
  });

  it('restores and reveals the main window before requesting the custom dialog', () => {
    const window = makePromptWindow();
    window.minimized = true;
    window.visible = false;

    requestWindowsCloseBehavior(window, 'window-behavior:close-requested');

    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledWith('window-behavior:close-requested');
  });

  it('does not request the custom dialog after the renderer is destroyed', () => {
    const window = makePromptWindow();
    window.webContentsDestroyed = true;

    requestWindowsCloseBehavior(window, 'window-behavior:close-requested');

    expect(window.focus).not.toHaveBeenCalled();
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it('quits without confirmation while no turn is active', () => {
    const confirmQuit = vi.fn(() => false);
    const quit = vi.fn();

    requestWindowsTrayQuit({ hasActiveTurn: () => false, confirmQuit, quit });

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('keeps the app open when active-turn confirmation is cancelled', () => {
    const quit = vi.fn();

    requestWindowsTrayQuit({ hasActiveTurn: () => true, confirmQuit: () => false, quit });

    expect(quit).not.toHaveBeenCalled();
  });

  it('quits after active-turn confirmation', () => {
    const quit = vi.fn();

    requestWindowsTrayQuit({ hasActiveTurn: () => true, confirmQuit: () => true, quit });

    expect(quit).toHaveBeenCalledTimes(1);
  });
});

/** Tray fake for the JS-driven menu popup (`setContextMenu` is deliberately unused). */
function makeTrayMenuHost(): WindowsTrayMenuHost<object> & { destroyed: boolean } {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    popUpContextMenu: vi.fn(),
  };
}

describe('Windows tray menu popup', () => {
  it('builds the menu on first popup and keeps it referenced for the next one', () => {
    const tray = makeTrayMenuHost();
    const built = { id: 'built' };
    const buildMenu = vi.fn(() => built);
    let retained: object | null = null;
    const retainMenu = vi.fn((menu: object) => {
      retained = menu;
    });

    expect(
      popUpWindowsTrayMenu({
        tray,
        menu: retained,
        buildMenu,
        retainMenu,
        onUnavailable: vi.fn(),
        onError: vi.fn(),
      }),
    ).toBe(true);
    expect(buildMenu).toHaveBeenCalledTimes(1);
    expect(retained).toBe(built);

    // 第二次右键复用同一个菜单对象: 弹出期间必须一直有 JS 引用,不能每次交出新对象。
    expect(
      popUpWindowsTrayMenu({
        tray,
        menu: retained,
        buildMenu,
        retainMenu,
        onUnavailable: vi.fn(),
        onError: vi.fn(),
      }),
    ).toBe(true);
    expect(buildMenu).toHaveBeenCalledTimes(1);
    expect(tray.popUpContextMenu).toHaveBeenNthCalledWith(1, built);
    expect(tray.popUpContextMenu).toHaveBeenNthCalledWith(2, built);
  });

  it('rebuilds the menu after the caller drops it on a language change', () => {
    const tray = makeTrayMenuHost();
    const menus = [{ id: 'zh-CN' }, { id: 'en' }];
    const buildMenu = vi.fn(() => menus.shift() ?? { id: 'exhausted' });
    const retainMenu = vi.fn();

    popUpWindowsTrayMenu({
      tray,
      menu: null,
      buildMenu,
      retainMenu,
      onUnavailable: vi.fn(),
      onError: vi.fn(),
    });
    // invalidateWindowsTrayMenu() 把缓存置空后的下一次右键。
    popUpWindowsTrayMenu({
      tray,
      menu: null,
      buildMenu,
      retainMenu,
      onUnavailable: vi.fn(),
      onError: vi.fn(),
    });

    expect(buildMenu).toHaveBeenCalledTimes(2);
    expect(retainMenu.mock.calls).toEqual([[{ id: 'zh-CN' }], [{ id: 'en' }]]);
    expect(tray.popUpContextMenu).toHaveBeenNthCalledWith(2, { id: 'en' });
  });

  it('reports a missing tray icon without building a menu', () => {
    const buildMenu = vi.fn(() => ({}));
    const onUnavailable = vi.fn();

    expect(
      popUpWindowsTrayMenu({
        tray: null,
        menu: null,
        buildMenu,
        retainMenu: vi.fn(),
        onUnavailable,
        onError: vi.fn(),
      }),
    ).toBe(false);

    expect(onUnavailable).toHaveBeenCalledWith('no-tray');
    expect(buildMenu).not.toHaveBeenCalled();
  });

  it('reports a destroyed tray icon without building a menu', () => {
    const tray = makeTrayMenuHost();
    tray.destroyed = true;
    const buildMenu = vi.fn(() => ({}));
    const onUnavailable = vi.fn();

    expect(
      popUpWindowsTrayMenu({
        tray,
        menu: null,
        buildMenu,
        retainMenu: vi.fn(),
        onUnavailable,
        onError: vi.fn(),
      }),
    ).toBe(false);

    expect(onUnavailable).toHaveBeenCalledWith('destroyed');
    expect(buildMenu).not.toHaveBeenCalled();
    expect(tray.popUpContextMenu).not.toHaveBeenCalled();
  });

  it('surfaces a failing popup instead of throwing into the tray event handler', () => {
    const tray = makeTrayMenuHost();
    const failure = new Error('popup rejected by the shell');
    tray.popUpContextMenu = vi.fn(() => {
      throw failure;
    });
    const onError = vi.fn();

    expect(
      popUpWindowsTrayMenu({
        tray,
        menu: null,
        buildMenu: () => ({}),
        retainMenu: vi.fn(),
        onUnavailable: vi.fn(),
        onError,
      }),
    ).toBe(false);

    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('surfaces a failing menu build', () => {
    const tray = makeTrayMenuHost();
    const failure = new Error('menu template rejected');
    const onError = vi.fn();

    expect(
      popUpWindowsTrayMenu({
        tray,
        menu: null,
        buildMenu: () => {
          throw failure;
        },
        retainMenu: vi.fn(),
        onUnavailable: vi.fn(),
        onError,
      }),
    ).toBe(false);

    expect(onError).toHaveBeenCalledWith(failure);
    expect(tray.popUpContextMenu).not.toHaveBeenCalled();
  });
});
