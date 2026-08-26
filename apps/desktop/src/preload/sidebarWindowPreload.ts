/**
 * 鍙充晶鏍忓瓙绐楀彛涓撶敤 preload锛氬彧鏆撮湶 RSB 绐楀彛鎵€闇€鐨勬渶灏忚兘鍔涖€?
 *
 * 鍙充晶鏍忔壙杞?WebView(browser plugin)銆佺粓绔€佹枃浠舵祻瑙堝櫒銆丱rca workers銆?
 * 瀹℃煡闈㈡澘绛夎兘鍔涳紝鏈?preload 鍙毚闇?RSB 绐楀彛 chrome + context 鍚屾 +
 * 鍛戒护鎺ユ敹 + RSB tab 鎸佷箙鍖?+ webview security IPC + 澶栬/涓婚/蹇嵎閿?+
 * device-link 杩滅▼浼氳瘽闇€瑕佺殑妗ユ銆?
 *
 * 涓庝富 preload.ts 鐨勫尯鍒細
 *  - 涓嶅惈 maker 浼氳瘽 IPC銆乤gent IPC銆乿oice-input銆佺櫥褰?璁剧疆/鏇存柊绛?
 *  - 涓嶅惈 full bridge 鏆撮湶(濡?process monitor銆乻ubagentRuns銆乧hat 绛?
 *  - 淇濈暀 RSB 蹇呴渶鐨?rightSidebarTabs銆乺sbBrowserBridge銆乤ppearance銆?
 *    appShortcuts銆乼heme銆乴ocalThemes銆乸latform 绛?chrome 鑳藉姏
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { AppearanceSettings } from '../shared/appearanceSettings';
import { DEVICE_LINK_INVOKE, DEVICE_LINK_PUSH } from '../shared/deviceLinkIpc';
import type { LocalThemesResult } from '../shared/local-themes';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from '../shared/locale';
import {
  RSB_WINDOW_PRESENTATION_READY_CHANNEL,
  RSB_WINDOW_REFRESH_CONTEXT_CHANNEL,
  RSB_WINDOW_RENDERER_READY_CHANNEL,
  RSB_WINDOW_LOCALE_CHANGED_CHANNEL,
  RSB_WINDOW_TAB_HANDOFF_CHANNEL,
  RSB_WINDOW_VISIBILITY_CHANGED_CHANNEL,
} from '../shared/rightSidebarWindow';
import type { RsbWindowTabHandoff } from '../shared/rightSidebarWindow';

type ApplicationMenuLocale = SupportedLocale;

function onPayload<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function onPayloadWithMetadata<T, M>(
  channel: string,
  cb: (payload: T, metadata?: M) => void,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T, metadata?: M): void =>
    cb(payload, metadata);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function readPreferredSystemLocale(): ApplicationMenuLocale {
  try {
    const value = ipcRenderer.sendSync('app-locale:get-preferred-system-locale-sync');
    return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
      ? value as ApplicationMenuLocale
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
  onLocaleChanged: (cb: (locale: SupportedLocale) => void): (() => void) =>
    onPayload(RSB_WINDOW_LOCALE_CHANGED_CHANNEL, cb),
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
  // PanelChrome uses this on macOS to keep the traffic-light area and actions
  // aligned while the detached sidebar enters or leaves native fullscreen.
  onFullscreenChange: fanOutFullscreenChange,
  getFullscreenState: (): Promise<boolean> => ipcRenderer.invoke('get-fullscreen-state'),

  // AuthProvider 在分离侧栏中只负责初始化账号快照、监听账号边界变化，以及给
  // device-link 子面板投影当前身份。该窗口没有登录/登出/本地模式/账号删除 UI，
  // 因此不暴露任何认证状态变更能力。
  authHasPersistedSessionHintSync: (): boolean =>
    ipcRenderer.sendSync('auth:has-persisted-session-hint-sync') === true,
  authInitialize: (): Promise<unknown> => ipcRenderer.invoke('auth:initialize'),
  authGetLoginState: (): Promise<unknown> => ipcRenderer.invoke('auth:get-login-state'),
  authGetAccountDeletionAvailability: (): Promise<unknown> =>
    ipcRenderer.invoke('auth:account-deletion:get-availability'),
  authGetAccountDeletionStatus: (): Promise<unknown> =>
    ipcRenderer.invoke('auth:account-deletion:get-status'),
  onAuthStateChange: (cb: (payload: unknown) => void): (() => void) =>
    onPayload('auth:state-change', cb),
  onAuthSessionExpired: (cb: (payload: unknown) => void): (() => void) =>
    onPayload('auth:session-expired', cb),

  // 鈹€鈹€ 鍙充晶鏍忓瓙绐楀彛涓撶敤 API 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  deviceLink: {
    getState: (): Promise<unknown> => ipcRenderer.invoke(DEVICE_LINK_INVOKE.GET_STATE),
    listDevices: (): Promise<unknown> => ipcRenderer.invoke(DEVICE_LINK_INVOKE.LIST_DEVICES),
    invoke: (deviceId: string, channel: string, args: unknown[]): Promise<unknown> =>
      ipcRenderer.invoke(DEVICE_LINK_INVOKE.INVOKE, { deviceId, channel, args }),
    subscribe: (deviceId: string, topics: string[]): Promise<{ ok: true }> =>
      ipcRenderer.invoke(DEVICE_LINK_INVOKE.SUBSCRIBE, { deviceId, topics }),
    unsubscribe: (deviceId: string, topics: string[]): Promise<{ ok: true }> =>
      ipcRenderer.invoke(DEVICE_LINK_INVOKE.UNSUBSCRIBE, { deviceId, topics }),
    onPresenceChanged: (cb: (payload: unknown) => void): (() => void) =>
      onPayload(DEVICE_LINK_PUSH.PRESENCE_CHANGED, cb),
    onStatusChanged: (cb: (payload: unknown) => void): (() => void) =>
      onPayload(DEVICE_LINK_PUSH.STATUS_CHANGED, cb),
    onRemotePush: (cb: (payload: unknown, localOwnerStamp?: unknown) => void): (() => void) =>
      onPayloadWithMetadata(DEVICE_LINK_PUSH.REMOTE_PUSH, cb),
    onAccessRevoked: (cb: (payload: unknown) => void): (() => void) =>
      onPayload(DEVICE_LINK_PUSH.ACCESS_REVOKED, cb),
    onControlTargetChanged: (cb: (payload: unknown) => void): (() => void) =>
      onPayload(DEVICE_LINK_PUSH.CONTROL_TARGET_CHANGED, cb),
    onResponsivenessChanged: (cb: (payload: unknown) => void): (() => void) =>
      onPayload(DEVICE_LINK_PUSH.RESPONSIVENESS_CHANGED, cb),
    mirrorCache: {
      getMessages: (deviceId: string, sessionId: string): Promise<unknown> =>
        ipcRenderer.invoke(DEVICE_LINK_INVOKE.MIRROR_CACHE_GET_MESSAGES, { deviceId, sessionId }),
      putMessages: (
        deviceId: string,
        sessionId: string,
        messages: readonly Record<string, unknown>[],
        expectedInvalidation?: number,
        expectedOwnerToken?: string,
        expectedAccountCounter?: number,
      ): Promise<unknown> =>
        ipcRenderer.invoke(DEVICE_LINK_INVOKE.MIRROR_CACHE_PUT_MESSAGES, {
          deviceId,
          sessionId,
          messages,
          expectedInvalidation,
          expectedOwnerToken,
          expectedAccountCounter,
        }),
      getSessionList: (): Promise<unknown> =>
        ipcRenderer.invoke(DEVICE_LINK_INVOKE.MIRROR_CACHE_GET_SESSION_LIST),
      putSessionList: (
        devices: ReadonlyArray<{
          deviceId: string;
          deviceName: string;
          sessions: readonly Record<string, unknown>[];
        }>,
        expectedOwnerToken?: string,
        expectedAccountCounter?: number,
      ): Promise<unknown> =>
        ipcRenderer.invoke(DEVICE_LINK_INVOKE.MIRROR_CACHE_PUT_SESSION_LIST, {
          devices,
          expectedOwnerToken,
          expectedAccountCounter,
        }),
      clear: (deviceId: string): Promise<{ ok: true }> =>
        ipcRenderer.invoke(DEVICE_LINK_INVOKE.MIRROR_CACHE_CLEAR, { deviceId }),
    },
  },

  // Right-sidebar plugin capabilities. These are intentionally limited to the
  // APIs consumed by the built-in RSB tabs; the full primary-window bridge is
  // not exposed to this detached renderer.
  fileBrowser: {
    listDir: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:list-dir', params),
    listAllFiles: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:list-all', params),
    readFile: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:read-file', params),
    writeFile: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:write-file', params),
    createFile: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:create-file', params),
    createFolder: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:create-folder', params),
    deleteEntry: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:delete-entry', params),
    renameEntry: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:rename-entry', params),
    stat: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:stat', params),
    startWatch: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:start-watch', params),
    stopWatch: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:stop-watch', params),
    onEvent: (cb: (event: unknown) => void): (() => void) => onPayload('maker:file-browser:event', cb),
    fetchRemote: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:fetch-remote', params),
    readCached: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:read-cached', params),
    cachePut: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:file-browser:cache-put', params),
    onTransferProgress: (cb: (event: unknown) => void): (() => void) => onPayload('maker:file-browser:transfer', cb),
    chatFetch: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:chat-file:fetch', params),
    chatStat: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:chat-file:stat', params),
  },
  terminal: {
    create: (params: unknown): Promise<unknown> => ipcRenderer.invoke('terminal:create', params),
    write: (id: string, data: string): Promise<unknown> => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number): Promise<unknown> => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    dispose: (id: string): Promise<unknown> => ipcRenderer.invoke('terminal:dispose', id),
    restart: (id: string): Promise<unknown> => ipcRenderer.invoke('terminal:restart', id),
    onData: (cb: (event: unknown) => void): (() => void) => onPayload('terminal:data', cb),
    onExit: (cb: (event: unknown) => void): (() => void) => onPayload('terminal:exit', cb),
  },
  processMonitor: {
    subscribe: (): Promise<unknown> => ipcRenderer.invoke('process-monitor:subscribe'),
    unsubscribe: (): Promise<unknown> => ipcRenderer.invoke('process-monitor:unsubscribe'),
    terminate: (request: unknown): Promise<unknown> => ipcRenderer.invoke('process-monitor:terminate-agent', request),
    onSample: (cb: (sample: unknown) => void): (() => void) => onPayload('process-monitor:sample', cb),
  },
  rsbNativePopup: {
    claim: (input: unknown): Promise<unknown> => ipcRenderer.invoke('rsb-native-popup:claim', input),
    setBounds: (input: unknown): Promise<unknown> => ipcRenderer.invoke('rsb-native-popup:set-bounds', input),
    command: (input: unknown): Promise<unknown> => ipcRenderer.invoke('rsb-native-popup:command', input),
    close: (input: unknown): Promise<unknown> => ipcRenderer.invoke('rsb-native-popup:close', input),
    onEvent: (cb: (event: unknown) => void): (() => void) => onPayload('rsb-native-popup:event', cb),
  },
  openExternal: (url: string): Promise<unknown> => ipcRenderer.invoke('shell:open-external', url),
  openFileInBrowser: (pathOrUrl: string): Promise<unknown> => ipcRenderer.invoke('shell:open-file-in-browser', pathOrUrl),
  openPath: (pathOrUrl: string): Promise<unknown> => ipcRenderer.invoke('shell:open-path', pathOrUrl),
  showItemInFolder: (params: unknown): Promise<unknown> => ipcRenderer.invoke('shell:show-item-in-folder', params),
  copyMediaToClipboard: (params: unknown): Promise<unknown> =>
    ipcRenderer.invoke('media:copy-to-clipboard', params),
  openMediaWithDefaultApp: (params: unknown): Promise<void> =>
    ipcRenderer.invoke('media:open-with-default-app', params),
  saveMediaAs: (params: unknown): Promise<unknown> => ipcRenderer.invoke('media:save-as', params),
  cacheMediaForSession: (params: {
    url: string;
    sessionId: string;
  }): Promise<unknown> => ipcRenderer.invoke('media:cache-for-session', params),
  readImageBytes: (params: { url: string }): Promise<{ base64: string; mimeType: string }> =>
    ipcRenderer.invoke('media:read-image-bytes', params),
  readCachedImageAsBase64: (
    params: { url: string },
  ): Promise<{ base64: string; mimeType: string }> =>
    ipcRenderer.invoke('image-cache:read-base64', params),
  getFilePath: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  cacheImageFromBuffer: (params: unknown): Promise<unknown> => ipcRenderer.invoke('image-cache:from-buffer', params),
  onRsbBrowserFocusUrlBar: (cb: () => void): (() => void) => onPayload('rsb:browser-focus-url-bar', cb),

  // 意识面板注册与运行所需的最小 bridge。右侧栏独立窗口会复用
  // ghostPanels/GhostChipPanelBody，但不暴露安装、卸载、开发运行时或权限管理能力。
  ghosts: {
    listSync: (): { ghosts: unknown[] } => ipcRenderer.sendSync('ghosts:list'),
    reload: (id: string): Promise<{ state: string }> => ipcRenderer.invoke('ghosts:reload', id),
    setEnabled: (id: string, enabled: boolean): Promise<{ ok: true }> =>
      ipcRenderer.invoke('ghosts:set-enabled', id, enabled),
    resolvePanelMedia: (
      uri: string,
      purpose?: 'attach' | 'menu',
    ): Promise<unknown> => ipcRenderer.invoke('ghosts:resolve-panel-media', uri, purpose),
    runtimeStates: (): Promise<{ states: Record<string, string> }> =>
      ipcRenderer.invoke('ghosts:runtime-states'),
    onChanged: (cb: (payload: unknown) => void): (() => void) => onPayload('ghosts:changed', cb),
    onRuntimeChanged: (cb: (payload: unknown) => void): (() => void) =>
      onPayload('ghosts:runtime-changed', cb),
    onPreviewMedia: (cb: (payload: unknown) => void): (() => void) =>
      onPayload('ghosts:preview-media', cb),
    unreadSync: (): { entries: unknown[] } => {
      try {
        const result = ipcRenderer.sendSync('ghosts:unread') as { entries?: unknown } | null;
        return { entries: Array.isArray(result?.entries) ? result.entries : [] };
      } catch {
        return { entries: [] };
      }
    },
    clearUnread: (id: string, seenAt?: number): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('ghosts:clear-unread', id, seenAt),
    onBadge: (cb: (payload: unknown) => void): (() => void) => onPayload('ghosts:badge', cb),
    onUnreadSnapshot: (cb: (payload: unknown) => void): (() => void) =>
      onPayload('ghosts:unread-snapshot', cb),
  },

  rightSidebarWindow: {
    getState: (): Promise<{ detached: boolean; lastOpen: boolean; open: boolean }> =>
      ipcRenderer.invoke('maker:rsb-window:get-state'),
    open: (payload?: unknown): Promise<void> =>
      ipcRenderer.invoke('maker:rsb-window:open', payload),
    close: (): Promise<void> => ipcRenderer.invoke('maker:rsb-window:close'),
    setDetached: (
      detached: boolean,
      handoff?: RsbWindowTabHandoff,
    ): Promise<{ detached: boolean; lastOpen: boolean; open: boolean }> =>
      ipcRenderer.invoke('maker:rsb-window:set-detached', detached, handoff),
    getContext: (): Promise<{
      sessionId: string | null;
      workdir: string | null;
      remoteHostId: string | null;
      deviceLinkDeviceId?: string | null;
      subagentsAvailable?: boolean;
      available: boolean;
    } | null> => ipcRenderer.invoke('maker:rsb-window:get-context'),
    /** 瀛橀噺灏辩华鎻℃墜 鈫?鏄犲皠鍒?renderer-ready(renderer shell 宸叉寕杞?銆?*/
    ready: (): Promise<void> => ipcRenderer.invoke('maker:rsb-window:ready'),
    /** 鍙岄樁娈靛氨缁?renderer shell 鎸傝浇銆?*/
    rendererReady: (): Promise<void> => ipcRenderer.invoke(RSB_WINDOW_RENDERER_READY_CHANNEL),
    /** 鍙岄樁娈靛氨缁?棣栦唤涓氬姟鍐呭宸叉彁浜ゃ€?*/
    presentationReady: (): Promise<void> => ipcRenderer.invoke(RSB_WINDOW_PRESENTATION_READY_CHANNEL),
    /** 璇锋眰浠?main 缂撳瓨鍒锋柊 context銆?*/
    refreshContext: (): Promise<void> => ipcRenderer.invoke(RSB_WINDOW_REFRESH_CONTEXT_CHANNEL),
    onStateChanged: (
      cb: (state: { detached: boolean; open: boolean }) => void,
    ): (() => void) => onPayload('maker:push:rsb-window:state-changed', cb),
    onContextChanged: (
      cb: (ctx: {
        sessionId: string | null;
        workdir: string | null;
        remoteHostId: string | null;
        deviceLinkDeviceId?: string | null;
        subagentsAvailable?: boolean;
        available: boolean;
      }) => void,
    ): (() => void) => onPayload('maker:push:rsb-window:context-changed', cb),
    onCommand: (
      cb: (cmd: unknown) => void,
    ): (() => void) => onPayload('maker:push:rsb-window:command', cb),
    onTabHandoff: (cb: (handoff: RsbWindowTabHandoff) => void): (() => void) =>
      onPayload(RSB_WINDOW_TAB_HANDOFF_CHANNEL, cb),
    sendCommand: (request: unknown): Promise<string> =>
      ipcRenderer.invoke('maker:rsb-window:send-command', request),
    /** 闅愯棌/鏄剧ず鏃堕€氱煡瀛愮獥鍙ｅ埛鏂?context + 閲嶇疆鐬椂浜や簰鎬併€?*/
    onVisibilityChanged: (cb: (payload: { visible: boolean }) => void): (() => void) =>
      onPayload(RSB_WINDOW_VISIBILITY_CHANGED_CHANNEL, cb),
  },

  // 鈹€鈹€ RSB tab 鎸佷箙鍖?杞婚噺,浠?RSB 闇€瑕? 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  rightSidebarTabs: {
    list: (input: { sessionId: string }): Promise<unknown> =>
      ipcRenderer.invoke('local-db:right-sidebar-tabs:list', input),
    ensureSingleton: (input: {
      sessionId: string;
      kind: string;
      state?: unknown;
    }): Promise<unknown> =>
      ipcRenderer.invoke('local-db:right-sidebar-tabs:ensure-singleton', input),
    upsert: (input: {
      id: string;
      sessionId: string;
      kind: string;
      position: number;
      state?: unknown;
    }): Promise<unknown> => ipcRenderer.invoke('local-db:right-sidebar-tabs:upsert', input),
    close: (input: { id: string }): Promise<unknown> =>
      ipcRenderer.invoke('local-db:right-sidebar-tabs:close', input),
    setActive: (input: { sessionId: string; id: string | null }): Promise<unknown> =>
      ipcRenderer.invoke('local-db:right-sidebar-tabs:setActive', input),
    reorder: (input: { sessionId: string; orderedIds: string[] }): Promise<unknown> =>
      ipcRenderer.invoke('local-db:right-sidebar-tabs:reorder', input),
  },

  // 鈹€鈹€ RSB browser bridge(WebView 鎵胯浇) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  rsbBrowserBridge: {
    report: (input: {
      sessionId: string;
      tabId: string;
      webContentsId: number;
    }): Promise<unknown> => ipcRenderer.invoke('rsb-browser-bridge:report', input),
    release: (input: { tabId: string; webContentsId?: number }): Promise<unknown> =>
      ipcRenderer.invoke('rsb-browser-bridge:release', input),
    snapshot: (input: { liveTabIds: string[] }): Promise<unknown> =>
      ipcRenderer.invoke('rsb-browser-bridge:snapshot', input),
    captureScreenshot: (input: { tabId: string }): Promise<unknown> =>
      ipcRenderer.invoke('rsb-browser-bridge:capture-screenshot', input),
    captureScreenshotData: (input: { tabId: string }): Promise<{ ok: true; data: Uint8Array }> =>
      ipcRenderer.invoke('rsb-browser-bridge:capture-screenshot-data', input),
    onPin: (cb: (payload: { tabId: string }) => void): (() => void) =>
      onPayload('rsb-browser-bridge:pin', cb),
    onUnpin: (cb: (payload: { tabId: string }) => void): (() => void) =>
      onPayload('rsb-browser-bridge:unpin', cb),
    onTabOpRequest: (cb: (request: unknown) => void): (() => void) =>
      onPayload('rsb-browser-bridge:tab-op-request', cb),
    tabOpResult: (result: unknown): Promise<unknown> =>
      ipcRenderer.invoke('rsb-browser-bridge:tab-op-result', result),
    setActiveSession: (input: { sessionId: string | null }): Promise<unknown> =>
      ipcRenderer.invoke('rsb-browser-bridge:set-active-session', input),
    setForeground: (input: { tabId: string | null }): Promise<unknown> =>
      ipcRenderer.invoke('rsb-browser-bridge:set-foreground', input),
    forceKill: (input: { tabId: string; webContentsId?: number }): Promise<unknown> =>
      ipcRenderer.invoke('rsb-browser-bridge:force-kill', input),
    onResourceEvent: (cb: (event: unknown) => void): (() => void) =>
      onPayload('rsb-browser-bridge:resource-event', cb),
  },

  // The renderer's durable-tab consumers use the canonical localDb namespace.
  // Keep the legacy top-level alias above for compatibility with older builds.
  localDb: {
    // Minimal read-only chat hydration bridge used by BackgroundTasks and the
    // shared makerChatStore. Do not expose the primary window's full DB API.
    sessions: {
      get: (id: string): Promise<unknown> => ipcRenderer.invoke('local-db:sessions:get', id),
      list: (limit?: number, status?: string, options?: unknown): Promise<unknown> =>
        ipcRenderer.invoke('local-db:sessions:list', limit, status, options),
      resolveReferences: (sessionIds: string[]): Promise<unknown> =>
        ipcRenderer.invoke('local-db:sessions:resolve-references', sessionIds),
      ackInterrupted: (id: string): Promise<void> =>
        ipcRenderer.invoke('local-db:sessions:ack-interrupted', id),
    },
    messages: {
      list: (
        sessionId: string,
        opts?: { limit?: number; before?: string; beforeTs?: number },
      ): Promise<unknown> => ipcRenderer.invoke('local-db:messages:list', sessionId, opts),
      around: (
        sessionId: string,
        messageId: string,
        opts?: { radius?: number },
      ): Promise<unknown> => ipcRenderer.invoke('local-db:messages:around', sessionId, messageId, opts),
      aroundClientId: (
        sessionId: string,
        clientId: string,
        opts?: { radius?: number },
      ): Promise<unknown> =>
        ipcRenderer.invoke('local-db:messages:around-client-id', sessionId, clientId, opts),
      estimatedSessionValue: (sessionId: string): Promise<unknown> =>
        ipcRenderer.invoke('local-db:messages:estimatedSessionValue', sessionId),
      onCreated: (cb: (payload: unknown, ownerStamp?: unknown) => void): (() => void) =>
        onPayloadWithMetadata('local-db:messages:created', cb),
      onDeleted: (cb: (payload: unknown, ownerStamp?: unknown) => void): (() => void) =>
        onPayloadWithMetadata('local-db:messages:deleted', cb),
      onErrorPersisted: (cb: (payload: unknown, ownerStamp?: unknown) => void): (() => void) =>
        onPayloadWithMetadata('local-db:session:error-persisted', cb),
    },
    rightSidebarTabs: {
      list: (input: unknown): Promise<unknown> => ipcRenderer.invoke('local-db:right-sidebar-tabs:list', input),
      ensureSingleton: (input: unknown): Promise<unknown> => ipcRenderer.invoke('local-db:right-sidebar-tabs:ensure-singleton', input),
      upsert: (input: unknown): Promise<unknown> => ipcRenderer.invoke('local-db:right-sidebar-tabs:upsert', input),
      close: (input: unknown): Promise<unknown> => ipcRenderer.invoke('local-db:right-sidebar-tabs:close', input),
      setActive: (input: unknown): Promise<unknown> => ipcRenderer.invoke('local-db:right-sidebar-tabs:setActive', input),
      reorder: (input: unknown): Promise<unknown> => ipcRenderer.invoke('local-db:right-sidebar-tabs:reorder', input),
    },
    subagentRuns: {
      list: (input: unknown): Promise<unknown> => ipcRenderer.invoke('local-db:subagent-runs:list', input),
      detail: (input: unknown): Promise<unknown> => ipcRenderer.invoke('local-db:subagent-runs:detail', input),
      transcript: (input: unknown): Promise<unknown> => ipcRenderer.invoke('local-db:subagent-runs:transcript', input),
      onChanged: (cb: (payload: unknown, ownerStamp?: unknown) => void): (() => void) => onPayloadWithMetadata('local-db:subagent-runs:changed', cb),
    },
    orcaWorkflows: {
      getByLeadSession: (id: string): Promise<unknown> => ipcRenderer.invoke('local-db:orca-workflows:get-by-lead', id),
      getByWorkerSession: (id: string): Promise<unknown> => ipcRenderer.invoke('local-db:orca-workflows:get-by-worker-session', id),
      listWorkersByLead: (id: string): Promise<unknown> => ipcRenderer.invoke('local-db:orca-workflows:list-workers-by-lead', id),
      listWorkersByLeads: (ids: string[]): Promise<unknown> => ipcRenderer.invoke('local-db:orca-workflows:list-workers-by-leads', ids),
      createWorker: (input: Record<string, unknown>): Promise<unknown> =>
        ipcRenderer.invoke('maker:worker:create', input),
      switchFocus: (input: Record<string, unknown>): Promise<unknown> =>
        ipcRenderer.invoke('maker:worker:switch-focus', input),
      idleWorker: (
        leadSessionId: string,
        workerId: string,
        expectedStatus?: 'done',
      ): Promise<unknown> => {
        if (expectedStatus === 'done') {
          return ipcRenderer.invoke('maker:worker:acknowledge-done', {
            leadSessionId,
            workerId,
          });
        }
        return ipcRenderer.invoke('maker:worker:idle', {
          leadSessionId,
          workerId,
          ...(expectedStatus ? { expectedStatus } : {}),
        });
      },
      archiveWorker: (leadSessionId: string, workerId: string): Promise<unknown> =>
        ipcRenderer.invoke('maker:worker:archive', { leadSessionId, workerId }),
      endTeam: (leadSessionId: string): Promise<unknown> =>
        ipcRenderer.invoke('maker:team:end', leadSessionId),
      getCollaborationSettings: (): Promise<unknown> =>
        ipcRenderer.invoke('maker:collaboration-settings:get'),
      onOrcaWorkerChanged: (cb: (payload: unknown) => void): (() => void) => onPayload('maker:orca:worker-changed', cb),
    },
  },

  gitReview: {
    get: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:get', params),
    summary: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:summary', params),
    commits: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:commits', params),
    commitDiff: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:commit-diff', params),
    branchDiff: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:branch-diff', params),
    fileDiff: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:file-diff', params),
    imagePreview: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:image-preview', params),
    markdownPreview: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:markdown-preview', params),
    openFile: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:open-file', params),
    stageFile: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:stage-file', params),
    unstageFile: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:unstage-file', params),
    discardFile: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:discard-file', params),
    stageHunk: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:stage-hunk', params),
    unstageHunk: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:unstage-hunk', params),
    discardHunk: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:discard-hunk', params),
    stageAll: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:stage-all', params),
    unstageAll: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:unstage-all', params),
    discardAll: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:discard-all', params),
    commit: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:commit', params),
    push: (params: unknown): Promise<unknown> => ipcRenderer.invoke('git-review:push', params),
  },
  maker: {
    // Live event subset consumed by makerChatStore in the detached renderer.
    onEvent: (cb: (payload: unknown) => void): (() => void) => onPayload('maker:event', cb),
    onStatusChanged: (cb: (payload: unknown) => void): (() => void) =>
      onPayload('maker:status-changed', cb),
    onInputProjection: (cb: (payload: unknown) => void): (() => void) =>
      onPayload('maker:input:projection', cb),
    onInteractionRequest: (cb: (payload: unknown) => void): (() => void) =>
      onPayload('maker:interaction-request', cb),
    onInteractionDismissed: (cb: (payload: unknown) => void): (() => void) =>
      onPayload('maker:interaction-dismissed', cb),
    getTurnChangeSets: (sessionId: string, ids: string[]): Promise<unknown> =>
      ipcRenderer.invoke('maker:turn-change-sets:get', sessionId, ids),
    getWorkflowProgress: (sessionId: string, taskId: string): Promise<unknown> =>
      ipcRenderer.invoke('maker:get-workflow-progress', sessionId, taskId),
    listSessionBackgroundTasks: (sessionId: string): Promise<unknown> =>
      ipcRenderer.invoke('maker:session-background-tasks:list', sessionId),
    stopAgentTask: (sessionId: string, taskId: string): Promise<unknown> =>
      ipcRenderer.invoke('maker:agent-task:stop', sessionId, taskId),
    controlPiSubagent: (input: unknown): Promise<unknown> =>
      ipcRenderer.invoke('maker:pi-subagent:control', input),
    getPendingInteractions: (sessionId: string): Promise<unknown> =>
      ipcRenderer.invoke('maker:get-pending-interactions', sessionId),
    iosSimulator: {
      requestAccess: (request: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:ios-simulator:request-access', request),
      status: (request: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:ios-simulator:status', request),
      call: (request: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:ios-simulator:call', request),
      setAgentControl: (request: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:ios-simulator:set-agent-control', request),
      setMutationControl: (request: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:ios-simulator:set-mutation-control', request),
      setViewerVisibility: (request: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:ios-simulator:set-viewer-visibility', request),
      retryNativeRoute: (request: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:ios-simulator:retry-native-route', request),
      latestFrame: (request: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:ios-simulator:latest-frame', request),
      setStreamProfile: (request: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:ios-simulator:set-stream-profile', request),
      liveTouch: (request: unknown): Promise<unknown> =>
        ipcRenderer.invoke('maker:ios-simulator:live-touch', request),
      onH264Frame: (cb: (payload: unknown) => void): (() => void) =>
        onPayload('maker:ios-simulator:h264-frame', cb),
      onRouteStatus: (cb: (payload: unknown) => void): (() => void) =>
        onPayload('maker:ios-simulator:route-status', cb),
      onFocusRequest: (cb: (payload: unknown) => void): (() => void) =>
        onPayload('maker:ios-simulator:focus-request', cb),
    },
  },
  /** 涓荤獥鎺ㄩ€?RSB 娴忚鍣ㄦ寜閿懡浠?鈱樷嚙鈫?绛?鍒板瓙绐楀彛銆?*/
  search: {
    start: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:search:start', params),
    cancel: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:search:cancel', params),
    onEvent: (cb: (event: unknown) => void): (() => void) => onPayload('maker:search:event', cb),
  },
  onRsbBrowserCommand: (
    cb: (payload: { command: string }) => void,
  ): (() => void) => onPayload('maker:push:rsb-browser-command', cb),
});
