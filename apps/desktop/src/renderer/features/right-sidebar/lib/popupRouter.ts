/**
 * popupRouter —— main 端 webview popup 推送的**窗口级常驻**订阅与路由。
 *
 * 为什么常驻而不是挂在 RightSidebarShell 上:popup 的产生方是 guest 页面
 * (window.open / target=_blank / 跨 host location 写入),它不关心用户此刻在
 * 哪个 route。常驻订阅让正常路径直接消费;preload 另有 8 条 / 30 秒的有界
 * backlog,只兜首次挂载、route 交接与 detached 启动的短暂空窗。否则两类窗口
 * 会把一次性 OAuth URL 留在缓冲直至过期:
 *   - 用户离开聊天视图(设置页等)期间,后台 agent 的 eager-spawn webview 触发
 *     popup —— OAuth 授权 URL 被丢弃,登录流程原地卡死;
 *   - main 端归属等待(事件驱动 report 等待 / deferred URL 捕获)期间用户切走,
 *     等待结束后消息到达时 Shell 已卸载。
 *
 * 本模块与 rsbBrowserBridge 同款生命周期:首个 Shell mount 时 init,之后 Shell
 * 卸载**不解绑**;进程内常驻。Shell 只负责把"用户正在看的 session"喂给
 * `setPopupFallbackSession`(payload 无 opener 归属时的回落目标,保留最后已知值
 * ——Shell 卸载期间到达的无归属 popup 落进用户最后看过的 session,优于直接丢弃)。
 *
 * 路由逻辑本体(水合 → 乐观插入同 tick 登记 popup 标记 → 离屏物化 → 可见性
 * 请求)与原 Shell 内实现逐字一致,注释随迁。
 */

import { createLogger } from '@/lib/logger';

import { addTab, closeTab, ensureHydrated, getBucket } from '../store';
import { eagerSpawnAndReport } from './rsbBrowserBridge';
import { markPopupSpawnedTab } from './popupTabs';
import { findNativePopupTabBySurface, registerNativePopupTab } from './nativePopupTabs';
import { requestRightSidebarVisibility } from './sidebarCommands';

const log = createLogger('rightSidebar.popupRouter');

let initialized = false;
let teardown: (() => void) | null = null;

const MAX_PENDING_POPUPS = 8;
const PENDING_POPUP_TTL_MS = 30_000;

interface PopupPayload {
  url: string;
  openerSessionId?: string;
  nativePopupSurfaceId?: string;
}

interface PendingPopup {
  payload: PopupPayload;
  receivedAt: number;
}

type PopupApi = typeof window.electronAPI;

let popupApi: PopupApi | null = null;
let pendingPopups: PendingPopup[] = [];
let pendingExpiryTimer: ReturnType<typeof setTimeout> | null = null;

/** payload 无 opener 归属时的回落 session:用户最后看过的 RSB session。 */
let fallbackSessionId: string | null = null;

/**
 * Shell 在 sessionId 变化时喂进来。传 null(切到无 session 路由)**不清空**——
 * 保留最后已知值,让 Shell 卸载期间的无归属 popup 仍有处可去。
 */
export function setPopupFallbackSession(sessionId: string | null): void {
  if (!sessionId) return;
  fallbackSessionId = sessionId;
  pruneExpiredPendingPopups();
  drainPendingPopups();
}

function closeNativePopupSurface(payload: PopupPayload, api: PopupApi | null = popupApi): void {
  const surfaceId = payload.nativePopupSurfaceId;
  if (!surfaceId || !api?.rsbNativePopup) return;
  void api.rsbNativePopup.close({ surfaceId }).catch(() => undefined);
}

function clearPendingExpiryTimer(): void {
  if (pendingExpiryTimer === null) return;
  clearTimeout(pendingExpiryTimer);
  pendingExpiryTimer = null;
}

function schedulePendingExpiry(): void {
  clearPendingExpiryTimer();
  if (pendingPopups.length === 0) return;
  const nextExpiryAt = Math.min(
    ...pendingPopups.map(({ receivedAt }) => receivedAt + PENDING_POPUP_TTL_MS),
  );
  // 与 preload buffered fan-out 保持 inclusive cutoff; +1ms 防止零延迟 timer 自旋。
  pendingExpiryTimer = setTimeout(() => {
    pendingExpiryTimer = null;
    pruneExpiredPendingPopups();
  }, Math.max(1, nextExpiryAt - Date.now() + 1));
}

function pruneExpiredPendingPopups(now = Date.now()): void {
  if (pendingPopups.length === 0) {
    clearPendingExpiryTimer();
    return;
  }
  const cutoff = now - PENDING_POPUP_TTL_MS;
  const retained: PendingPopup[] = [];
  for (const pending of pendingPopups) {
    if (pending.receivedAt >= cutoff) {
      retained.push(pending);
    } else {
      closeNativePopupSurface(pending.payload);
    }
  }
  pendingPopups = retained;
  schedulePendingExpiry();
}

