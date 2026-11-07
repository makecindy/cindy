/**
 * RSB browser bridge — renderer-side helper.
 *
 * Couples three concerns into one module:
 *  1. Report `(sessionId, tabId, webContentsId)` to main once a webview has
 *     attached (callable from `useBrowserWebview` after `dom-ready`).
 *  2. Release on pool eviction / explicit tab close (subscribed to the pool's
 *     release listener so we never leak stale rows in main).
 *  3. Apply pin / unpin commands pushed from main into the pool's automation
 *     pin set, so LRU eviction respects automation.
 *
 * Phase 2 keeps this module **stateless externally** — there's no React hook
 * yet because nothing in the UI consumes pin state. The pool + main registry
 * are the source of truth; the bridge is glue.
 *
 * Initialization is idempotent: `initRsbBrowserBridge()` can be called from
 * multiple places (RSB shell mount, HMR, defensive re-init) without
 * double-binding listeners.
 */

import type {
  RsbBrowserBridgePinPayload,
  RsbBrowserBridgeResourceEvent,
  RsbBrowserBridgeTabOpRequest,
  RsbBrowserBridgeTabOpResult,
} from '../../../../shared/rsbBrowserBridge';

import { createLogger } from '@/lib/logger';

import { browserWebviewPool } from './browserWebviewPool';
import {
  addTab,
  closeTab as storeCloseTab,
  setActiveTab,
  getBucket,
  ensureHydrated,
  findSessionIdByTabId,
} from '../store';
import { requestRightSidebarVisibility } from './sidebarCommands';
import { isPopupSpawnedTab } from './popupTabs';
import { findNativePopupSurfaceForTab } from './nativePopupTabs';

const log = createLogger('rightSidebar.rsbBrowserBridge');

/** guest 自关收尾对 closeTab 瞬态失败的重试延迟表(close 事件不重发,不重试
 *  即静默丢关闭意图)。 */
const GUEST_CLOSE_RETRY_DELAYS_MS = [50, 150, 400] as const;

/** Subset of `window.electronAPI.rsbBrowserBridge` actually used here. */
interface RsbBrowserBridgeIpcSubset {
  report(input: { sessionId: string; tabId: string; webContentsId: number }): Promise<unknown>;
  release(input: { tabId: string; webContentsId?: number }): Promise<unknown>;
  snapshot(input: { liveTabIds: string[] }): Promise<{
    ok: true;
    dropped: string[];
    kept: number;
    pinnedTabIds: string[];
  }>;
  onPin(cb: (payload: RsbBrowserBridgePinPayload) => void): () => void;
  onUnpin(cb: (payload: RsbBrowserBridgePinPayload) => void): () => void;
  /** main → renderer "do this tab op" command (Phase 3 backend `open` / `focus` / `close`). */
  onTabOpRequest(cb: (req: RsbBrowserBridgeTabOpRequest) => void): () => void;
  /** renderer → main result of a tab-op-request, keyed by reqId. */
  tabOpResult(result: RsbBrowserBridgeTabOpResult): Promise<unknown>;
  /** 资源看门狗:上报本 renderer 当前展示的浏览器 tab(null = 无)。 */
  setForeground(input: { tabId: string | null }): Promise<unknown>;
  /** 用户主动强杀 guest 进程(webContentsId = registry 未命中时的兜底解析)。 */
  forceKill(input: { tabId: string; webContentsId?: number }): Promise<unknown>;
  /** main → renderer 资源看门狗事件。 */
  onResourceEvent(cb: (event: RsbBrowserBridgeResourceEvent) => void): () => void;
}

function ipc(): RsbBrowserBridgeIpcSubset | undefined {
  return typeof window !== 'undefined'
    ? (window.electronAPI?.rsbBrowserBridge as RsbBrowserBridgeIpcSubset | undefined)
    : undefined;
}

let initialized = false;
let teardown: (() => void) | null = null;

/**
 * 本 renderer 最后一次为各 tab report 的 webContentsId。release 时随包携带,
 * main 端用它识别 stale release:宿主迁移(内嵌 ↔ 独立子窗口)时旧 renderer 的
 * releaseAll 可能晚于新 renderer 对同 tabId 的 report 到达,若无此防护会把
 * 新窗口刚注册的记录误删(直到 remount 前 tab 都失联)。
 */
const lastReportedWebContentsId = new Map<string, number>();

