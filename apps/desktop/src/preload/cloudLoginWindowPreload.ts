/** Cloud login only: window chrome, read-only appearance and scoped login actions. */

import { contextBridge, ipcRenderer } from 'electron';

import { createAppearanceSnapshotBridge } from './appearanceSnapshot';
import type { LocalThemesResult } from '../shared/local-themes';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from '../shared/locale';
import { CLOUD_LOGIN_WINDOW as C, type CloudLoginWindowApi } from '../shared/cloudLoginWindow';

type ApplicationMenuLocale = SupportedLocale;

function onPayload<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// This window is created hidden. Capture the initial main broadcast before the
// lazy renderer entry loads, then replay it to late/HMR subscribers.
let windowHidden = true;
onPayload<boolean>('window-hidden-change', (hidden) => {
  windowHidden = hidden;
});

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

const appearanceSnapshot = createAppearanceSnapshotBridge({ wallpaperAssets: true });

const fanOutFullscreenChange = (cb: (isFullscreen: boolean) => void): (() => void) =>
  onPayload('fullscreen-change', cb);

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  onWindowHiddenChange: (cb: (hidden: boolean) => void): (() => void) => {
    const off = onPayload('window-hidden-change', cb);
    cb(windowHidden);
    return off;
  },
  preferredSystemLocale: readPreferredSystemLocale(),
  windowMinimize: (): void => ipcRenderer.send('window-minimize'),
  windowMaximize: (): void => ipcRenderer.send('window-maximize'),
  windowClose: (): void => ipcRenderer.send('window-close'),
  logToMain: (
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    scope: string,
    msg: string,
  ): void => ipcRenderer.send('renderer:log', level, scope, msg),
  appearanceSettings: appearanceSnapshot,
  localThemes: {
    listSync: (): LocalThemesResult => {
      try {
        return ipcRenderer.sendSync('local-themes:list-sync') as LocalThemesResult;
      } catch (error) {
        return { success: false, error: String(error), themes: [], diagnostics: [] };
      }
    },
    onChanged: (cb: (payload: LocalThemesResult) => void): (() => void) =>
      onPayload('local-themes:changed', cb),
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
  // macOS 原生全屏时红绿灯会隐藏；授权窗口自己的标题栏据此撤销左侧让位。
  onFullscreenChange: fanOutFullscreenChange,
  getFullscreenState: (): Promise<boolean> => ipcRenderer.invoke('get-fullscreen-state'),
  // 授权窗口是独立 renderer，localStorage 默认是空的。没有这条主进程线索时，
  // 首启亮色门会把已登录用户的暗色主题锁成浅色。
  authHasPersistedSessionHintSync: (): boolean =>
    ipcRenderer.sendSync('auth:has-persisted-session-hint-sync') === true,
  acceptPrivacyConsent: () => ipcRenderer.invoke('analytics:consent-accept'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  cloudLoginWindow: {
    getState: () => ipcRenderer.invoke(C.state, {}),
    rendererReady: () => ipcRenderer.invoke(C.ready, {}),
    presentationReady: () => ipcRenderer.invoke(C.presented, {}),
    close: (generation: number) => ipcRenderer.invoke(C.close, { generation }),
    onChanged: (cb) => onPayload(C.changed, cb),
    onLocaleChanged: (cb) => onPayload(C.locale, cb),
    start: (generation) => ipcRenderer.invoke(C.start, { generation }),
    dispatch: (generation, input) => ipcRenderer.invoke(C.dispatch, { ...input, generation }),
    poll: (generation, input) => ipcRenderer.invoke(C.poll, { ...input, generation }),
    end: (generation, input) => ipcRenderer.invoke(C.end, { ...input, generation }),
  } satisfies Omit<CloudLoginWindowApi, 'open' | 'onCompleted'>,
});