function enqueuePendingPopup(payload: PopupPayload): void {
  pruneExpiredPendingPopups();
  pendingPopups.push({ payload, receivedAt: Date.now() });
  while (pendingPopups.length > MAX_PENDING_POPUPS) {
    const evicted = pendingPopups.shift();
    if (evicted) closeNativePopupSurface(evicted.payload);
  }
  schedulePendingExpiry();
}

function routePopup(payload: PopupPayload, targetSessionId: string, api: PopupApi): Promise<void> {
  const { url, nativePopupSurfaceId } = payload;
  const initialState = {
    url,
    title: '',
    favicon: null,
    isAudible: false,
    ...(nativePopupSurfaceId ? { nativePopupSurfaceId } : {}),
  };
  return (async () => {
    await ensureHydrated(targetSessionId);
    const newTab = await addTab(targetSessionId, 'web-browser', initialState, {
      onOptimisticAdd: (tabId) => {
        markPopupSpawnedTab(tabId);
        if (nativePopupSurfaceId) {
          registerNativePopupTab(tabId, targetSessionId, nativePopupSurfaceId);
        }
      },
    });
    if (!getBucket(targetSessionId).tabs.some((t) => t.id === newTab.id)) return;
    if (nativePopupSurfaceId) {
      const claimed = await api.rsbNativePopup.claim({
        surfaceId: nativePopupSurfaceId,
        sessionId: targetSessionId,
        tabId: newTab.id,
      });
      if (!claimed.alive) {
        await closeTab(targetSessionId, newTab.id);
        return;
      }
    } else {
      await eagerSpawnAndReport(targetSessionId, newTab.id, url);
    }
    if (!getBucket(targetSessionId).tabs.some((t) => t.id === newTab.id)) return;
    requestRightSidebarVisibility('open', {
      sessionId: targetSessionId,
      userInitiated: false,
    });
  })();
}

function routePopupSafely(payload: PopupPayload, targetSessionId: string, api: PopupApi): void {
  void routePopup(payload, targetSessionId, api).catch((err) => {
    log.error('rsb popup → addTab failed', { sessionId: targetSessionId, url: payload.url, err });
    closeNativePopupSurface(payload, api);
  });
}

function drainPendingPopups(): void {
  if (!fallbackSessionId || !popupApi || pendingPopups.length === 0) return;
  const targetSessionId = fallbackSessionId;
  const pending = pendingPopups;
  pendingPopups = [];
  clearPendingExpiryTimer();
  // 先清空队列再路由,防止 session 更新或同步 replay 重复 claim;迭代保持 FIFO。
  for (const { payload } of pending) {
    routePopupSafely(payload, targetSessionId, popupApi);
  }
}

/**
 * 绑定 popup 订阅。幂等:重复调用 no-op。与 initRsbBrowserBridge 并列由 Shell
 * mount 时调用;teardown 仅供测试。
 */
export function initPopupRouter(): () => void {
  if (initialized) {
    return teardown ?? (() => undefined);
  }
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api?.onRsbBrowserPopup) {
    // SSR / 测试 / preload 未就绪 —— 静默 no-op。
    initialized = true;
    teardown = () => undefined;
    return teardown;
  }
  initialized = true;
  popupApi = api;

  const offPopup = api.onRsbBrowserPopup((payload) => {
    const targetSessionId = payload.openerSessionId ?? fallbackSessionId;
    if (!targetSessionId) {
      // 冷启动时 preload 会同步 replay,不能丢 OAuth URL 或关闭活 native surface。
      enqueuePendingPopup(payload);
      return;
    }
    // Explicit opener attribution always wins over fallback and never waits behind
    // unrelated cold-start backlog entries.
    routePopupSafely(payload, targetSessionId, api);
  });

  const offNative = api.rsbNativePopup
    ? api.rsbNativePopup.onEvent((event) => {
        if (event.type !== 'closed') return;
        const tab = findNativePopupTabBySurface(event.surfaceId);
        if (!tab) return;
        void closeTab(tab.sessionId, tab.tabId).catch((err) => {
          log.warn('native popup self-close → closeTab failed', { ...tab, err });
        });
      })
    : () => undefined;

  teardown = () => {
    offPopup();
    offNative();
  };
  return teardown;
}

/** Test-only reset. */
export function _resetPopupRouterForTests(): void {
  if (teardown) teardown();
  clearPendingExpiryTimer();
  pendingPopups = [];
  popupApi = null;
  initialized = false;
  teardown = null;
  fallbackSessionId = null;
}
