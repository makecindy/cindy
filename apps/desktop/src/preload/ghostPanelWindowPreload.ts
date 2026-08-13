/**
 * 插件面板独立窗口专用 preload：最小权限 bridge。
 *
 * 能力清单基于 GhostPanelWindowLayout + GhostChipPanelBody + GhostMediaLightboxHost +
 * ghostPanels + useInstalledGhosts + runtimeStates + ghostMediaHandover 的实际
 * `window.electronAPI.*` 调用栈静态收窄：
 *  - 窗口 chrome(appearance / windowControls / shortcuts / theme)
 *  - 插件面板窗口状态(detach / attach)
 *  - 双阶段就绪握手 + visibility 刷新
 *  - 插件管理(list / reload / setEnabled / resolvePanelMedia / runtimeStates +
 *    事件订阅 onChanged / onRuntimeChanged / onPreviewMedia)
 *  - 面板产物右键菜单媒体动作(copyMediaToClipboard / showItemInFolder)
 *  - 面板拖拽引渡落会话附件(cacheMediaForSession)
 *
 * 不得复制主 preload 的完整 ghosts bridge 或 maker/session/voice/login 桥。
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { AppearanceSettings } from '../shared/appearanceSettings';
import type { LocalThemesResult } from '../shared/local-themes';
import type { GhostPanelWindowsState } from '../shared/ghostPanelWindow';
import { isValidGhostId } from '../shared/ghost';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from '../shared/locale';
import {
  GHOST_PANEL_WINDOW_CLOSE_REQUESTED_CHANNEL,
  GHOST_PANEL_WINDOW_CLOSE_REQUEST_RESOLVED_CHANNEL,
  GHOST_PANEL_WINDOW_MINIMIZE_REQUESTED_CHANNEL,
  GHOST_PANEL_WINDOW_PRESENTATION_READY_CHANNEL,
  GHOST_PANEL_WINDOW_RENDERER_READY_CHANNEL,
  GHOST_PANEL_WINDOW_LOCALE_CHANGED_CHANNEL,
  GHOST_PANEL_WINDOW_VISIBILITY_CHANGED_CHANNEL,
} from '../shared/ghostPanelWindow';

type Unsub = () => void;
type ApplicationMenuLocale = SupportedLocale;

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

function onPayload<T>(channel: string, cb: (payload: T) => void): Unsub {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const currentGhostPanelId = (() => {
  const raw = new URLSearchParams(window.location.search).get('ghostPanelWindow');
  return isValidGhostId(raw) ? raw : null;
})();

function mutationErrorForGhostPanel(id: string): Error | null {
  if (currentGhostPanelId === null || id !== currentGhostPanelId) {
    return new Error('ghost panel mutation must target the current panel');
  }
  return null;
}

// 事件扇出型通道（main 广播 → 所有 renderer），按名注册 listener，fan-out 在 preload 层。
function fanOut(channel: string): (cb: (payload: unknown) => void) => Unsub {
  return (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

const fanOutGhostsChanged = fanOut('ghosts:changed');
const fanOutGhostRuntimeChanged = fanOut('ghosts:runtime-changed');
const fanOutGhostPreviewMedia = fanOut('ghosts:preview-media');

function onCurrentGhostBadge(
  cb: (payload: { ghostId: string; unread: boolean; summary?: string; at?: number }) => void,
): Unsub {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
    if (currentGhostPanelId === null || typeof payload !== 'object' || payload === null) return;
    const candidate = payload as { ghostId?: unknown };
    if (candidate.ghostId !== currentGhostPanelId) return;
    cb(payload as { ghostId: string; unread: boolean; summary?: string; at?: number });
  };
  ipcRenderer.on('ghosts:badge', listener);
  return () => ipcRenderer.removeListener('ghosts:badge', listener);
}

function onCurrentGhostUnreadSnapshot(
  cb: (payload: { entries: { ghostId: string; summary?: string; at: number }[] }) => void,
): Unsub {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
    if (currentGhostPanelId === null || typeof payload !== 'object' || payload === null) return;
    const entries = (payload as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return;
    const scoped: { ghostId: string; summary?: string; at: number }[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const candidate = entry as { ghostId?: unknown; at?: unknown; summary?: unknown };
      if (candidate.ghostId !== currentGhostPanelId || typeof candidate.at !== 'number') continue;
      scoped.push({
        ghostId: currentGhostPanelId,
        at: candidate.at,
        ...(typeof candidate.summary === 'string' ? { summary: candidate.summary } : {}),
      });
    }
    cb({ entries: scoped });
  };
  ipcRenderer.on('ghosts:unread-snapshot', listener);
  return () => ipcRenderer.removeListener('ghosts:unread-snapshot', listener);
}

const appearanceSettings = ipcRenderer.sendSync(
  'appearance-settings:get-sync',
) as AppearanceSettings | null;

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
  onLocaleChanged: (cb: (locale: SupportedLocale) => void): Unsub =>
    onPayload(GHOST_PANEL_WINDOW_LOCALE_CHANGED_CHANNEL, cb),
  appearanceSettings: {
    getSync: (): AppearanceSettings | null => appearanceSettings,
    onChanged: (cb: (settings: AppearanceSettings) => void): Unsub =>
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
    onChanged: (cb: (payload: { overrides?: Record<string, unknown> }) => void): Unsub =>
      onPayload('app-shortcuts:changed', cb),
  },
  theme: {
    applyVibrancy: (familyId: string, isDark: boolean): void => {
      ipcRenderer.send('theme:apply-vibrancy', { familyId, isDark });
    },
  },

  // ── 媒体操作（面板产物右键菜单 / 拖拽引渡） ──────────────────────────
  // 与主 preload 同款 channel，main 侧 handler 对所有受信 renderer 生效。

  copyMediaToClipboard: (params: {
    url?: string;
    filePath?: string;
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('media:copy-to-clipboard', params),

  showItemInFolder: (params: {
    url?: string;
    filePath?: string;
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:show-item-in-folder', params),

  cacheMediaForSession: (params: {
    url: string;
    sessionId: string;
  }): Promise<{
    url: string;
    name: string;
    ext: string;
    size: number;
    mimeType: string;
  }> => ipcRenderer.invoke('media:cache-for-session', params),

  /** 用系统默认应用打开图片/视频（cindy-media:// 源——lightbox 内菜单项）。 */
  openMediaWithDefaultApp: (params: { url: string }): Promise<void> =>
    ipcRenderer.invoke('media:open-with-default-app', params),

  /** 「另存为」系统保存对话框（lightbox 内菜单项）。 */
  saveMediaAs: (params: { url: string }): Promise<{ canceled: boolean; savedPath?: string }> =>
    ipcRenderer.invoke('media:save-as', params),

  // ── 插件面板窗口状态 ────────────────────────────────────────────────

  ghostPanelWindow: {
    getStateSync: (): GhostPanelWindowsState =>
      ipcRenderer.sendSync('ghost-panel-window:get-state-sync') as GhostPanelWindowsState,
    getState: (): Promise<GhostPanelWindowsState> =>
      ipcRenderer.invoke('maker:ghost-panel-window:get-state'),
    open: (ghostId: string): Promise<void> => {
      const error = mutationErrorForGhostPanel(ghostId);
      if (error) return Promise.reject(error);
      return ipcRenderer.invoke('maker:ghost-panel-window:open', ghostId);
    },
    setDetached: (
      ghostId: string,
      detached: boolean,
    ): Promise<GhostPanelWindowsState> => {
      const error = mutationErrorForGhostPanel(ghostId);
      if (error) return Promise.reject(error);
      return ipcRenderer.invoke('maker:ghost-panel-window:set-detached', ghostId, detached);
    },
    onStateChanged: (cb: (state: GhostPanelWindowsState) => void): Unsub =>
      onPayload('maker:push:ghost-panel-window:state-changed', cb),
    rendererReady: (): Promise<void> =>
      ipcRenderer.invoke(GHOST_PANEL_WINDOW_RENDERER_READY_CHANNEL),
    presentationReady: (): Promise<void> =>
      ipcRenderer.invoke(GHOST_PANEL_WINDOW_PRESENTATION_READY_CHANNEL),
    onVisibilityChanged: (cb: (payload: { visible: boolean }) => void): Unsub =>
      onPayload(GHOST_PANEL_WINDOW_VISIBILITY_CHANGED_CHANNEL, cb),
    onCloseRequested: (cb: () => void): Unsub =>
      onPayload(GHOST_PANEL_WINDOW_CLOSE_REQUESTED_CHANNEL, cb),
    onMinimizeRequested: (cb: () => void): Unsub =>
      onPayload(GHOST_PANEL_WINDOW_MINIMIZE_REQUESTED_CHANNEL, cb),
    resolveCloseRequest: (approved: boolean): Promise<void> =>
      ipcRenderer.invoke(GHOST_PANEL_WINDOW_CLOSE_REQUEST_RESOLVED_CHANNEL, approved),
  },

  // ── 插件管理（GhostPanelWindowLayout 依赖方法集） ─────────────────────

  ghosts: {
    /** 已装清单（同步：与面板体同帧渲染，不闪占位）。 */
    listSync: (): { ghosts: unknown[] } => ipcRenderer.sendSync('ghosts:list'),
    /** 重载插件（面板崩溃后恢复）。 */
    reload: (id: string): Promise<{ state: string }> => {
      const error = mutationErrorForGhostPanel(id);
      if (error) return Promise.reject(error);
      return ipcRenderer.invoke('ghosts:reload', id);
    },
    /** 启用/停用（面板错误态「关闭」按钮）。 */
    setEnabled: (id: string, enabled: boolean): Promise<{ ok: true }> => {
      const error = mutationErrorForGhostPanel(id);
      if (error) return Promise.reject(error);
      return ipcRenderer.invoke('ghosts:set-enabled', id, enabled);
    },
    /** 解析面板媒体 URI → cindy-media:// 地址（右键菜单 / 拖拽引渡）。 */
    resolvePanelMedia: (
      uri: string,
      purpose?: 'attach' | 'menu',
    ): Promise<
      | { url: string; kind?: 'image' }
      | { url: string; kind: 'video'; absPath: string; size: number; name: string; ext: string; mimeType: string }
    > => ipcRenderer.invoke('ghosts:resolve-panel-media', uri, purpose),
    /** 运行时状态快照（面板崩溃/熔断错误态接管）。 */
    runtimeStates: (): Promise<{ states: Record<string, string> }> =>
      ipcRenderer.invoke('ghosts:runtime-states'),
    // ── 事件订阅 ──────────────────────────────────────────────────────
    /** 插件装/卸/启/停/换面板形态。 */
    onChanged: fanOutGhostsChanged,
    /** 插件运行时状态变化（crashed / fused / off 等）。 */
    onRuntimeChanged: fanOutGhostRuntimeChanged,
    /** 面板点图/视频预览（宿主弹 lightbox）。 */
    onPreviewMedia: fanOutGhostPreviewMedia,
    /** 未读角标快照（ghostUnreadStore 首帧）。 */
    unreadSync: (): { entries: { ghostId: string; summary?: string; at: number }[] } => {
      if (currentGhostPanelId === null) return { entries: [] };
      try {
        const result = ipcRenderer.sendSync('ghosts:unread') as { entries?: unknown } | null;
        if (!Array.isArray(result?.entries)) return { entries: [] };
        const entries: { ghostId: string; summary?: string; at: number }[] = [];
        for (const raw of result.entries) {
          if (typeof raw !== 'object' || raw === null) continue;
          const { ghostId, summary, at } = raw as Record<string, unknown>;
          if (ghostId !== currentGhostPanelId || typeof at !== 'number') continue;
          entries.push({ ghostId, ...(typeof summary === 'string' ? { summary } : {}), at });
        }
        return { entries };
      } catch {
        return { entries: [] };
      }
    },
    /** 熄灭未读（打开面板 = 已读）。 */
    clearUnread: (id: string, seenAt?: number): Promise<{ ok: boolean }> => {
      const error = mutationErrorForGhostPanel(id);
      if (error) return Promise.reject(error);
      return ipcRenderer.invoke('ghosts:clear-unread', id, seenAt);
    },
    /** 未读角标变化。 */
    onBadge: onCurrentGhostBadge,
    /** 未读快照变化（ghostUnreadStore 增量更新）。 */
    onUnreadSnapshot: onCurrentGhostUnreadSnapshot,
  },
});
