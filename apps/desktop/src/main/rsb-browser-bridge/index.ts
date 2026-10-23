/**
 * RSB browser bridge — main-process module entry.
 *
 * Phase 2 wires the renderer's `<webview>` tabs to a main-side registry so
 * Phase 3 backends can drive them via Electron debugger / capturePage / etc.
 * See `registry.ts` for the in-memory model and `ipc.ts` for the IPC contract.
 *
 * Singleton lifetime: created on first `getRsbBrowserBridge()` call, lives for
 * the main process. There is exactly one tab registry per app instance.
 */

import { webContents as electronWebContents } from 'electron';

import { createLogger } from '../logger.js';
import { TabRegistry } from './registry.js';
import { PreviewTabIndex, type PreviewTabGhostInfo } from './previewTabs.js';
import { requestTabOrigin, type TabOrigin } from './guestOrigin.js';
import { getRegisteredTabOpOptions } from './renderer-bridge.js';

export { TabRegistry } from './registry.js';
export type { TabRecord } from './registry.js';
export { PreviewTabIndex, PREVIEW_REQUEST_TTL_MS } from './previewTabs.js';
export type {
  PreviewTabBinding,
  PreviewTabEnded,
  PreviewTabEndReason,
  PreviewTabIndexDeps,
} from './previewTabs.js';
export {
  registerRsbBrowserBridgeIpc,
  _resetRsbBrowserBridgeIpcForTests,
  type RegisterRsbBrowserBridgeOptions,
} from './ipc.js';
export {
  dispatchTabOp,
  registerTabOpResultHandler,
  _resetRendererBridgeForTests,
  type RendererBridgeOptions,
} from './renderer-bridge.js';
export { setCastingTabs, setCastingViewports } from './previewCasting.js';
export { requestTabOrigin, type TabOrigin } from './guestOrigin.js';
export {
  getActiveRsbSessionId,
  setActiveRsbSessionId,
  onActiveRsbSessionIdChange,
  _resetActiveRsbSessionForTests,
} from './active-session.js';

const logger = createLogger('rsb-browser-bridge');

let registry: TabRegistry | null = null;

/**
 * Lazy singleton. Created on first call (typically from bootstrap when
 * registering the IPC handlers). All Phase 3 backends consume this exact
 * instance.
 */
export function getRsbBrowserBridge(): TabRegistry {
  if (!registry) {
    registry = new TabRegistry({
      lookupWebContents: (id) => electronWebContents.fromId(id) ?? null,
      logger,
    });
  }
  return registry;
}

/**
 * Where a tab's `<webview>` sits in its host window (CDP reads a guest's touch coordinates
 * there). Null when the host renderer cannot say; callers must then refuse, not guess.
 */
export function requestGuestOrigin(tab: {
  sessionId: string;
  tabId: string;
}): Promise<TabOrigin | null> {
  return requestTabOrigin(tab, {
    options: getRegisteredTabOpOptions,
    guest: (tabId) => getRsbBrowserBridge().getWebContentsByTabId(tabId),
  });
}

/**
 * 主文档是不是 Chromium 错误页(连接被拒 / DNS 失败)。`getURL()` 在错误页上仍是被请求的
 * 地址,只有主框架已提交的 URL 是 `chrome-error://chromewebdata/`。
 */
function isErrorDocument(wc: Electron.WebContents): boolean {
  try {
    return wc.mainFrame.url.startsWith('chrome-error:');
  } catch {
    return false;
  }
}

let previewTabIndex: PreviewTabIndex | null = null;
let previewGhostResolver: ((ghostId: string) => PreviewTabGhostInfo | null) | null = null;

/**
 * bootstrap 注入:按插件实例 id 取当前身份(已启用且仍声明 preview 槽才算可用)。
 * 保持 rsb-browser-bridge 不反向依赖 cindy-brain;未注入时所有插件视为不可用,
 * 即索引保持为空(fail closed)。
 */
export function setPreviewTabGhostResolver(
  resolver: ((ghostId: string) => PreviewTabGhostInfo | null) | null,
): void {
  previewGhostResolver = resolver;
}

/**
 * 插件预览标签索引单例。previewSlot 经 bootstrap 注入的签发器写入,ipc `report`
 * 绑定,T4 的投屏 Host 读取(list / get / current / onEnded)。
 */
export function getPreviewTabIndex(): PreviewTabIndex {
  if (!previewTabIndex) {
    const index = new PreviewTabIndex({
      getGhost: (ghostId) => previewGhostResolver?.(ghostId) ?? null,
      getGuestUrl: (webContentsId) => {
        const wc = electronWebContents.fromId(webContentsId);
        return wc && !wc.isDestroyed() ? wc.getURL() : null;
      },
      isGuestDocumentFailed: (webContentsId) => {
        const wc = electronWebContents.fromId(webContentsId);
        return !!wc && !wc.isDestroyed() && isErrorDocument(wc);
      },
      watchLoadHealth: (webContentsId, onHealth) => {
        const wc = electronWebContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed()) return () => undefined;
        // errorCode -3 (ERR_ABORTED) = 导航被新导航 / 下载取代,不是页面坏了。
        const onFail = (
          _event: unknown,
          errorCode: number,
          _description: string,
          _url: string,
          isMainFrame: boolean,
        ) => {
          if (isMainFrame && errorCode !== -3) onHealth(true);
        };
        // 错误页提交后同样会触发 did-finish-load,所以按真实提交的文档判断,不是按事件本身。
        const onFinish = () => onHealth(isErrorDocument(wc));
        wc.on('did-fail-load', onFail);
        wc.on('did-finish-load', onFinish);
        return () => {
          if (wc.isDestroyed()) return;
          wc.removeListener('did-fail-load', onFail);
          wc.removeListener('did-finish-load', onFinish);
        };
      },
      watchNavigation: (webContentsId, onNavigate) => {
        const wc = electronWebContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed()) return () => undefined;
        const listener = (_event: unknown, url: string) => onNavigate(url);
        wc.on('did-navigate', listener);
        return () => {
          if (!wc.isDestroyed()) wc.removeListener('did-navigate', listener);
        };
      },
      logger,
    });
    getRsbBrowserBridge().onRelease((record) => index.onRegistryRelease(record));
    previewTabIndex = index;
  }
  return previewTabIndex;
}

/** Test-only reset. */
export function _resetRsbBrowserBridgeForTests(): void {
  registry = null;
  previewTabIndex = null;
  previewGhostResolver = null;
}
