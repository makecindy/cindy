import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import path from 'node:path';

import { markAppearanceSettingsReaderWindow } from '../appearance-settings-reader';
import { createLogger } from '../logger';
import { installExternalLinkGuards } from '../secondary-windows';

const log = createLogger('region-screenshot:window');

/**
 * 框选浮层与贴图窗口共用的窗口工厂: 加载主窗口同源页面并通过 query 进入各自的
 * 轻量入口 (renderer/index.tsx 分流), 只挂对应的专用 preload。
 *
 * 安全字段与 docs/dev-rules/electron-security-and-process-boundaries.md 的基线一致;
 * 不跑 webview、不开 devTools 以外的任何放宽。
 */
export function createScreenshotPageWindow(
  options: BrowserWindowConstructorOptions & { preload: string; query: string },
): BrowserWindow {
  const { preload, query, ...windowOptions } = options;
  const window = new BrowserWindow({
    show: false,
    frame: false,
    roundedCorners: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    ...windowOptions,
    webPreferences: {
      preload: path.join(__dirname, preload),
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
      // 隐藏时也要及时处理下一次截图的定格画面, 不能被后台节流拖慢弹出。
      backgroundThrottling: false,
    },
  });
  window.setMenuBarVisibility(false);
  installExternalLinkGuards(window);
  // 只读外观快照 (字体 / 字号), 让浮层与贴图的界面和主窗口一致; 不授予任何写入能力。
  markAppearanceSettingsReaderWindow(window);
  const load = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? (() => {
        const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        url.searchParams.set(query, '1');
        return window.loadURL(url.toString());
      })()
    : window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
        query: { [query]: '1' },
      });
  void load.catch((error: unknown) => {
    log.warn('screenshot page load rejected', {
      query,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return window;
}
