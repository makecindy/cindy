/**
 * createResourceUsageWindow —— 资源用量独立子窗口的 BrowserWindow 工厂。
 *
 * 窗口规格：
 * - 非模态（parent: mainWindow，不阻塞主窗交互）
 * - 可独立拖拽、调整大小
 * - 单实例（重复 open = show + focus）
 * - 通过 `resourceUsageWindow=1` 进入独立轻量 renderer 模块图
 */

import { BrowserWindow, app, nativeTheme } from 'electron';
import path from 'node:path';

import { createLogger } from '../logger.js';
import { markAppContentWindow } from '../windowFocusClassifier.js';
import { installExternalLinkGuards } from '../secondary-windows.js';
import { installSelectionContextMenu } from '../selection-context-menu.js';
import { applyAppearanceToWindow } from '../appearance-settings-ipc.js';
import { markResourceUsageWebContentsId } from './registry.js';

const log = createLogger('resource-usage-window');

export function createResourceUsageWindow(parent?: BrowserWindow | null): BrowserWindow {
  const platformOptions =
    process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 16 } }
      : { frame: false };
  const bgColor = nativeTheme.shouldUseDarkColors ? '#2A2828' : '#EDEDED';

  const win = new BrowserWindow({
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    width: 580,
    height: 520,
    minWidth: 380,
    minHeight: 320,
    title: 'Resource Usage',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '../../resources/icon.png'),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: bgColor,
    ...platformOptions,
    webPreferences: {
      preload: path.join(__dirname, 'resourceUsagePreload.js'),
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
      webviewTag: false,
    },
  });
  markResourceUsageWebContentsId(win.webContents.id);
  markAppContentWindow(win);
  applyAppearanceToWindow(win);
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    applyAppearanceToWindow(win);
  });
  installSelectionContextMenu(win);
  installExternalLinkGuards(win);

  const hash = '/resource-usage-window';
  let loadPromise: Promise<void>;
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    url.searchParams.set('resourceUsageWindow', '1');
    url.hash = hash;
    loadPromise = win.loadURL(url.toString());
  } else {
    loadPromise = win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
      query: { resourceUsageWindow: '1' },
      hash,
    });
  }
  void loadPromise.catch((error: unknown) => {
    log.warn('resource-usage window load rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  log.info('resource-usage window created');
  return win;
}
