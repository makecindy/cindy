/**
 * createResourceUsageWindow —— 资源监视器辅助窗口的 BrowserWindow 工厂。
 *
 * 窗口规格：
 * - macOS 使用与分离右侧栏相同的独立顶层窗口，避免 parent 子窗进入原生全屏时异常
 * - controller 不按 owner 驱动全屏；macOS 打开时沿用系统原生 Space / 全屏呈现
 * - 关闭全屏窗口时先退出原生全屏，等待 leave-full-screen 后再隐藏复用
 * - 用户可通过原生绿灯正常进入或退出全屏
 * - Windows / Linux 继续挂在 owner 窗口下面
 * - owner 最小化或关到托盘时，监视器一起消失
 * - 可独立拖拽、调整大小
 * - 单实例（重复 open = show + focus）
 * - 通过 `resourceUsageWindow=1` 进入独立轻量 renderer 模块图
 */

import { BrowserWindow, app, nativeTheme, screen } from 'electron';
import path from 'node:path';

import { createLogger } from '../logger.js';
import { installWindowFullscreenStateBroadcast } from '../mainWindowFullscreenStartup.js';
import { markAppContentWindow } from '../windowFocusClassifier.js';
import { installExternalLinkGuards } from '../secondary-windows.js';
import { installSelectionContextMenu } from '../selection-context-menu.js';
import { applyAppearanceToWindow } from '../appearance-settings-ipc.js';
import { t } from '../i18n.js';
import { markResourceUsageWebContentsId } from './registry.js';

const log = createLogger('resource-usage-window');

export function createResourceUsageWindow(parent?: BrowserWindow): BrowserWindow {
  const platformOptions =
    process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 16 } }
      : { frame: false };
  const bgColor = nativeTheme.shouldUseDarkColors ? '#1f1f1e' : '#f8f8f6';
  const parentOption =
    process.platform === 'darwin' || !parent || parent.isDestroyed() ? {} : { parent };

  const win = new BrowserWindow({
    width: 580,
    height: 520,
    minWidth: 380,
    minHeight: 320,
    title: t('titleBar.menuItems.resourceUsage'),
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '../../resources/icon.png'),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: bgColor,
    ...platformOptions,
    ...parentOption,
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
  // 辅助窗口拥有自己的原生全屏生命周期；退出动画开始时交通灯已经恢复，需通过
  // resize 边界兜底提前撤掉 renderer 的全屏标题留白，不能只等待 leave-full-screen。
  installWindowFullscreenStateBroadcast(win, {
    getDisplayBounds: (bounds) => screen.getDisplayMatching(bounds).bounds,
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
    loadPromise = win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      {
        query: { resourceUsageWindow: '1' },
        hash,
      },
    );
  }
  void loadPromise.catch((error: unknown) => {
    log.warn('resource-usage window load rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  log.info('resource-usage window created');
  return win;
}
