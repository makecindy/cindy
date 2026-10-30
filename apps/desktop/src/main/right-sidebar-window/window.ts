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
 *
 * `createSidebarHostWindow` 是整栏子窗口与单页签弹出窗口(sidebar-tab-window/window.ts)
 * 共用的工厂:两种窗口承载同一套侧栏插件(webview / 终端 / 文件浏览器 …),preload、
 * 安全字段、外链守卫与崩溃隔离登记完全相同,只有启动参数、尺寸与位置记忆文件不同。
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
import { installWindowHiddenBroadcast } from '../windowHiddenBroadcast.js';

const log = createLogger('right-sidebar-window');

export interface SidebarHostWindowOptions {
  /** 启动 URL 查询参数;renderer 入口据此分流(`sidebarWindow=1` 必须在内)。 */
  query: Record<string, string>;
  /** 窗口位置记忆文件名(userData 下)。 */
  stateFile: string;
  defaultWidth: number;
  defaultHeight: number;
  minWidth: number;
  minHeight: number;
  /**
   * 同类窗口已开 N 扇时的层叠偏移序号:多扇弹出窗口共用一份位置记忆,不偏移会
   * 完全重叠、用户以为只弹出了一扇。0 = 原位。
   */
  cascadeIndex?: number;
  /** 日志标签。 */
  logLabel: string;
}

const CASCADE_STEP_PX = 28;

export function createSidebarHostWindow(options: SidebarHostWindowOptions): BrowserWindow {
  const platformOptions =
    process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 16 } }
      : { frame: false };
  const bgColor = nativeTheme.shouldUseDarkColors ? '#1f1f1e' : '#f8f8f6';

  const swallowActivationClick = readWindowBehaviorSettings().swallowActivationClick;

  const windowState = windowStateKeeper({
    defaultWidth: options.defaultWidth,
    defaultHeight: options.defaultHeight,
    file: options.stateFile,
    // The window is prewarmed while hidden on every launch. Restoring either
    // presentation mode can make Electron show it before the controller opens it.
    maximize: false,
    fullScreen: false,
  });
  const cascade = (options.cascadeIndex ?? 0) * CASCADE_STEP_PX;

  const win = new BrowserWindow({
    x: windowState.x === undefined ? undefined : windowState.x + cascade,
    y: windowState.y === undefined ? undefined : windowState.y + cascade,
    width: windowState.width,
    height: windowState.height,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
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
  // The detached sidebar has its own hidden title bar and renderer. Fullscreen
  // state changes therefore need to be sent from this window, not only from
  // the primary window's bootstrap listener.
  win.on('enter-full-screen', () => {
    if (!win.isDestroyed()) win.webContents.send('fullscreen-change', true);
  });
  win.on('leave-full-screen', () => {
    if (!win.isDestroyed()) win.webContents.send('fullscreen-change', false);
  });
  markRsbWindowWebContentsId(win.webContents.id);
  markAppContentWindow(win);
  installWindowHiddenBroadcast(win);
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
    // no-op — display is governed by the owning controller
  });

  const hash = '/sidebar-window';
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, value);
    url.hash = hash;
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
      query: options.query,
      hash,
    });
  }

  log.info(`${options.logLabel} created`);
  return win;
}

export function createRightSidebarWindow(): BrowserWindow {
  return createSidebarHostWindow({
    query: { sidebarWindow: '1' },
    stateFile: 'right-sidebar-window-state.json',
    defaultWidth: 520,
    defaultHeight: 860,
    minWidth: 360,
    minHeight: 480,
    logLabel: 'right-sidebar window',
  });
}
