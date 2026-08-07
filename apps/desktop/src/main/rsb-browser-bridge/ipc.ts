/**
 * IPC wiring for the RSB browser bridge.
 *
 * Three renderer → main `invoke` channels feed the TabRegistry:
 *  - `report` after webview `dom-ready` (renderer has a valid webContentsId)
 *  - `release` when pool releases a webview (tab close, LRU evict)
 *  - `snapshot` at RSB shell mount to recover from missed releases
 *
 * Two main → renderer `send` channels carry pin state changes:
 *  - `pin` / `unpin` —— the registry's pin set drives this; the renderer
 *    suppresses LRU eviction on pinned tabs.
 *
 * All `invoke` handlers validate inputs and throw via `throwIpcError` (rule 13).
 */

import {
  app,
  clipboard,
  ipcMain,
  webContents as electronWebContents,
  type WebContents,
} from 'electron';

import {
  RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_CHANNEL,
  RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_DATA_CHANNEL,
  RSB_BROWSER_BRIDGE_FORCE_KILL_CHANNEL,
  RSB_BROWSER_BRIDGE_PIN_CHANNEL,
  RSB_BROWSER_BRIDGE_RELEASE_CHANNEL,
  RSB_BROWSER_BRIDGE_REPORT_CHANNEL,
  RSB_BROWSER_BRIDGE_RESOURCE_EVENT_CHANNEL,
  RSB_BROWSER_BRIDGE_SET_FOREGROUND_CHANNEL,
  RSB_BROWSER_BRIDGE_SNAPSHOT_CHANNEL,
  RSB_BROWSER_BRIDGE_UNPIN_CHANNEL,
  type RsbBrowserBridgeReportPayload,
  type RsbBrowserBridgeResourceEvent,
} from '../../shared/rsbBrowserBridge.js';
import {
  requireNonNegativeInt,
  requireObject,
  requireString,
  throwIpcError,
} from '../utils/ipcValidate.js';
import type { TabRegistry } from './registry.js';
import {
  BrowserGuestResourceWatchdog,
  ForegroundTabTracker,
  pickResourceEventTarget,
  type GuestWebContentsLike,
} from './resource-watchdog.js';

interface IpcLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export interface RegisterRsbBrowserBridgeOptions {
  registry: TabRegistry;
  /**
   * Resolves the host webContents (renderer) so pin/unpin broadcasts know
   * where to send. Phase 2 has exactly one main window; in multi-window
   * futures this becomes a "all main-window renderers" fan-out.
   */
  getHostWebContents: () => WebContents | null;
  /** Main-owned popup WebContents do not expose webview.hostWebContents. */
  getNativePopupOwnerWebContents?: (webContentsId: number) => WebContents | null;
  logger: IpcLogger;
}

/**
 * Idempotency guard — `app.on('ready', ...)` paths can in principle fire the
 * registration twice during tests / HMR. The first registration wins; later
 * calls are no-ops.
 */
let registered = false;
/** 当前活跃的看门狗实例 —— 测试 reset 时必须 stop,否则 interval 泄漏到后续用例。 */
let activeWatchdog: BrowserGuestResourceWatchdog | null = null;

