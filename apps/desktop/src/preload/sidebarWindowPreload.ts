import { createAccessibilitySupportBridge } from './accessibilitySupport';
import { invokeOpenPath } from './openPath';
import { COPY_PNG_TO_CLIPBOARD_CHANNEL, type CopyPngToClipboardParams } from '../shared/pngClipboard';
import { SELECTION_CONTEXT_MENU_ADD_TO_CHAT_CHANNEL } from '../shared/selectionContextMenu';
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

import { createAppearanceSnapshotBridge } from './appearanceSnapshot';
import { DEVICE_LINK_INVOKE, DEVICE_LINK_PUSH } from '../shared/deviceLinkIpc';
import type { LocalThemesResult } from '../shared/local-themes';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from '../shared/locale';
import {
  RSB_WINDOW_PRESENTATION_READY_CHANNEL,
  RSB_WINDOW_REFRESH_CONTEXT_CHANNEL,
  RSB_WINDOW_RENDERER_READY_CHANNEL,
  RSB_WINDOW_LOCALE_CHANGED_CHANNEL,
  RSB_WINDOW_COMMAND_CHANNEL,
  RSB_WINDOW_CONTEXT_CHANGED_CHANNEL,
  RSB_WINDOW_STATE_CHANGED_CHANNEL,
  RSB_WINDOW_TAB_HANDOFF_CHANNEL,
  RSB_WINDOW_VISIBILITY_CHANGED_CHANNEL,
} from '../shared/rightSidebarWindow';
import type { RsbWindowContext, RsbWindowTabHandoff } from '../shared/rightSidebarWindow';
import {
  SIDEBAR_TAB_WINDOW_ADOPT_TAB_CHANNEL,
  SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL,
  SIDEBAR_TAB_WINDOW_GET_ASSIGNMENT_CHANNEL,
  SIDEBAR_TAB_WINDOW_LOCALE_CHANGED_CHANNEL,
  SIDEBAR_TAB_WINDOW_MERGE_BACK_CHANNEL,
  SIDEBAR_TAB_WINDOW_CLOSE_REQUESTED_CHANNEL,
  SIDEBAR_TAB_WINDOW_PRESENTATION_READY_CHANNEL,
  SIDEBAR_TAB_WINDOW_RENDERER_READY_CHANNEL,
  SIDEBAR_TAB_WINDOW_VISIBILITY_CHANGED_CHANNEL,
} from '../shared/sidebarTabWindow';
import type {
  SidebarTabWindowAdoptRequest,
  SidebarTabWindowAssignmentPayload,
  SidebarTabWindowMergeBackRequest,
  SidebarTabWindowsState,
} from '../shared/sidebarTabWindow';

type ApplicationMenuLocale = SupportedLocale;

function onPayload<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Match the resource window: hidden prewarm must not start decorative playback,
// and late renderer/HMR subscribers must receive the latest native state.
let windowHidden = true;
onPayload<boolean>('window-hidden-change', (hidden) => {
  windowHidden = hidden;
});

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

const appearanceSnapshot = createAppearanceSnapshotBridge({ wallpaperAssets: true });

