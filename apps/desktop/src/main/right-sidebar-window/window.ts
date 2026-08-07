/**
 * createRightSidebarWindow —— 右侧栏子窗口的 BrowserWindow 工厂。
 *
 * frame / 外链守卫 / acceptFirstMouse 复刻 secondary-windows.ts(会话多开副窗),
 * 差异点:
 *  - `webviewTag: true`:内嵌浏览器 plugin 需要 <webview>(副窗没有 RSB 不需要)
 *  - 独立的窗口位置记忆文件 right-sidebar-window-state.json(不与主窗 window-state.json 串)
 *  - 启动参数 `?sidebarWindow=1` + hash `/sidebar-window`:renderer 单入口,
 *    router 据此只挂 SidebarWindowLayout(不挂 MainLayout 完整壳)
 */

import { BrowserWindow, app, nativeTheme } from 'electron';
import path from 'node:path';
import windowStateKeeper from 'electron-window-state';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import { createLogger } from '../logger.js';
import { markAppContentWindow } from '../windowFocusClassifier.js';
import { readWindowBehaviorSettings } from '../window-behavior-settings-store.js';
import { installExternalLinkGuards } from '../secondary-windows.js';
import { installSelectionContextMenu } from '../selection-context-menu.js';
import { applyAppearanceToWindow } from '../appearance-settings-ipc.js';

const log = createLogger('right-sidebar-window');

export interface CreateRightSidebarWindowOptions {
  /**
   * 建窗是不是用户当次手势要求的。缺省 true = 首帧就绪后 show()(拿焦点)。
   * false(插件 preview / agent 自动化)走 showInactive():窗口照常出现在原位,
   * 但不夺走用户当前前台应用的焦点。
   */
  userInitiated?: boolean;
}

export function createRightSidebarWindow(
  options: CreateRightSidebarWindowOptions = {},
): BrowserWindow {
  const userInitiated = options.userInitiated !== false;
  const platformOptions =
    process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 16 } }
      : { frame: false };
  const bgColor = nativeTheme.shouldUseDarkColors ? '#1f1f1e' : '#f8f8f6';

  // 与主窗 / 副窗保持 acceptFirstMouse 一致(见 secondary-windows.ts 同款注释)。
  const swallowActivationClick = readWindowBehaviorSettings().swallowActivationClick;

  const windowState = windowStateKeeper({
    defaultWidth: 520,
    defaultHeight: 860,
    file: 'right-sidebar-window-state.json',
  });

  const win = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 360,
    minHeight: 480,
    title: BRAND_NAME,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '../../resources/icon.png'),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: bgColor,
    acceptFirstMouse: !swallowActivationClick,
    ...platformOptions,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
      webviewTag: true,
    },
  });
  markAppContentWindow(win);
  applyAppearanceToWindow(win);
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    applyAppearanceToWindow(win);
  });
  installSelectionContextMenu(win);
  windowState.manage(win);

  installExternalLinkGuards(win);

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    if (userInitiated) win.show();
    else win.showInactive();
  });

  const hash = '/sidebar-window';
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    url.searchParams.set('sidebarWindow', '1');
    url.hash = hash;
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
      query: { sidebarWindow: '1' },
      hash,
    });
  }

  log.info('right-sidebar window created');
  return win;
}