/**
 * 资源看门狗 kill-notice 的 pending 原因(tabId → cause + 记录时间)。main 先发
 * notice 再 forcefullyCrashRenderer,但两条消息走不同 channel,到达顺序无硬保证:
 *  - notice 先到:useBrowserWebview 的 render-process-gone handler 用
 *    `consumePendingKillCause` 取走,banner 直接显示资源原因;
 *  - crash 事件先到:per-tab 订阅回调随后升级已有 crash state。
 * 带新鲜度窗口:kill 在 main 侧失败 / guest 已死时 crash 事件永远不来,残留的
 * cause 不能在很久之后错标一次无关崩溃 —— 超窗直接作废。
 */
const pendingKillCauses = new Map<string, { cause: 'memory'; at: number }>();

/** pending kill cause 的有效窗口(ms)。notice → crash 事件正常在毫秒级到达,
 *  10s 足够覆盖慢 IPC,又不至于跨到下一次无关崩溃。 */
export const PENDING_KILL_CAUSE_TTL_MS = 10_000;

/** per-tab 资源事件订阅(useBrowserWebview 挂/卸)。 */
const resourceEventListeners = new Map<
  string,
  Set<(event: RsbBrowserBridgeResourceEvent) => void>
>();

/**
 * 订阅某个 tab 的资源看门狗事件(kill-notice / cpu-alert;evict-request 在
 * bridge 内部直接消化,不会到订阅者)。返回退订函数。
 */
export function subscribeTabResourceEvent(
  tabId: string,
  cb: (event: RsbBrowserBridgeResourceEvent) => void,
): () => void {
  let set = resourceEventListeners.get(tabId);
  if (!set) {
    set = new Set();
    resourceEventListeners.set(tabId, set);
  }
  set.add(cb);
  return () => {
    const listeners = resourceEventListeners.get(tabId);
    if (!listeners) return;
    listeners.delete(cb);
    if (listeners.size === 0) resourceEventListeners.delete(tabId);
  };
}

/** 取走(并清除)该 tab 的 pending kill 原因;无或已超新鲜度窗口则 null。 */
export function consumePendingKillCause(tabId: string): 'memory' | null {
  const entry = pendingKillCauses.get(tabId) ?? null;
  pendingKillCauses.delete(tabId);
  if (!entry) return null;
  return Date.now() - entry.at <= PENDING_KILL_CAUSE_TTL_MS ? entry.cause : null;
}

/**
 * 上报"本 renderer 当前展示的浏览器 tab"给 main 的资源看门狗。
 * BrowserTabBody 在 active 变化时调;模块内维护单一 claimant,避免两个 TabBody
 * 的 mount / unmount 交错时后发的 null 把先发的前台声明冲掉。
 */
let currentForegroundTabId: string | null = null;

export function setForegroundBrowserTab(tabId: string, active: boolean): void {
  const api = ipc();
  if (active) {
    currentForegroundTabId = tabId;
    if (api) void api.setForeground({ tabId }).catch(() => undefined);
  } else if (currentForegroundTabId === tabId) {
    currentForegroundTabId = null;
    if (api) void api.setForeground({ tabId: null }).catch(() => undefined);
  }
}

/** 用户主动强杀 guest 进程(unresponsive banner / cpu 提示条的「强制终止」)。
 *  随包携带 webview 的现值 webContentsId:页面在首个 dom-ready 前锁死 renderer
 *  时 tab 还没 report 进 main 的 registry,main 用它做兜底解析(归属校验不变)。 */
export function forceKillBrowserTab(tabId: string): Promise<void> {
  const api = ipc();
  if (!api) return Promise.resolve();
  let webContentsId: number | undefined;
  try {
    webContentsId = browserWebviewPool.peek(tabId)?.webview.getWebContentsId();
  } catch {
    // attach 尚未完成时 getWebContentsId 抛 —— 不带兜底 id,交给 main 判 NOT_FOUND。
  }
  return api
    .forceKill(webContentsId === undefined ? { tabId } : { tabId, webContentsId })
    .then(
      () => undefined,
      () => undefined,
    );
}

/**
 * guest 自关的 per-session 串行队列。
 *
 * "两次关闭的 store 变更不许交错"由 `store.closeTab` 自己的 per-session 队列保证
 * (它覆盖所有关闭入口,包括用户手关)。这里这一层管的是**自关的整套收尾**:
 * 存在性重取 → closeTab → pool.release → "最后一个 tab 才收侧栏" 判定。这些
 * 步骤在 closeTab 之外,store 的队列管不到 —— 同 session 两个 popup 同时自关时
 * 不排队,两套收尾会读到彼此中途的 bucket。
 *
 * 同 session 排队,跨 session 并行。
 */
