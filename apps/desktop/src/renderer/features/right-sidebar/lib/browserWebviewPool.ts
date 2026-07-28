/**
 * BrowserWebviewPool —— RSB web-browser plugin 的 webview 实例池(LRU, K=5)。
 *
 * 为什么要 pool:每个 web-browser tab 在 DOM 上有自己的 body slot,但 `<webview>`
 * 一旦被 React unmount(切到别的 tab / 切 RSB 整体卸载/重挂),guest webContents
 * 会被 detach + 销毁,下次切回来要重新加载,Cookie / form state / 浏览历史全丢。
 * 业界做法:把 webview DOM 节点保活在脱离当前 tab 子树的"停车区" container 里,
 * 切 tab 时用 vanilla `appendChild` 把同一个 DOM 节点搬到目标 slot —— 浏览器 DOM
 * 移动不会 detach iframe / webview 内部的 webContents,实现"切 tab 不重载"。
 *
 * **关键:不要用 React Portal**。Portal 内部跨 reconcile 的搬动会触发 React 把
 * 节点 remove + insert,这中间一帧会让 webview detach 丢 webContents。所以
 * 整个 pool 走 vanilla DOM,React 只在 effect 里调 `pool.acquire / appendTo`。
 *
 * LRU(K=5):超过 5 个浏览器 tab 时,淘汰最久未访问的 webview(销毁其
 * webContents)。用户开第 6 个 tab 时,最早访问那个被淘汰;淘汰只销毁后台
 * webview 实例,**不删 tab**(tab 仍在 RSB tabbar,只是下次激活时会重新创建
 * webview + 重新加载)。
 *
 * 生命周期:
 *   - acquire(tabId):取/创建 entry,LRU 标 touch,超 K 淘汰最旧
 *   - getWrapper(tabId):返回 wrapper DOM(caller appendChild 到自己 slot)
 *   - touch(tabId):tab 被激活时显式触发 LRU 时间戳更新
 *   - release(tabId):tab 关闭时显式销毁
 *
 * dev / HMR 注意:模块重载会丢失模块级单例,旧 webview 实例可能游离 —— Phase 4
 * 范围内不处理(全量 reload 时 document.body 会被换,旧节点跟着被 GC)。线上
 * 不会触发。
 */

import type { WebviewTag } from 'electron';

import { BROWSER_PARTITION } from './browserPartition';

export type BrowserWebviewGuestFailure =
  | { kind: 'render-process-gone'; reason: string }
  | { kind: 'unresponsive'; reason: 'unresponsive' };

interface PoolEntry {
  tabId: string;
  /** webview 的外层 wrapper 容器,LRU 在它身上(caller 把它 appendChild 到自己
   *  slot;切走时 caller 应把它 appendChild 回 pool container)。 */
  wrapper: HTMLDivElement;
  /** 真 `<webview>` 元素,挂在 wrapper 内部。 */
  webview: WebviewTag;
  /** 单调递增计数,LRU 用 —— 越大越新,淘汰挑最小那个。比 Date.now() 不依赖
   *  系统时钟,且能区分同帧多次访问。 */
  lastAccess: number;
  /** Pool 创建 webview 后立即记录 guest 故障，避免 React hook 尚未绑定时丢事件。 */
  guestFailure: BrowserWebviewGuestFailure | null;
}

const POOL_CAPACITY = 5;
const POOL_CONTAINER_ID = 'browser-webview-pool';

class BrowserWebviewPoolImpl {
  private entries = new Map<string, PoolEntry>();
  private accessCounter = 0;
  private container: HTMLDivElement | null = null;
  /**
   * Automation pin set — tabIds the main-process bridge has marked
   * "busy executing automation steps". LRU eviction MUST skip these so the
   * automation backend (Phase 3) doesn't get a destroyed webContents mid-call.
   *
   * The pin is purely advisory at this layer: it never prevents a user from
   * closing the tab (explicit `release(tabId)` still works); it only changes
   * who the LRU picks when capacity is reached. If every tab in the pool is
   * pinned, evictLRU falls back to evicting the oldest one anyway (capacity
   * trumps pin) — automation will fail with a clear error rather than the
   * pool growing unbounded.
   */
  private pinned = new Set<string>();

