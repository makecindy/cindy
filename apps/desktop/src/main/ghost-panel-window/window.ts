/**
 * createGhostPanelWindow —— 插件停靠面板独立窗口的 BrowserWindow 工厂。
 *
 * 蓝本是 right-sidebar-window/window.ts,差异:
 *  - 按 ghostId 多实例:窗口位置记忆每插件一份
 *    (ghost-panel-window-state-<id>.json,id 字符集 [a-z0-9-] 文件名安全);
 *  - webPreferences 按 electron-security-and-process-boundaries §3 显式带全量
 *    安全项(该规则晚于主窗/RSB 窗,新窗口必须逐项写明,不吃默认值);
 *  - `webviewTag: true`:面板体就是 <webview>(cindy-ghost:// 分区)。附加闸/
 *    硬化器(webview-security.ts)对所有窗口全局生效,这里零额外授权;
 *  - 启动参数 `?ghostPanelWindow=<id>` + hash `/ghost-panel-window`:renderer
 *    单入口,router 据此只挂 GhostPanelWindowLayout。
 */

import { BrowserWindow, app, nativeTheme } from 'electron';
import path from 'node:path';
import windowStateKeeper from 'electron-window-state';

import { createLogger } from '../logger.js';
import { markAppContentWindow } from '../windowFocusClassifier.js';
import { readWindowBehaviorSettings } from '../window-behavior-settings-store.js';
import { installExternalLinkGuards } from '../secondary-windows.js';
import { installSelectionContextMenu } from '../selection-context-menu.js';
import { applyAppearanceToWindow } from '../appearance-settings-ipc.js';

const log = createLogger('ghost-panel-window');

export function createGhostPanelWindow(ghostId: string, title: string): BrowserWindow {
  const platformOptions =
    process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 16 } }
      : { frame: false };
  const bgColor = nativeTheme.shouldUseDarkColors ? '#1f1f1e' : '#f8f8f6';

  // 与主窗 / 副窗保持 acceptFirstMouse 一致(见 secondary-windows.ts 同款注释)。
  const swallowActivationClick = readWindowBehaviorSettings().swallowActivationClick;

  const windowState = windowStateKeeper({
    defaultWidth: 480,
    defaultHeight: 720,
    file: `ghost-panel-window-state-${ghostId}.json`,
  });

  const win = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 320,
    minHeight: 400,
    title,
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
      // 安全规则 §3 全量显式项(新建窗口不吃默认值,逐项写明):
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
    if (!win.isDestroyed()) win.show();
  });

  const hash = '/ghost-panel-window';
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    url.searchParams.set('ghostPanelWindow', ghostId);
    url.hash = hash;
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
      query: { ghostPanelWindow: ghostId },
      hash,
    });
  }

  log.info('ghost panel window created', { ghostId });
  return win;
}