const guestCloseQueues = new Map<string, Promise<void>>();

function enqueueGuestClose(sessionId: string, task: () => Promise<void>): Promise<void> {
  const prev = guestCloseQueues.get(sessionId) ?? Promise.resolve();
  const next = prev.then(task).catch(() => undefined);
  guestCloseQueues.set(sessionId, next);
  // 队尾自清 —— 不把已完成的 promise(及其闭包)长期挂在 map 上。
  void next.then(() => {
    if (guestCloseQueues.get(sessionId) === next) guestCloseQueues.delete(sessionId);
  });
  return next;
}

/**
 * Bind the renderer ↔ main bridge. Returns a teardown function that's safe to
 * call multiple times.
 *
 * Calling `initRsbBrowserBridge()` more than once is a no-op (returns the same
 * teardown) until that teardown runs. HMR teardown clears module ownership so
 * the next evaluation can bind a fresh subscription set.
 */
export function initRsbBrowserBridge(): () => void {
  if (initialized) {
    return teardown ?? (() => undefined);
  }
  const api = ipc();
  if (!api) {
    // SSR / test / preload-not-ready — silently no-op.
    initialized = true;
    teardown = () => undefined;
    return teardown;
  }
  initialized = true;

  // Pool release → main release. Catches:
  //  - explicit pool.release (user closes tab)
  //  - LRU eviction (capacity overflow)
  // Both must clean main-side registry; the pool can't tell them apart and
  // doesn't need to — main just needs "this tabId is gone".
  const unsubRelease = browserWebviewPool.onRelease((tabId) => {
    const reported = lastReportedWebContentsId.get(tabId);
    lastReportedWebContentsId.delete(tabId);
    // 注意:这里**不能**清 popup 标记 —— pool release ≠ tab 关闭。LRU 淘汰 /
    // 宿主迁移只销毁 webview 实例,tab 仍在 store;重新激活后 OAuth callback 的
    // window.close() 仍要能命中标记自关。标记随 tab 关闭清理(见 guestClose)。
    void api
      .release(reported === undefined ? { tabId } : { tabId, webContentsId: reported })
      .catch(() => undefined);
  });

  // guest `window.close()` → 自动关对应 tab。只放行 popup 催生的 tab(与真实
  // 浏览器 "script-opened 才能 script-close" 语义对齐,防任意网页关掉用户 tab)。
  // OAuth callback 页授权完成后的标准收尾就是 window.close() —— 不接这个事件,
  // 每次授权都残留一个空 tab。关到最后一个 tab 时联动收起侧栏,与 main 端
  // close tab-op 的可见性策略一致。
  const unsubGuestClose = browserWebviewPool.onGuestClose((tabId) => {
    if (!isPopupSpawnedTab(tabId)) return;
    const sessionId = findSessionIdByTabId(tabId);
    if (!sessionId) return;
    void enqueueGuestClose(sessionId, async () => {
      // closeTab 的瞬态失败(DB overload / worker 短暂不可用)必须重试:guest 的
      // close 事件不会重发,静默丢弃等于让"残留空 tab"被瞬态失败原样复活。
      // 有限重试后仍失败 → log.error 留痕收手(fail-safe 方向是少关一个 tab,
      // 用户手关兜底;popup 标记未清,理论上后续还有自关机会)。
      for (let attempt = 0; ; attempt += 1) {
        // 每轮重取存在性:排在前面的自关 / 用户手关 / 上一轮部分成功都可能已把
        // 这个 tab 关掉。
        if (!getBucket(sessionId).tabs.some((t) => t.id === tabId)) return;
        const beforeCount = getBucket(sessionId).tabs.length;
        try {
          await storeCloseTab(sessionId, tabId);
        } catch (err) {
          if (attempt < GUEST_CLOSE_RETRY_DELAYS_MS.length) {
            await new Promise((resolve) =>
              setTimeout(resolve, GUEST_CLOSE_RETRY_DELAYS_MS[attempt]),
            );
            continue;
          }
          log.error('guest-close: closeTab failed after retries; tab left in place', {
            sessionId,
            tabId,
            err,
          });
          return;
        }
        // closeTab 可能被 close interceptor 拦下(tab 留在 bucket)——此时不动资源,
        // 保持"没关成"的完整语义(popup 标记同理:store 只在真正关成时才清)。
        const stillPresent = getBucket(sessionId).tabs.some((t) => t.id === tabId);
        if (stillPresent) return;
        // 后台自关(BrowserTabBody 未挂载)没有 unmount cleanup 兜底,必须显式
        // release:销毁 guest webContents、经 onRelease 链同步 main 端 TabRegistry。
        // 前台场景 TabBody 的关闭路径先 release 过也没关系 —— release 幂等。
        browserWebviewPool.release(tabId);
        // detach/reattach 竞态防护:closeTab await 期间 invalidateSessionCaches()
        // 可能把 bucket 清为 EMPTY_BUCKET(hydrated=false, tabs=[])——此时
        // afterCount===0 不代表会话真的没有 tab 了,不应折叠侧边栏。
        const afterBucket = getBucket(sessionId);
        if (beforeCount > 0 && afterBucket.hydrated && afterBucket.tabs.length === 0) {
          requestRightSidebarVisibility('close', { sessionId });
        }
        return;
      }
    });
  });

  // Main → pool pin sync. Main owns the pin authority; renderer pool only
  // mirrors the set so LRU eviction respects automation. We use the pool's
  // pinForAutomation as the local mirror.
  const unsubPin = api.onPin((payload) => {
    browserWebviewPool.pinForAutomation(payload.tabId);
  });
  const unsubUnpin = api.onUnpin((payload) => {
    browserWebviewPool.unpinForAutomation(payload.tabId);
  });

  // Phase 3 tab-op bridge: main asks renderer to mutate the RSB store on its
  // behalf (open / focus / close). Renderer executes against the live store
  // and answers via `tabOpResult` keyed by `reqId`. Failures (unknown session,
  // store rejection, missing tabId) come back as `{ok:false, error}`.
  const unsubTabOp = api.onTabOpRequest((req) => {
    void handleTabOpRequest(req, api);
  });

  // 资源看门狗事件(main → renderer):
  //  - evict-request:后台 guest 资源超限,直接走 pool.release 淘汰(对用户
  //    等价于 LRU 淘汰;release → onRelease → main registry 同步清理)。
  //  - kill-notice:main 即将强杀该 guest。记 pending cause + 转发给 per-tab
  //    订阅者(useBrowserWebview),两条路径覆盖 notice / render-process-gone
  //    两种到达顺序,banner 都能显示"内存过高被终止"。
  //  - cpu-alert:转发给 per-tab 订阅者显示非阻断提示条。
  const unsubResource = api.onResourceEvent((event) => {
    if (event.kind === 'evict-request') {
      browserWebviewPool.release(event.tabId);
      return;
    }
    if (event.kind === 'kill-notice') {
      pendingKillCauses.set(event.tabId, { cause: event.cause, at: Date.now() });
    }
    const listeners = resourceEventListeners.get(event.tabId);
    if (listeners) {
      for (const cb of [...listeners]) {
        try {
          cb(event);
        } catch {
          // listener throw must not break event fan-out
        }
      }
    }
  });

  const dispose = () => {
    // A disposer retained by an old HMR generation must not tear down the
    // subscriptions installed by a newer generation.
    if (teardown !== dispose) return;
    unsubRelease();
    unsubGuestClose();
    unsubPin();
    unsubUnpin();
    unsubTabOp();
    unsubResource();
    initialized = false;
    teardown = null;
  };
  teardown = dispose;

  // Initial snapshot — drop main-side rows that the renderer no longer
  // tracks (typically HMR / crash residue) and re-mirror the main-side pin
  // set into the pool. Fires on every `initRsbBrowserBridge()` call, but the
  // guard above makes that "once per renderer lifetime"; the recovery path
  // is well-bounded.
  void snapshotRsbBrowserTabs(browserWebviewPool.inspectTabIds());

  return teardown;
}