  /**
   * pool 的"停车区" off-screen 容器 —— 没挂到任何 tab body slot 的 wrapper
   * 暂存在这里。位置 `left:-9999px;top:0;` 让浏览器知道节点 still attached(
   * webview 才会保活),但用户看不见。
   *
   * lazy 创建:首次 acquire 时才挂到 document.body。
   */
  private ensureContainer(): HTMLDivElement {
    if (this.container) return this.container;
    const existing = document.getElementById(POOL_CONTAINER_ID);
    if (existing instanceof HTMLDivElement) {
      this.container = existing;
      return existing;
    }
    const div = document.createElement('div');
    div.id = POOL_CONTAINER_ID;
    // off-screen but attached:webview webContents 只有 host wrapper attached 到
    // document 的 render tree 才不被销毁。`position: fixed; left: -9999px` 是
    // 标准的 off-screen 技巧,visibility: hidden 会触发部分 webview 实现把
    // webContents 暂停 paint,不用。
    div.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none;';
    document.body.appendChild(div);
    this.container = div;
    return div;
  }

  /**
   * 取或创建 pool entry。
   * - 命中 → touch LRU,返回现有
   * - 未命中 → 创建新 wrapper + webview,触发可能的 LRU 淘汰
   */
  acquire(tabId: string): PoolEntry {
    const existing = this.entries.get(tabId);
    if (existing) {
      existing.lastAccess = ++this.accessCounter;
      return existing;
    }
    // 容量满 → 淘汰最旧(选剔除规则:tabId !== 当前请求的)
    if (this.entries.size >= POOL_CAPACITY) {
      this.evictLRU();
    }
    const container = this.ensureContainer();
    const wrapper = document.createElement('div');
    wrapper.dataset.poolTabId = tabId;
    // wrapper 自身负责把 webview 填满它 —— caller slot 给 wrapper 多大宽高,
    // webview 跟着拉伸。display:flex 让 webview 100% 填充。
    // background 用主题 surface token(规则 16:走 token,不写 hex pair):
    // Win 下 webview 首次 attach 前会显示一帧灰白(规则 15 实测),给 wrapper
    // 设 surface 色让过渡帧贴近主题(light → 浅,dark → 深),guest 加载后由
    // 网页内容覆盖。Mac 实测也会有半帧灰过渡,顺手统一处理。
    wrapper.style.cssText =
      'position:relative;width:100%;height:100%;display:flex;background-color:var(--surface);';
    const webview = document.createElement('webview') as WebviewTag;
    // 强制 partition —— main 端 hardener 也会兜底,但这里显式写,debug 时更明显。
    webview.setAttribute('partition', BROWSER_PARTITION);
    // 让 window.open / target=_blank 进入 guestContents.setWindowOpenHandler。
    // main 端仍会 deny 原生弹窗并转成 RSB 新 tab;这里不是放开外弹窗。
    webview.setAttribute('allowpopups', 'true');
    // webview 元素自身透明 —— 灰底兜底交给 wrapper 处理(见上方注释)。
    webview.setAttribute('style', 'flex:1;width:100%;height:100%;');
    wrapper.appendChild(webview);

    const entry: PoolEntry = {
      tabId,
      wrapper,
      webview,
      lastAccess: ++this.accessCounter,
      guestFailure: null,
    };
    this.observeGuestLifecycle(entry);
    container.appendChild(wrapper);
    this.entries.set(tabId, entry);
    this.fireEntryCreated(tabId);
    return entry;
  }

  /** 仅取已存在的 entry(用于切 tab 时 touch 而不创建);不存在返回 null。 */
  peek(tabId: string): PoolEntry | null {
    return this.entries.get(tabId) ?? null;
  }

