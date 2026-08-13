/**
 * createRightSidebarWindow —— 右侧栏子窗口的 BrowserWindow 工厂。
 *
 * 生命周期基线对齐 PR #2434:
 *  - 使用专用 sidebarWindowPreload.js(最小权限 bridge,不加载主 preload 完整桥)
 *  - 加载轻量渲染入口(sidebar-window-entry.tsx,不经过完整 main-entry)
 *  - 显式安全配置(§3.1 基线: sandbox + contextIsolation + 无 Node)
 *  - 隐藏预热:窗口以 show:false 创建,由 controller 的双阶段就绪握手决定展示时机
 *
 * frame / 外链守卫 / acceptFirstMouse 复刻 secondary-windows.ts(会话多开副窗)。
 * 独立的窗口位置记忆文件 right-sidebar-window-state.json(不与主窗 window-state.json 串)。
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
import { markRsbWindowWebContentsId } from './registry.js';

const log = createLogger('right-sidebar-window');

export function createRightSidebarWindow(): BrowserWindow {
  const platformOptions =
    process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 16 } }
      : { frame: false };
  const bgColor = nativeTheme.shouldUseDarkColors ? '#1f1f1e' : '#f8f8f6';

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
      // 使用专用预载脚本:右侧栏窗口只暴露 RSB 所需 bridge,不走主 preload。
      preload: path.join(__dirname, 'sidebarWindowPreload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      webviewTag: true,
    },
  });
  markRsbWindowWebContentsId(win.webContents.id);
  markAppContentWindow(win);
  applyAppearanceToWindow(win);
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    applyAppearanceToWindow(win);
  });
  installSelectionContextMenu(win);
  windowState.manage(win);

  installExternalLinkGuards(win);

  // ready-to-show: 窗口以 show:false 创建,由 controller 的双阶段就绪握手
  // (renderer-ready → presentation-ready) 控制展示时机,此处不做任何展示。
  win.once('ready-to-show', () => {
    // no-op — display is governed by RsbWindowController
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
