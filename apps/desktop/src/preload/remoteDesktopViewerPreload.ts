/** Remote viewer: window chrome, appearance and peer-bound desktop operations only. */

import { contextBridge, ipcRenderer } from 'electron';

import type { AppearanceSettings } from '../shared/appearanceSettings';
import type { LocalThemesResult } from '../shared/local-themes';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from '../shared/locale';
import { REMOTE_VIEWER, type RemoteDesktopViewerApi } from '../shared/remoteDesktopViewer';

type ApplicationMenuLocale = SupportedLocale;

function onPayload<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function readPreferredSystemLocale(): ApplicationMenuLocale {
  try {
    const value = ipcRenderer.sendSync('app-locale:get-preferred-system-locale-sync');
    return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
      ? (value as ApplicationMenuLocale)
      : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

const appearanceSettings = ipcRenderer.sendSync(
  'appearance-settings:get-sync',
) as AppearanceSettings | null;

const fanOutFullscreenChange = (cb: (isFullscreen: boolean) => void): (() => void) =>
  onPayload('fullscreen-change', cb);

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  preferredSystemLocale: readPreferredSystemLocale(),
  windowMinimize: (): void => ipcRenderer.send('window-minimize'),
  windowMaximize: (): void => ipcRenderer.send('window-maximize'),
  windowClose: (): void => ipcRenderer.send('window-close'),
  logToMain: (
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    scope: string,
    msg: string,
  ): void => ipcRenderer.send('renderer:log', level, scope, msg),
  appearanceSettings: {
    getSync: (): AppearanceSettings | null => appearanceSettings,
    onChanged: (cb: (settings: AppearanceSettings) => void): (() => void) =>
      onPayload('appearance-settings:changed', cb),
  },
  localThemes: {
    listSync: (): LocalThemesResult => {
      try {
        return ipcRenderer.sendSync('local-themes:list-sync') as LocalThemesResult;
      } catch (error) {
        return { success: false, error: String(error), themes: [], diagnostics: [] };
      }
    },
  },
  appShortcuts: {
    getState: (): { overrides: Record<string, unknown>; platform: string } =>
      ipcRenderer.sendSync('app-shortcuts:get'),
    onChanged: (cb: (payload: { overrides?: Record<string, unknown> }) => void): (() => void) =>
      onPayload('app-shortcuts:changed', cb),
  },
  theme: {
    applyVibrancy: (familyId: string, isDark: boolean): void => {
      ipcRenderer.send('theme:apply-vibrancy', { familyId, isDark });
    },
  },
  // macOS 原生全屏时红绿灯会隐藏；资源窗口自己的标题栏据此撤销左侧让位。
  onFullscreenChange: fanOutFullscreenChange,
  getFullscreenState: (): Promise<boolean> => ipcRenderer.invoke('get-fullscreen-state'),
  // 资源监视器是独立 renderer，localStorage 默认是空的。没有这条主进程线索时，
  // 首启亮色门会把已登录用户的暗色主题锁成浅色。
  authHasPersistedSessionHintSync: (): boolean =>
    ipcRenderer.sendSync('auth:has-persisted-session-hint-sync') === true,
  remoteDesktopViewer: {
    state: () => ipcRenderer.invoke(REMOTE_VIEWER.STATE),
    request: (generation, request, attempt) =>
      ipcRenderer.invoke(REMOTE_VIEWER.REQUEST, generation, request, attempt),
    ice: (generation, attempt) => ipcRenderer.invoke(REMOTE_VIEWER.ICE, generation, attempt),
    clipboard: (generation, action) =>
      ipcRenderer.invoke(REMOTE_VIEWER.CLIPBOARD, generation, action),
    close: (generation) => ipcRenderer.invoke(REMOTE_VIEWER.CLOSE, generation),
    fullscreen: () => ipcRenderer.invoke(REMOTE_VIEWER.FULLSCREEN),
    rendererReady: () => ipcRenderer.invoke(REMOTE_VIEWER.READY),
    presentationReady: () => ipcRenderer.invoke(REMOTE_VIEWER.PRESENTED),
    onActive: (cb) => onPayload(REMOTE_VIEWER.ACTIVE, cb),
    onLocale: (cb) => onPayload(REMOTE_VIEWER.LOCALE, cb),
    onCloseRequested: (cb) => onPayload(REMOTE_VIEWER.CLOSE_REQUESTED, cb),
    inputFocus: (generation, focused) =>
      ipcRenderer.invoke(REMOTE_VIEWER.INPUT_FOCUS, generation, focused),
  } satisfies RemoteDesktopViewerApi,
});