  /** 显式 touch LRU 时间戳(tab 激活时调,避免后台 tab 比前台还新)。 */
  touch(tabId: string): void {
    const e = this.entries.get(tabId);
    if (e) e.lastAccess = ++this.accessCounter;
  }

  /**
   * 显式释放 tabId 对应的 entry:从 DOM 移除 wrapper + 从 entries map 删除。
   * webview DOM 节点被 remove 后,guest webContents 自动 destroy(Electron 行为)。
   * 用户关闭 web-browser tab 时调。
   *
   * 释放也清掉 automation pin —— pin 跟 entry 生命周期绑定,tab 都不存在了 pin
   * 没意义。pinChangeListeners 通知 caller(主要是 rsbBrowserBridge renderer 端
   * helper)同步上报 main 端释放。
   */
  release(tabId: string): void {
    const e = this.entries.get(tabId);
    if (!e) return;
    e.wrapper.remove();
    this.entries.delete(tabId);
    if (this.pinned.delete(tabId)) {
      this.firePinChange(tabId, false);
    }
    this.fireRelease(tabId);
  }

  /**
   * 标记 tabId 为 automation pinned —— LRU 淘汰会跳过它。
   * 同步操作,幂等(重复 pin 同一 tabId 返回 false 表示状态未变,不触发 listener)。
   * pin 一个未知 tabId 也允许(记录意图);未来 caller acquire(tabId) 时,pin 状态
   * 已就位。
   */
  pinForAutomation(tabId: string): boolean {
    if (this.pinned.has(tabId)) return false;
    this.pinned.add(tabId);
    this.firePinChange(tabId, true);
    return true;
  }

  unpinForAutomation(tabId: string): boolean {
    if (!this.pinned.delete(tabId)) return false;
    this.firePinChange(tabId, false);
    return true;
  }

  isPinnedForAutomation(tabId: string): boolean {
    return this.pinned.has(tabId);
  }

  /**
   * 订阅 pin 状态变化(automation 期间防 LRU 用)。仅供调试 / 上报通道使用,
   * 业务逻辑请通过 pin 状态判断分支。
   */
  onPinChange(listener: (tabId: string, pinned: boolean) => void): () => void {
    this.pinListeners.add(listener);
    return () => {
      this.pinListeners.delete(listener);
    };
  }

  /**
   * 订阅 entry 释放事件。rsbBrowserBridge helper 用它把 release 同步到 main 端
   * 的 TabRegistry —— LRU 淘汰用户感知不到,但 main 端必须及时清掉 webContentsId
   * 映射,否则 backend 拿到 stale id 调 webContents.fromId 会返回 null。
   */
  onRelease(listener: (tabId: string) => void): () => void {
    this.releaseListeners.add(listener);
    return () => {
      this.releaseListeners.delete(listener);
    };
  }

  /**
   * 订阅新 entry 创建。Shell 中已挂载但隐藏的 hook 用它观察 Agent 显式创建的
   * webview；命中已有 entry 的 acquire 不触发。
   */
  onEntryCreated(listener: (tabId: string) => void): () => void {
    this.entryCreatedListeners.add(listener);
    return () => {
      this.entryCreatedListeners.delete(listener);
    };
  }

  /**
   * guest 生命周期监听必须在 wrapper 接入 document 前安装。Agent 可以在隐藏 tab
   * 上显式创建并立即驱动 webview；React hook 收到 entry-created 后才会重新绑定，
   * 这段间隙内的崩溃 / 卡死状态由 entry 暂存。
   */
  private observeGuestLifecycle(entry: PoolEntry): void {
    const onRenderProcessGone = (event: Electron.RenderProcessGoneEvent) => {
      entry.guestFailure = {
        kind: 'render-process-gone',
        reason: event.details.reason,
      };
    };
    const onUnresponsive = () => {
      entry.guestFailure = { kind: 'unresponsive', reason: 'unresponsive' };
    };
    const onResponsive = () => {
      if (entry.guestFailure?.kind === 'unresponsive') {
        entry.guestFailure = null;
      }
    };
    const onStartLoading = () => {
      entry.guestFailure = null;
    };

    entry.webview.addEventListener('render-process-gone', onRenderProcessGone);
    entry.webview.addEventListener('unresponsive', onUnresponsive);
    entry.webview.addEventListener('responsive', onResponsive);
    entry.webview.addEventListener('did-start-loading', onStartLoading);
  }