const fanOutFullscreenChange = (cb: (isFullscreen: boolean) => void): (() => void) =>
  onPayload('fullscreen-change', cb);

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  onSelectionContextMenuAddToChat: (callback: () => void): (() => void) =>
    onPayload(SELECTION_CONTEXT_MENU_ADD_TO_CHAT_CHANNEL, () => callback()),
  accessibilitySupport: createAccessibilitySupportBridge(),
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
  onLocaleChanged: (cb: (locale: SupportedLocale) => void): (() => void) =>
    onPayload(RSB_WINDOW_LOCALE_CHANGED_CHANNEL, cb),
  appearanceSettings: appearanceSnapshot,
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
    invoke: (deviceId: string, channel: string, args: unknown[], scheduling?: { background?: boolean }): Promise<unknown> =>
      ipcRenderer.invoke(DEVICE_LINK_INVOKE.INVOKE, { deviceId, channel, args, ...(scheduling ? { scheduling } : {}) }),
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
    onPeerLinkReopened: (cb: (payload: unknown) => void): (() => void) =>
      onPayload(DEVICE_LINK_PUSH.PEER_LINK_REOPENED, cb),
    onPeerLinkReset: (cb: (payload: unknown) => void): (() => void) =>
      onPayload(DEVICE_LINK_PUSH.PEER_LINK_RESET, cb),
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
        historyView?: string,
        mergeListMessage?: boolean,
      ): Promise<unknown> =>
        ipcRenderer.invoke(DEVICE_LINK_INVOKE.MIRROR_CACHE_PUT_MESSAGES, {
          deviceId,
          sessionId,
          messages,
          expectedInvalidation,
          expectedOwnerToken,
          expectedAccountCounter,
          historyView,
          mergeListMessage,
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
    previewHtml: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:html-preview:open', params),
    cancelHtmlPreview: (requestId: string): Promise<{ ok: true }> => ipcRenderer.invoke('maker:html-preview:cancel', requestId),
    chatFetch: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:chat-file:fetch', params),
    chatDownload: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:chat-file:download', params),
    chatCancel: (requestId: string): Promise<unknown> => ipcRenderer.invoke('maker:chat-file:cancel', requestId),
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
  openPath: (pathOrUrl: string) => invokeOpenPath(ipcRenderer.invoke.bind(ipcRenderer), pathOrUrl),
  showItemInFolder: (params: unknown): Promise<unknown> => ipcRenderer.invoke('shell:show-item-in-folder', params),
  copyPngToClipboard: (params: CopyPngToClipboardParams): Promise<void> =>
    ipcRenderer.invoke(COPY_PNG_TO_CLIPBOARD_CHANNEL, params),
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
    openRetirement: (id: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('ghosts:open-retirement', id),
    acknowledgeRetirement: (id: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('ghosts:acknowledge-retirement', id),
    setEnabled: (id: string, enabled: boolean, expectedInstalledApproval?: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('ghosts:set-enabled', id, enabled, expectedInstalledApproval),
    resolvePanelMedia: (
      uri: string,
      purpose?: 'attach' | 'menu',
      instanceId?: string,
      sourceToken?: string,
    ): Promise<unknown> => sourceToken !== undefined
      ? ipcRenderer.invoke('ghosts:resolve-panel-media', uri, purpose, instanceId, sourceToken)
      : instanceId === undefined
        ? ipcRenderer.invoke('ghosts:resolve-panel-media', uri, purpose)
        : ipcRenderer.invoke('ghosts:resolve-panel-media', uri, purpose, instanceId),
    runtimeStates: (): Promise<{ states: Record<string, string> }> =>
      ipcRenderer.invoke('ghosts:runtime-states'),
    onChanged: (cb: (payload: unknown) => void): (() => void) => onPayload('ghosts:changed', cb),
    onRuntimeChanged: (cb: (payload: unknown) => void): (() => void) =>
      onPayload('ghosts:runtime-changed', cb),
    onLibraryReplaced: (cb: (payload: unknown) => void): (() => void) =>
      onPayload('ghosts:library-replaced', cb),
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
    getContext: (): Promise<RsbWindowContext | null> =>
      ipcRenderer.invoke('maker:rsb-window:get-context'),
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
    ): (() => void) => onPayload(RSB_WINDOW_STATE_CHANGED_CHANNEL, cb),
    onContextChanged: (cb: (ctx: RsbWindowContext) => void): (() => void) =>
      onPayload(RSB_WINDOW_CONTEXT_CHANGED_CHANNEL, cb),
    /** main → 子窗口的命令推送；channel 必须与 main 端 MAKER_PUSH.RSB_WINDOW_COMMAND 同源。 */
    onCommand: (
      cb: (cmd: unknown) => void,
    ): (() => void) => onPayload(RSB_WINDOW_COMMAND_CHANNEL, cb),
    onTabHandoff: (cb: (handoff: RsbWindowTabHandoff) => void): (() => void) =>
      onPayload(RSB_WINDOW_TAB_HANDOFF_CHANNEL, cb),
    sendCommand: (request: unknown): Promise<string> =>
      ipcRenderer.invoke('maker:rsb-window:send-command', request),
    /** 闅愯棌/鏄剧ず鏃堕€氱煡瀛愮獥鍙ｅ埛鏂?context + 閲嶇疆鐬椂浜や簰鎬併€?*/
    onVisibilityChanged: (cb: (payload: { visible: boolean }) => void): (() => void) =>
      onPayload(RSB_WINDOW_VISIBILITY_CHANGED_CHANNEL, cb),
  },

  // 鈹€鈹€ RSB tab 鎸佷箙鍖?杞婚噺,浠?RSB 闇€瑕? 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  // ── 右侧栏单页签独立窗口(sidebar tab window)─────────────────────────────
  // 本 preload 同时服务整栏子窗口与单页签弹出窗口(同一工厂 / 同一 renderer 入口,
  // 按 `?sidebarTabWindow=1` 分流)。弹出窗口只需要:取 / 收指派、双阶段就绪握手、
  // 合并回侧边栏、响应原生关窗与显隐;状态镜像供其内 store 判断页签归属。
  sidebarTabWindow: {
    getState: (): Promise<SidebarTabWindowsState> =>
      ipcRenderer.invoke('maker:sidebar-tab-window:get-state'),
    onStateChanged: (cb: (state: SidebarTabWindowsState) => void): (() => void) =>
      onPayload('maker:sidebar-tab-window:state-changed', cb),
    /** 聚焦另一扇弹出窗口(本窗口内切到被弹出页签时)。 */
    focus: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('maker:sidebar-tab-window:focus', tabId),
    /** 本窗口承载的页签已被关闭:销毁本窗口,不交回页签。 */
    closeForTab: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('maker:sidebar-tab-window:close-for-tab', tabId),
    getAssignment: (): Promise<SidebarTabWindowAssignmentPayload | null> =>
      ipcRenderer.invoke(SIDEBAR_TAB_WINDOW_GET_ASSIGNMENT_CHANNEL),
    onAssigned: (cb: (assignment: SidebarTabWindowAssignmentPayload) => void): (() => void) =>
      onPayload(SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL, cb),
    rendererReady: (): Promise<void> =>
      ipcRenderer.invoke(SIDEBAR_TAB_WINDOW_RENDERER_READY_CHANNEL),
    presentationReady: (): Promise<void> =>
      ipcRenderer.invoke(SIDEBAR_TAB_WINDOW_PRESENTATION_READY_CHANNEL),
    /** 把本窗口里的某个页签合并回侧边栏(窗口清空后 main 关窗)。 */
    mergeBack: (request: SidebarTabWindowMergeBackRequest): Promise<void> =>
      ipcRenderer.invoke(SIDEBAR_TAB_WINDOW_MERGE_BACK_CHANNEL, request),
    /** 本窗口里新建的页签归本窗口承载。 */
    adoptTab: (request: SidebarTabWindowAdoptRequest): Promise<void> =>
      ipcRenderer.invoke(SIDEBAR_TAB_WINDOW_ADOPT_TAB_CHANNEL, request),
    onCloseRequested: (cb: () => void): (() => void) =>
      onPayload(SIDEBAR_TAB_WINDOW_CLOSE_REQUESTED_CHANNEL, cb),
    onVisibilityChanged: (cb: (payload: { visible: boolean }) => void): (() => void) =>
      onPayload(SIDEBAR_TAB_WINDOW_VISIBILITY_CHANGED_CHANNEL, cb),
    onLocaleChanged: (cb: (locale: SupportedLocale) => void): (() => void) =>
      onPayload(SIDEBAR_TAB_WINDOW_LOCALE_CHANGED_CHANNEL, cb),
  },

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
    bots: {
      autonomy: {
        glance: (botId: string): Promise<import('../shared/botAutonomy').BotGlance> =>
          ipcRenderer.invoke('local-db:bots:autonomy:glance', botId),
      },
    },
    // Minimal read-only chat hydration bridge used by BackgroundTasks and the
    // shared makerChatStore. Do not expose the primary window's full DB API.
    sessions: {
      get: (id: string): Promise<unknown> => ipcRenderer.invoke('local-db:sessions:get', id),
      getMany: (ids: string[]): Promise<unknown> => ipcRenderer.invoke('local-db:sessions:get-many', ids),
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
      /** 其它 renderer 改动了某会话的页签持久化数据(主窗 ↔ 弹出窗口)。 */
      onChanged: (cb: (payload: { sessionId: string }) => void): (() => void) =>
        onPayload('maker:right-sidebar-tabs:changed', cb),
    },
    subagentRuns: {
      list: (input: unknown): Promise<unknown> => ipcRenderer.invoke('local-db:subagent-runs:list', input),
      detail: (input: unknown): Promise<unknown> => ipcRenderer.invoke('local-db:subagent-runs:detail', input),
      transcript: (input: unknown): Promise<unknown> => ipcRenderer.invoke('local-db:subagent-runs:transcript', input),
      onChanged: (cb: (payload: unknown, ownerStamp?: unknown) => void): (() => void) => onPayloadWithMetadata('local-db:subagent-runs:changed', cb),
    },
    orcaWorkflows: {
      projectLabel: (workerSessionId: string) => ipcRenderer.invoke('maker:worker:project-label', workerSessionId),
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
      updateWorker: (input: {
        leadSessionId: string;
        workerId: string;
        role?: string;
        label?: string;
      }): Promise<unknown> => ipcRenderer.invoke('maker:worker:update', input),
      endTeam: (leadSessionId: string): Promise<unknown> =>
        ipcRenderer.invoke('maker:team:end', leadSessionId),
      getCollaborationSettings: (): Promise<unknown> =>
        ipcRenderer.invoke('maker:collaboration-settings:get'),
      listExecutionDevices: (): Promise<unknown> =>
        ipcRenderer.invoke('maker:orca:execution-devices'),
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
    onBotAutonomyChanged: (cb: (payload: { botIds?: string[] }) => void): (() => void) =>
      onPayload('maker:bot-autonomy:changed', cb),
    allowBotWorkbenchPermission: (
      botId: string,
      sessionId: string,
      requestId: string,
    ): Promise<{ accepted: boolean }> =>
      ipcRenderer.invoke('maker:rsb-window:allow-bot-workbench-permission', { botId, sessionId, requestId }),
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
  },
  /** 涓荤獥鎺ㄩ€?RSB 娴忚鍣ㄦ寜閿懡浠?鈱樷嚙鈫?绛?鍒板瓙绐楀彛銆?*/
  search: {
    start: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:search:start', params),
    cancel: (params: unknown): Promise<unknown> => ipcRenderer.invoke('maker:search:cancel', params),
    onEvent: (cb: (event: unknown) => void): (() => void) => onPayload('maker:search:event', cb),
  },
  /** 主窗推送 RSB 浏览器按键命令（⌘L / ⌘W 等）—— main 端常量见 webview-security RSB_BROWSER_COMMAND_CHANNEL。 */
  onRsbBrowserCommand: (
    cb: (payload: { command: string }) => void,
  ): (() => void) => onPayload('rsb:browser-command', cb),
});