export function registerRsbBrowserBridgeIpc(opts: RegisterRsbBrowserBridgeOptions): () => void {
  if (registered) {
    return () => undefined;
  }
  registered = true;

  const { registry, getHostWebContents, getNativePopupOwnerWebContents, logger } = opts;

  const resolveOwner = (target: WebContents): WebContents | null => {
    const webviewHost = (
      target as unknown as {
        hostWebContents?: WebContents & { isDestroyed?: () => boolean };
      }
    ).hostWebContents;
    if (
      webviewHost &&
      (typeof webviewHost.isDestroyed !== 'function' || !webviewHost.isDestroyed())
    ) {
      return webviewHost;
    }
    return getNativePopupOwnerWebContents?.(target.id) ?? null;
  };

  ipcMain.handle(RSB_BROWSER_BRIDGE_REPORT_CHANNEL, (event, payload: unknown) => {
    const obj = requireObject(payload, 'report payload');
    const sessionId = requireString(obj.sessionId, 'sessionId');
    const tabId = requireString(obj.tabId, 'tabId');
    const webContentsId = requireNonNegativeInt(obj.webContentsId, 'webContentsId');

    // ── Caller-authorization gate ──────────────────────────────────────────
    // A renderer that calls `report` could in principle pass ANY integer as
    // webContentsId — including the host renderer's own (id 1 in most boots).
    // The future Phase 3 backend will drive CDP against whatever this resolves
    // to, so we MUST verify the claim before recording it.
    //
    // Two checks:
    //   1. The resolved webContents is a `webview` guest (not main window,
    //      not DevTools, not extension page).
    //   2. The webview is hosted by the sender (`hostWebContents === sender`).
    //      Electron exposes `hostWebContents` on guests of `<webview>` — for
    //      the embedded webview's wc it points back at the host renderer.
    //      This rules out a renderer reporting a webview hosted by ANOTHER
    //      renderer or a guest page.
    const target = electronWebContents.fromId(webContentsId);
    if (!target || target.isDestroyed()) {
      throwIpcError('INVALID_PARAMS', `webContentsId ${webContentsId} does not resolve`);
    }
    if (target.getType() !== 'webview') {
      throwIpcError(
        'INVALID_PARAMS',
        `webContentsId ${webContentsId} is not a <webview> guest (type=${target.getType()})`,
      );
    }
    // hostWebContents is non-standard but exposed; cast for the typing gap.
    const host = resolveOwner(target);
    if (!host || host.id !== event.sender.id) {
      throwIpcError(
        'INVALID_PARAMS',
        `webContentsId ${webContentsId} is not hosted by the sender`,
      );
    }

    const record: RsbBrowserBridgeReportPayload = { sessionId, tabId, webContentsId };
    registry.report(record);
    return { ok: true };
  });

  ipcMain.handle(RSB_BROWSER_BRIDGE_RELEASE_CHANNEL, (_e, payload: unknown) => {
    const obj = requireObject(payload, 'release payload');
    const tabId = requireString(obj.tabId, 'tabId');
    // 可选 stale 防护:携带旧 renderer report 过的 webContentsId 时,registry
    // 只在当前记录仍指向它时才释放(宿主迁移竞态,见 registry.release)。
    let expected: number | undefined;
    if (obj.webContentsId !== undefined) {
      if (typeof obj.webContentsId !== 'number' || !Number.isInteger(obj.webContentsId)) {
        throwIpcError('INVALID_PARAMS', 'webContentsId must be an integer when provided');
      }
      expected = obj.webContentsId;
    }
    registry.release(tabId, expected);
    return { ok: true };
  });

  ipcMain.handle(RSB_BROWSER_BRIDGE_SNAPSHOT_CHANNEL, (_e, payload: unknown) => {
    const obj = requireObject(payload, 'snapshot payload');
    if (!Array.isArray(obj.liveTabIds)) {
      throwIpcError('INVALID_PARAMS', 'liveTabIds must be an array');
    }
    const liveTabIds: string[] = (obj.liveTabIds as unknown[]).map((id, i) => {
      if (typeof id !== 'string' || id === '') {
        throwIpcError('INVALID_PARAMS', `liveTabIds[${i}] must be a non-empty string`);
      }
      return id;
    });
    const result = registry.reconcile(liveTabIds);
    if (result.dropped.length > 0) {
      logger.info('RSB browser registry reconciled — dropped stale entries', {
        dropped: result.dropped,
        kept: result.kept,
      });
    }
    return {
      ok: true,
      dropped: result.dropped,
      kept: result.kept,
      // Returned so the renderer can re-mirror the main-side pin authority
      // into its pool after a reload (P1-3 in Phase 2 review).
      pinnedTabIds: result.pinnedTabIds,
    };
  });

  /**
   * 截图公共段:payload 校验 → registry 取 guest webContents → 宿主校验 →
   * capturePage → 空图报错。两个截图 channel(写剪贴板 / 返回字节)共用。
   * 安全门与 `report` 同理:tabId → registry → webContents 后,校验该 guest
   * 确实挂在发起请求的 renderer 下,防止拿别的窗口 / 别的 renderer 的画面。
   */
  const capturePageForSender = async (
    event: Electron.IpcMainInvokeEvent,
    payload: unknown,
  ): Promise<Electron.NativeImage> => {
    const obj = requireObject(payload, 'capture-screenshot payload');
    const tabId = requireString(obj.tabId, 'tabId');

    const target = registry.getWebContentsByTabId(tabId);
    if (!target) {
      throwIpcError('NOT_FOUND', `no live webContents for tab ${tabId}`);
    }
    const host = resolveOwner(target);
    if (!host || host.id !== event.sender.id) {
      throwIpcError('INVALID_PARAMS', `tab ${tabId} is not hosted by the sender`);
    }

    let image: Electron.NativeImage;
    try {
      image = await target.capturePage();
    } catch (err) {
      logger.warn('RSB browser screenshot capture failed', { tabId, err });
      throwIpcError('INTERNAL', 'capturePage failed');
    }
    // 空图 = 页面还没渲染出内容(刚导航 / guest 未完成首帧)。按失败处理:
    // 写剪贴板路径会静默覆盖用户已有内容却什么都得不到,评论路径会产出全空附件。
    if (image.isEmpty()) {
      throwIpcError('INTERNAL', 'captured image is empty');
    }
    return image;
  };

  // 工具栏截图:capturePage(当前可视区域)→ 系统剪贴板。跨平台无差异
  // (capturePage / clipboard.writeImage 在 macOS / Windows 行为一致)。
  ipcMain.handle(
    RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_CHANNEL,
    async (event, payload: unknown) => {
      const image = await capturePageForSender(event, payload);
      clipboard.writeImage(image);
      return { ok: true };
    },
  );

  // 页面评论截图:capturePage → PNG 字节返回 renderer(不动剪贴板)。renderer
  // 拿字节走会话图片缓存组 composer 附件。Buffer 跨 IPC 到 renderer 是 Uint8Array。
  ipcMain.handle(
    RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_DATA_CHANNEL,
    async (event, payload: unknown) => {
      const image = await capturePageForSender(event, payload);
      return { ok: true, data: image.toPNG() };
    },
  );

  // ── 资源看门狗(前台/后台阶梯处置,策略见 resource-watchdog.ts) ─────────
  const foregroundTracker = new ForegroundTabTracker();
  // senderId → 是否已挂 destroyed 清理。renderer 销毁(窗口关 / 崩溃)时槽位
  // 必须清掉,否则残留的"前台 tab"会永远享受前台豁免。
  const foregroundCleanupAttached = new Set<number>();

  ipcMain.handle(RSB_BROWSER_BRIDGE_SET_FOREGROUND_CHANNEL, (event, payload: unknown) => {
    const obj = requireObject(payload, 'set-foreground payload');
    if (obj.tabId !== null && (typeof obj.tabId !== 'string' || obj.tabId === '')) {
      throwIpcError('INVALID_PARAMS', 'tabId must be a non-empty string or null');
    }
    foregroundTracker.set(event.sender.id, obj.tabId as string | null);
    if (!foregroundCleanupAttached.has(event.sender.id)) {
      foregroundCleanupAttached.add(event.sender.id);
      const senderId = event.sender.id;
      event.sender.once('destroyed', () => {
        foregroundTracker.drop(senderId);
        foregroundCleanupAttached.delete(senderId);
      });
    }
    return { ok: true };
  });

  // 用户主动终止 guest 进程(unresponsive banner / cpu-alert 提示条的按钮)。
  // 归属校验与截图相同:tabId → registry → 该 guest 必须挂在发起请求的 renderer
  // 下,防止拿别的窗口的 webContents 强杀。registry 未命中时(页面在首个
  // dom-ready 前锁死 renderer,还没 report 进来)接受 renderer 自报的
  // webContentsId 兜底 —— 对其执行与 report 相同的三重校验(可解析、是 webview
  // guest、宿主为 sender),不放松信任模型。
  ipcMain.handle(RSB_BROWSER_BRIDGE_FORCE_KILL_CHANNEL, (event, payload: unknown) => {
    const obj = requireObject(payload, 'force-kill payload');
    const tabId = requireString(obj.tabId, 'tabId');
    let target = registry.getWebContentsByTabId(tabId);
    if (!target && obj.webContentsId !== undefined) {
      const webContentsId = requireNonNegativeInt(obj.webContentsId, 'webContentsId');
      const fallback = electronWebContents.fromId(webContentsId);
      if (fallback && !fallback.isDestroyed() && fallback.getType() === 'webview') {
        target = fallback;
      }
    }
    if (!target) {
      throwIpcError('NOT_FOUND', `no live webContents for tab ${tabId}`);
    }
    const host = resolveOwner(target);
    if (!host || host.id !== event.sender.id) {
      throwIpcError('INVALID_PARAMS', `tab ${tabId} is not hosted by the sender`);
    }
    logger.info('RSB browser guest force-killed by user', { tabId });
    try {
      target.forcefullyCrashRenderer();
    } catch (err) {
      // TOCTOU:registry 反查和 kill 之间 guest 可能刚好死掉。裸抛会把原始
      // Electron 错误回给 renderer,统一转 IPC 错误协议。
      logger.warn('forcefullyCrashRenderer threw', { tabId, err });
      throwIpcError('INTERNAL', 'forcefullyCrashRenderer failed');
    }
    return { ok: true };
  });

  // 资源事件必须送到"实际托管该 guest 的 renderer":经 registry 反查 guest 再
  // 取其 hostWebContents;宿主不可用时放弃本轮投递,不回退到别的窗口(见
  // pickResourceEventTarget 注释;review P1:送错 renderer 时 evict 是空操作、
  // cpu-alert 无人消费,还会掩盖问题)。
  const sendResourceEvent = (event: RsbBrowserBridgeResourceEvent) => {
    const guest = registry.getWebContentsByTabId(event.tabId);
    const owner = guest ? resolveOwner(guest) : null;
    const wc = pickResourceEventTarget(owner);
    if (!wc) return;
    wc.send(RSB_BROWSER_BRIDGE_RESOURCE_EVENT_CHANNEL, event);
  };

  const watchdog = new BrowserGuestResourceWatchdog({
    listTabs: () =>
      registry.listAll().map((r) => ({ tabId: r.tabId, webContentsId: r.webContentsId })),
    isPinned: (tabId) => registry.isPinned(tabId),
    // 前台判定带归属校验:声明者必须就是 guest 当前的宿主 renderer,防止别的
    // renderer 冒领前台给目标 tab 骗豁免。guest 反查失败(注册竞态)时退回
    // 无归属版本 —— 此时该 tab 也不在 listTabs 里,不会被误处置。
    isForeground: (tabId) => {
      const guest = registry.getWebContentsByTabId(tabId);
      const owner = guest ? resolveOwner(guest) : null;
      return owner
        ? foregroundTracker.isForegroundFor(tabId, owner.id)
        : foregroundTracker.isForeground(tabId);
    },
    lookupWebContents: (id) =>
      (electronWebContents.fromId(id) as GuestWebContentsLike | undefined) ?? null,
    getMetrics: () => app.getAppMetrics(),
    notifyEvict: (tabId) => sendResourceEvent({ tabId, kind: 'evict-request' }),
    notifyKillNotice: (tabId) => sendResourceEvent({ tabId, kind: 'kill-notice', cause: 'memory' }),
    notifyCpuAlert: (tabId, cpuPercent) =>
      sendResourceEvent({ tabId, kind: 'cpu-alert', cpuPercent }),
    logger,
  });
  watchdog.start();
  activeWatchdog = watchdog;

  // Pin broadcast wiring: when the registry's pin set changes, push a `pin` /
  // `unpin` message to the host renderer so the pool can suppress LRU eviction.
  // The host might be unavailable during early boot or app quit — `getHostWebContents`
  // returns null then, and we silently skip (the registry's pinned set remains
  // authoritative; a renderer that reconnects mid-pin will see the truth via
  // a future "give me pinned list" probe — not implemented in Phase 2 because
  // pin changes only happen while automation is running and the renderer is
  // live by definition).
  const unsubscribe = registry.onPinChange((tabId, pinned) => {
    const wc = getHostWebContents();
    if (!wc || wc.isDestroyed()) return;
    wc.send(pinned ? RSB_BROWSER_BRIDGE_PIN_CHANNEL : RSB_BROWSER_BRIDGE_UNPIN_CHANNEL, {
      tabId,
    });
  });

  logger.info('RSB browser bridge IPC handlers registered');

  return () => {
    unsubscribe();
    watchdog.stop();
    // Note: ipcMain.removeHandler is intentionally NOT called here. Handlers
    // are process-lifetime (registered once during boot); on app quit the
    // process tears down. Tests use `_resetRsbBrowserBridgeIpcForTests` below.
  };
}

/**
 * Test-only reset of the idempotency guard so tests can re-register handlers
 * across multiple `describe` blocks. Never call from production code.
 */
export function _resetRsbBrowserBridgeIpcForTests(): void {
  registered = false;
  activeWatchdog?.stop();
  activeWatchdog = null;
}