  /**
   * LRU 淘汰 —— 内部用。优先挑最旧的**未 pinned** entry。如果所有 entry 都
   * pinned,fallback 到挑最旧的(capacity 限制比 pin 更高优先级);理论上不会
   * 发生(pin 数远小于 POOL_CAPACITY),fallback 是防御式兜底,触发时:
   *   - release 触发 onRelease listener → bridge 通知 main TabRegistry release
   *   - 同时 webview DOM 被移除,Electron 销毁 guest webContents
   *   - main 端 registry 的 destroyed listener 兜底清理(双重保险)
   * 因此后续 automation backend 调 `registry.getWebContentsByTabId()` 拿到 null,
   * 给出清晰的 lookup miss(而不是 pool 不断膨胀)。
   */
  private evictLRU(): void {
    let oldestUnpinned: PoolEntry | null = null;
    let oldestAny: PoolEntry | null = null;
    for (const e of this.entries.values()) {
      if (!oldestAny || e.lastAccess < oldestAny.lastAccess) oldestAny = e;
      if (this.pinned.has(e.tabId)) continue;
      if (!oldestUnpinned || e.lastAccess < oldestUnpinned.lastAccess) oldestUnpinned = e;
    }
    const victim = oldestUnpinned ?? oldestAny;
    if (victim) this.release(victim.tabId);
  }

  private pinListeners = new Set<(tabId: string, pinned: boolean) => void>();
  private releaseListeners = new Set<(tabId: string) => void>();
  private entryCreatedListeners = new Set<(tabId: string) => void>();

  private firePinChange(tabId: string, pinned: boolean): void {
    for (const l of this.pinListeners) {
      try {
        l(tabId, pinned);
      } catch {
        // listener throw should not break pool internal state mutation
      }
    }
  }

  private fireRelease(tabId: string): void {
    for (const l of this.releaseListeners) {
      try {
        l(tabId);
      } catch {
        // listener throw must not stop the pool from advancing
      }
    }
  }

  private fireEntryCreated(tabId: string): void {
    for (const l of this.entryCreatedListeners) {
      try {
        l(tabId);
      } catch {
        // listener throw must not break entry creation
      }
    }
  }

  /**
   * 释放 pool 内全部 entry。侧边栏宿主窗口切换(内嵌 → 独立子窗口)时调用:
   * 本 renderer 的 webview 即将失去宿主语义,留着就是僵尸实例(占内存,且 main
   * 端 TabRegistry 的 webContentsId 指向旧窗口 → 自动化 backend 串窗)。逐个走
   * release,onRelease 链自动通知 main 清注册。
   */
  releaseAll(): void {
    for (const tabId of [...this.entries.keys()]) {
      this.release(tabId);
    }
  }

  /** 调试用:当前 pool 内的 tabId 列表(按 lastAccess 升序,最旧在前)。 */
  inspectTabIds(): string[] {
    return [...this.entries.values()]
      .sort((a, b) => a.lastAccess - b.lastAccess)
      .map((e) => e.tabId);
  }
}

/** 全局单例 —— 整个 renderer 进程共享一个 pool。 */
export const browserWebviewPool = new BrowserWebviewPoolImpl();

/** Pool 容量常量(给单测 / 调用方做容量假设)。 */
export const BROWSER_WEBVIEW_POOL_CAPACITY = POOL_CAPACITY;
