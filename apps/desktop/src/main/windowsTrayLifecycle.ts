/** BrowserWindow surface needed to leave fullscreen before hiding to the Windows tray. */
export interface WindowsTrayWindow {
  hide(): void;
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  once(event: 'leave-full-screen', listener: () => void): unknown;
  setFullScreen(fullScreen: boolean): void;
}

/** BrowserWindow surface needed to reveal the renderer-owned first-close dialog. */
export interface WindowsClosePromptWindow {
  focus(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string): void;
  };
}

/** Dependencies for applying the same active-turn protection to tray-menu quit. */
export interface WindowsTrayQuitDependencies {
  hasActiveTurn(): boolean;
  confirmQuit(): boolean;
  quit(): void;
}

/** Tray surface needed to open the tray menu from JS instead of via `setContextMenu`. */
export interface WindowsTrayMenuHost<TMenu> {
  isDestroyed(): boolean;
  popUpContextMenu(menu: TMenu): void;
}

/** Dependencies for the JS-driven tray menu popup. */
export interface WindowsTrayMenuPopupDependencies<TMenu> {
  tray: WindowsTrayMenuHost<TMenu> | null;
  /** Cached menu, or null when it must be (re)built — callers drop it on language change. */
  menu: TMenu | null;
  buildMenu(): TMenu;
  /** Hands the menu back to the caller, which keeps it referenced for the next popup. */
  retainMenu(menu: TMenu): void;
  onUnavailable(reason: 'no-tray' | 'destroyed'): void;
  onError(error: unknown): void;
}

/**
 * Open the Windows tray menu ourselves on right-click.
 *
 * ⚠️ 不要改回 `tray.setContextMenu()`。那条路径把弹菜单整个交给 native 侧,
 * 一旦系统那次弹出失败(上游 electron#47421: 前台有全屏应用时右键固定在任务栏的
 * 托盘图标毫无反应),JS 侧既收不到事件也记不下日志,用户就只剩任务管理器可用 ——
 * 这正是 Windows 用户报的 "左键能恢复窗口、右键什么都不弹" 的现象。
 * 而且 `setContextMenu` 一旦设置,`right-click` 事件按设计不再 emit
 * (electron#5058,维护者明确说是预期行为),所以两种方式不能并存做双保险:
 * 设了它,这里的兜底就永远不会被触发。
 */
export function popUpWindowsTrayMenu<TMenu>(
  deps: WindowsTrayMenuPopupDependencies<TMenu>,
): boolean {
  const { tray } = deps;
  if (!tray) {
    deps.onUnavailable('no-tray');
    return false;
  }
  if (tray.isDestroyed()) {
    deps.onUnavailable('destroyed');
    return false;
  }

  try {
    // 缓存不只是省一次构建: 菜单对象必须一直有 JS 引用,否则弹出期间被 GC 掉。
    const menu = deps.menu ?? deps.buildMenu();
    deps.retainMenu(menu);
    tray.popUpContextMenu(menu);
    return true;
  } catch (error) {
    deps.onError(error);
    return false;
  }
}

/** Hide immediately, or wait for the native fullscreen transition to finish first. */
export function hideWindowToWindowsTray(window: WindowsTrayWindow): void {
  if (!window.isFullScreen()) {
    window.hide();
    return;
  }

  window.once('leave-full-screen', () => {
    if (!window.isDestroyed()) window.hide();
  });
  window.setFullScreen(false);
}

/** Keep the main window visible and ask its renderer to show the Cindy-styled chooser. */
export function requestWindowsCloseBehavior(
  window: WindowsClosePromptWindow,
  channel: string,
): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  window.webContents.send(channel);
}

/** Quit directly while idle, but require explicit confirmation during an active turn. */
export function requestWindowsTrayQuit(deps: WindowsTrayQuitDependencies): void {
  if (deps.hasActiveTurn() && !deps.confirmQuit()) return;
  deps.quit();
}
