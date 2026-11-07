import { contextBridge, ipcRenderer } from 'electron';

import { createAppearanceSnapshotBridge } from './appearanceSnapshot';
import type { LocalThemesResult } from '../shared/local-themes';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../shared/locale';

function readPreferredSystemLocale(): string {
  try {
    const value: unknown = ipcRenderer.sendSync('app-locale:get-preferred-system-locale-sync');
    return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
      ? value
      : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/**
 * 框选浮层、贴图与录屏预览窗口共用的最小 electronAPI: 只够渲染端按主窗口同一份主题、
 * 字体、语言与日志初始化 (见 renderer/region-screenshot-entry.tsx), 没有任何写入或特权能力。
 */
export function exposeScreenshotPageElectronApi(): void {
  contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    // 「跟随系统」时的实际语言。语言包按需加载，窗口启动就按它加载，开始截图 / 录屏时
    // 切到主窗口传来的语言才能立即生效，不会先显示英文再切换。
    preferredSystemLocale: readPreferredSystemLocale(),
    logToMain: (
      level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
      scope: string,
      msg: string,
    ): void => ipcRenderer.send('renderer:log', level, scope, msg),
    appearanceSettings: createAppearanceSnapshotBridge(),
    localThemes: {
      listSync: (): LocalThemesResult => {
        try {
          return ipcRenderer.sendSync('local-themes:list-sync') as LocalThemesResult;
        } catch (error) {
          return { success: false, error: String(error), themes: [], diagnostics: [] };
        }
      },
    },
    // 首启亮色门需要这条线索, 否则已登录的暗色用户会看到亮色浮层。
    authHasPersistedSessionHintSync: (): boolean =>
      ipcRenderer.sendSync('auth:has-persisted-session-hint-sync') === true,
  });
}

export function onPayload<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