/**
 * Push a fresh `(sessionId, tabId, webContentsId)` triple to main. Call AFTER
 * `<webview>.dom-ready` — `getWebContentsId()` is only valid post-attach.
 * Errors are logged and swallowed: the renderer can keep functioning if main
 * is temporarily unavailable; the next mount or snapshot reconciliation will
 * catch up.
 */
export function reportRsbBrowserTab(input: {
  sessionId: string;
  tabId: string;
  webContentsId: number;
}): Promise<void> {
  const api = ipc();
  if (!api) return Promise.resolve();
  lastReportedWebContentsId.set(input.tabId, input.webContentsId);
  return api.report(input).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Explicit release. Pool's `onRelease` already covers the natural eviction
 * paths; call this in narrow cases where the renderer wants to clear a row
 * without removing the webview (currently no such case — exported for symmetry).
 */
export function releaseRsbBrowserTab(tabId: string): Promise<void> {
  const api = ipc();
  if (!api) return Promise.resolve();
  const reported = lastReportedWebContentsId.get(tabId);
  lastReportedWebContentsId.delete(tabId);
  return api
    .release(reported === undefined ? { tabId } : { tabId, webContentsId: reported })
    .then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Hand main the renderer's currently-live tabIds so it can drop stale rows.
 * Drop-only — upserts flow through `report`. Use at RSB shell mount-time /
 * after HMR / after renderer crash recovery.
 *
 * The response carries main's authoritative `pinnedTabIds`; the helper mirrors
 * those into the renderer pool so LRU eviction respects automation even after
 * a renderer reload (P1-3 in Phase 2 review).
 */
export function snapshotRsbBrowserTabs(liveTabIds: string[]): Promise<void> {
  const api = ipc();
  if (!api) return Promise.resolve();
  return api.snapshot({ liveTabIds }).then(
    (res) => {
      if (!res || !Array.isArray(res.pinnedTabIds)) return;
      // Re-mirror main → pool. We only ADD pins from main (main is authority);
      // we don't remove any pins the renderer's pool has but main doesn't,
      // because that would race a freshly-arrived pin command — keeping a stale
      // pin is harmless (LRU just spares that tab) while removing a live one
      // breaks automation. Stale pins age out the next time the pool releases
      // that tab (release auto-unpins).
      for (const tabId of res.pinnedTabIds) {
        browserWebviewPool.pinForAutomation(tabId);
      }
    },
    () => undefined,
  );
}

/**
 * Execute a main-side tab-op against the renderer store and acknowledge.
 * Errors are normalized — caller in `main` decides how to map them to MCP
 * action error codes.
 */
async function handleTabOpRequest(
  req: RsbBrowserBridgeTabOpRequest,
  api: RsbBrowserBridgeIpcSubset,
): Promise<void> {
  const reqId = req.reqId;
  let result: RsbBrowserBridgeTabOpResult;
  try {
    if (req.op === 'probe') {
      // Reaching this listener proves preload fan-out and the live RSB
      // renderer bridge are both available. Keep the probe side-effect free:
      // it must not hydrate a session, materialize a webview or change focus.
      result = { reqId, ok: true };
      await api.tabOpResult(result);
      return;
    }
    // 先把该 session 的 bucket 水合到位(幂等,已水合时同步返回)。三个 op 都需要:
    //  - focus / close 同步读 getBucket —— 新 renderer(侧边栏子窗口刚 READY)或
    //    会话跟随切换后 bucket 可能还是空的,不水合会把存在的 tab 误报 "not found";
    //  - open 走 addTab —— store 契约要求先 hydrated 再写,否则空 bucket 上的写
    //    会以 hydrated:true 为 merge base,把 DB 里既有 tab 永久挡在本 renderer 外。
    await ensureHydrated(req.sessionId);
    if (req.op === 'open') {
      // The initial state mirrors the popup-spawned tab path in
      // RightSidebarShell — keep the shape consistent so plugins don't see
      // surprise nulls.
      const initialState = {
        url: req.url ?? 'about:blank',
        title: '',
        favicon: null,
        isAudible: false,
      };
      const newTab = await addTab(req.sessionId, 'web-browser', initialState);

      // ── Eager webview spawn ─────────────────────────────────────────────
      // A newly added background tab may not have a BrowserTabBody yet.
      // Without eager materialization, cross-session automation can reach
      // backend.navigate / evaluate before main has a webContentsId.
      //
      // Fix: synchronously acquire the pool entry NOW. That creates the
      // <webview> DOM node inside the off-screen parking container (already
      // attached to document.body — see browserWebviewPool.ensureContainer),
      // which is enough for Electron to create the guest webContents.
      // Wait for attachment and registration before acknowledging.
      //
      // When the user later switches into this session, BrowserTabBody
      // mounts and useBrowserWebview may reuse the same pool DOM entry.
      // Moving its wrapper from parking into the slot can recreate the
      // guest and lose page state; the hook observes attach / dom-ready
      // and reports the current id. Retaining already-mounted hosts avoids
      // reparenting on task switches; it does not cover this first mount
      // of an eager-spawned background tab or promise its guest survives.
      try {
        await eagerSpawnAndReport(req.sessionId, newTab.id, initialState.url);
      } catch (error) {
        // Roll back only this request's tab. closeTab serializes persistence
        // and releases its pool entry. Never rehydrate a previous host.
        if (!getBucket(req.sessionId).hydrated) {
          throw new Error(`browser tab ${newTab.id} moved to another host; retry using this tabId`);
        }
        try {
          await storeCloseTab(req.sessionId, newTab.id, { skipBeforeClose: true });
        } catch {
          throw new Error(`browser tab ${newTab.id} registration failed and cleanup failed; retry using this tabId`);
        }
        throw error;
      }
      // Visibility command runs AFTER the eager-spawn so that by the time
      // MainLayout reads the new collapsed-state archive, the initial
      // guest registration has completed.
      // userInitiated:false —— agent 自动化开的标签,不是用户点的:侧边栏该展开
      // 就展开,但 detached 子窗口不得抢走用户当前前台应用的焦点。
      requestRightSidebarVisibility('open', { sessionId: req.sessionId, userInitiated: false });
      result = { reqId, ok: true, tabId: newTab.id };
    } else if (req.op === 'focus') {
      // store.setActiveTab no-ops if the id is already active (returns void on
      // both paths). Validate existence so MCP gets a clear error rather than
      // a silent success on an unknown tabId.
      const bucket = getBucket(req.sessionId);
      if (!bucket.tabs.some((t) => t.id === req.tabId)) {
        result = { reqId, ok: false, error: `tab ${req.tabId} not found` };
      } else {
        await setActiveTab(req.sessionId, req.tabId);
        // Same rationale as open: focus implies the user should see the tab —
        // but it's still the agent acting, so no OS-level focus steal.
        requestRightSidebarVisibility('open', { sessionId: req.sessionId, userInitiated: false });
        result = { reqId, ok: true, tabId: req.tabId };
      }
    } else if (req.op === 'ensure') {
      // 直连动作(navigate / screenshot / pdf / console / act)的 detached 恢复
      // 路径:把一个已存在的 web-browser tab 的 webview 在本 renderer 重新物化
      // 并 report 回 main 的 TabRegistry。与 focus 的区别:零用户可见副作用 ——
      // 不改 activeTab、不发 visibility 请求(agent 只是要继续操作这个 tab,
      // 不代表用户想看它)。bucket 已在入口水合;tab 不存在 / 非浏览器 tab
      // 直接 ok:false,让 backend 快速回落原有的清晰报错。
      const bucket = getBucket(req.sessionId);
      // tabId 缺省 = targetless 直连动作的兜底:选 activeTabId 指向的浏览器
      // tab,否则最后一个浏览器 tab(registry 已随窗口清空,只有 bucket 知道)。
      const tab = req.tabId
        ? bucket.tabs.find((t) => t.id === req.tabId)
        : pickDefaultBrowserTab(bucket);
      if (!tab || tab.kind !== 'web-browser' || hasNativePopupSurface(tab)) {
        result = {
          reqId,
          ok: false,
          error: `tab ${req.tabId ?? '(session default)'} not found`,
        };
      } else {
        const url =
          (tab.state as { url?: string } | null | undefined)?.url ?? 'about:blank';
        await eagerSpawnAndReport(req.sessionId, tab.id, url);
        result = { reqId, ok: true, tabId: tab.id };
      }
    } else {
      // close — exhaustive on the union; TS narrows `req` to the 'close' arm.
      //
      // Visibility policy (purely code-driven, no model reasoning):
      //   - Closing a tab that was NOT the last one → sidebar stays as-is.
      //     The other tabs are still useful; user may want to keep them
      //     visible.
      //   - Closing the LAST web-browser-class tab in this session → request
      //     `'close'`. The "agent finished its browsing task, no live tab
      //     left" symmetry: visibility came up on first open, goes down when
      //     the last one is gone. MainLayout still no-ops if already closed.
      //
      // We count BEFORE the close call to know what was there, then check
      // what's left after. Bucket reads are synchronous off the store cache.
      const beforeCount = getBucket(req.sessionId).tabs.length;
      await storeCloseTab(req.sessionId, req.tabId);
      // detach/reattach 竞态防护:同 guest-close 路径,需确认 bucket 仍由本 renderer 持有。
      const afterBucket = getBucket(req.sessionId);
      if (beforeCount > 0 && afterBucket.hydrated && afterBucket.tabs.length === 0) {
        requestRightSidebarVisibility('close', { sessionId: req.sessionId });
      }
      result = { reqId, ok: true, tabId: req.tabId };
    }
  } catch (err) {
    result = {
      reqId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  // Best-effort ack — main may have timed out, that's fine.
  await api.tabOpResult(result).catch(() => undefined);
}

/** targetless ensure 的选目标:active 的浏览器 tab 优先,否则最后一个浏览器 tab。 */
function pickDefaultBrowserTab(
  bucket: ReturnType<typeof getBucket>,
): ReturnType<typeof getBucket>['tabs'][number] | undefined {
  const active = bucket.tabs.find((t) => t.id === bucket.activeTabId);
  if (active?.kind === 'web-browser') return active;
  for (let i = bucket.tabs.length - 1; i >= 0; i -= 1) {
    if (bucket.tabs[i].kind === 'web-browser') return bucket.tabs[i];
  }
  return undefined;
}

/** Native surfaces own their exact WebContents; never replay auth URLs in a second guest. */
function hasNativePopupSurface(tab: ReturnType<typeof getBucket>['tabs'][number]): boolean {
  return Boolean(
    findNativePopupSurfaceForTab(tab.id)?.surfaceId
    ?? (tab.state as { nativePopupSurfaceId?: string } | null)?.nativePopupSurfaceId,
  );
}

/**
 * open / ensure 共用的 webview 物化:acquire pool entry → setAttribute('src')
 * → 等 did-attach(或 dom-ready 兜底) → 等 report IPC 完成后应答。
 *
 * store 中新建的后台 tab 不一定已有 BrowserTabBody，先在停车区物化并等待
 * 注册，避免自动化动作直接遇到 "tab not found"；超过截止时间则失败。
 * 随后首次附着到 body slot 仍可能重建 guest，不能把 DOM 复用当作页面状态
 * 保留；该路径未由常驻宿主策略覆盖。
 *
 * 已 attach 过的 entry(getWebContentsId 可取)走幂等 re-report 快路径,
 * 不再动 src(避免把用户正在看的页面重新导航)。
 */
export async function eagerSpawnAndReport(
  sessionId: string,
  tabId: string,
  url: string,
): Promise<void> {
  const entry = browserWebviewPool.acquire(tabId);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let reporting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      entry.webview.removeEventListener('did-attach', onAttached);
      entry.webview.removeEventListener('dom-ready', onAttached);
      if (error) reject(error);
      else resolve();
    };
    // Registration, not network-bound dom-ready, makes a guest controllable.
    // Both events can fire; await one report and finish before the 5s main
    // bridge timeout. A missing attach is a real failure, never a success ack.
    const onAttached = () => {
      if (reporting || settled) return;
      let webContentsId: number;
      try {
        webContentsId = entry.webview.getWebContentsId();
      } catch {
        return; // dom-ready can retry if did-attach ran too early.
      }
      reporting = true;
      const api = ipc();
      if (!api) {
        finish(new Error('browser bridge unavailable'));
        return;
      }
      // Unlike ordinary UI reports, an automation acknowledgement must not
      // silently swallow a failed registration. Track the id for stale-safe release.
      lastReportedWebContentsId.set(tabId, webContentsId);
      void api.report({ sessionId, tabId, webContentsId }).then(
        () => finish(),
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
      );
    };
    entry.webview.addEventListener('did-attach', onAttached);
    entry.webview.addEventListener('dom-ready', onAttached);
    timer = setTimeout(() => finish(new Error('browser guest registration timed out')), 4000);
    // An attached guest only needs re-registration; keep its current URL.
    onAttached();
    if (reporting || settled) return;
    try {
      entry.webview.setAttribute('src', url);
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Test-only reset. */
export function _resetRsbBrowserBridgeForTests(): void {
  if (teardown) teardown();
  initialized = false;
  teardown = null;
  lastReportedWebContentsId.clear();
  pendingKillCauses.clear();
  resourceEventListeners.clear();
  guestCloseQueues.clear();
  currentForegroundTabId = null;
}
