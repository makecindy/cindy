/**
 * TabRegistry — main-process source of truth for RSB browser tabs.
 *
 * The renderer owns the `<webview>` DOM nodes and the LRU pool; the main
 * process needs a parallel registry so backend code (Phase 3+) can:
 *  1. Enumerate tabs (per session) without round-tripping to the renderer for
 *     every read.
 *  2. Resolve a tab id → `Electron.WebContents` for CDP debugger attach, page
 *     capture, etc.
 *  3. Pin a tab against LRU eviction while an automation step is in flight.
 *
 * Renderer reports `(sessionId, tabId, webContentsId)` after the webview's
 * `dom-ready` (only after attach is `getWebContentsId()` valid). The registry
 * resolves the integer to a `WebContents` via `webContents.fromId` at lookup
 * time — never caches the object — so a guest renderer crash / process recycle
 * naturally rolls forward without registry surgery.
 *
 * The registry also attaches a `'destroyed'` listener to every reported
 * webContents and self-prunes when the guest dies (renderer crash, partition
 * GC). Combined with the renderer's explicit `release` and the periodic
 * `snapshot` reconciliation, the registry never accumulates stale entries.
 *
 * Phase 2 scope: registry + pin set + lookups. The pin "broadcast to renderer"
 * side lives in `ipc.ts`; Phase 3 backend code wires automation steps to it.
 */

import type { WebContents } from 'electron';

interface RegistryLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

/**
 * What `webContents.fromId` does at lookup time. Injected so tests can pump in
 * a fake without importing Electron.
 */
export type WebContentsLookup = (id: number) => WebContents | null | undefined;

/** A single registered RSB browser tab. */
export interface TabRecord {
  sessionId: string;
  tabId: string;
  webContentsId: number;
}

export interface TabRegistryOptions {
  lookupWebContents: WebContentsLookup;
  logger: RegistryLogger;
}

/** Subscriber notified on pin set changes (used by IPC to broadcast). */
export type PinChangeListener = (tabId: string, pinned: boolean) => void;

/**
 * In-memory tab registry. Singleton lifetime is the desktop app's main process.
 */
export class TabRegistry {
  private readonly records = new Map<string, TabRecord>(); // tabId → record
  /** tabId set of automation-active tabs that must not be LRU-evicted. */
  private readonly pinned = new Set<string>();
  /** Legacy/manual pin ownership, kept separate from scoped backend leases. */
  private readonly manualPins = new Set<string>();
  /** Unique leases prevent a late old-generation release from touching a new pin. */
  private readonly pinLeases = new Map<string, Set<symbol>>();
  /**
   * tabId → destroyed-listener cleanup. Keyed by tabId (not webContentsId) so
   * that pathological cases — two different tabs reported with the same
   * webContentsId, or the same tabId re-reported with same webContentsId twice —
   * still leave each tab with its own correctly-bound listener instead of
   * silently aliasing.
   */
  private readonly destroyedCleanup = new Map<string, () => void>();
  private readonly pinListeners = new Set<PinChangeListener>();
  private readonly reportListeners = new Set<(record: TabRecord) => void>();

  constructor(private readonly opts: TabRegistryOptions) {}

  /**
   * Renderer reports a (sessionId, tabId, webContentsId) triple. Idempotent on
   * the same tabId — the old listener (if any) is detached unconditionally so
   * a replaced webContentsId never leaves a stale handler around.
   */
  report(record: TabRecord): void {
    // Detach any prior listener for this tabId BEFORE recording the new state.
    // Covers: replaced webContentsId, same webContentsId reported twice,
    // or different tab reusing a recycled webContentsId.
    this.detachDestroyedListener(record.tabId);
    this.records.set(record.tabId, record);
    this.attachDestroyedListener(record);
    for (const l of this.reportListeners) {
      try {
        l(record);
      } catch (err) {
        this.opts.logger.warn('report listener threw (ignored)', err);
      }
    }
  }

  /**
   * 订阅 report 到达事件。popup 归属等待用:guest 的 window.open 可能先于
   * renderer 的 report 抵达 main,等待方靠这个事件在 report 落地的瞬间完成
   * 反查,而不是靠固定轮询窗口赌时序。返回退订函数。
   */
  onReport(listener: (record: TabRecord) => void): () => void {
    this.reportListeners.add(listener);
    return () => this.reportListeners.delete(listener);
  }

  /**
   * Renderer-driven release (tab close / pool eviction). Drops the record and
   * cleans the destroyed-listener.
   *
   * `expectedWebContentsId`(可选)= 调用方(旧 renderer)当初 report 的 guest id。
   * 宿主迁移竞态防护:旧 renderer 的 release 若晚于新 renderer 对同 tabId 的
   * report 到达,当前记录的 webContentsId 已换新 —— 此时忽略这个 stale release,
   * 保住新窗口的注册。内部调用(reconcile / destroyed 监听 / 懒 GC)不带该参数,
   * 维持无条件释放。
   */
  release(tabId: string, expectedWebContentsId?: number): void {
    const record = this.records.get(tabId);
    if (!record) return;
    if (
      expectedWebContentsId !== undefined &&
      record.webContentsId !== expectedWebContentsId
    ) {
      this.opts.logger.info('ignored stale release (webContentsId mismatch)', {
        tabId,
        expected: expectedWebContentsId,
        current: record.webContentsId,
      });
      return;
    }
    this.detachDestroyedListener(tabId);
    this.records.delete(tabId);
    this.manualPins.delete(tabId);
    this.pinLeases.delete(tabId);
    if (this.pinned.delete(tabId)) {
      this.firePinChange(tabId, false);
    }
  }

  /**
   * Reconcile against the renderer's live tabId set. Any registry entry whose
   * tabId is NOT in `liveTabIds` AND whose webContents is destroyed (or
   * unknown) is dropped — this recovers from missed `release` calls (HMR,
   * renderer crash).
   *
   * Snapshot is drop-only. Upserts (new tabs, replaced webContentsIds) flow
   * exclusively through `report` so `webContentsId` discovery has a single
   * codepath (the `dom-ready` handler).
   *
   * Returns `pinnedTabIds` so the renderer can re-mirror the main-side pin
   * authority into the pool after a reload — main always holds the truth on
   * which tabs are automation-pinned.
   */
  reconcile(liveTabIds: string[]): { dropped: string[]; kept: number; pinnedTabIds: string[] } {
    const liveSet = new Set(liveTabIds);
    const dropped: string[] = [];
    for (const [tabId, record] of this.records) {
      if (liveSet.has(tabId)) continue;
      const wc = this.opts.lookupWebContents(record.webContentsId);
      if (!wc || wc.isDestroyed()) {
        dropped.push(tabId);
      }
    }
    for (const tabId of dropped) {
      this.release(tabId);
    }
    return {
      dropped,
      kept: this.records.size,
      pinnedTabIds: [...this.pinned],
    };
  }

  /**
   * webContentsId 反查 tab 记录。popup 路由用:guest 内 window.open 触发时,
   * 只有发起方 guest 的 webContentsId 可拿,要靠它找回 opener tab 及其归属
   * session,popup 才能落进正确的 bucket。线性扫——records 是每 session 个位数
   * 的 tab,规模上限远小于任何需要索引的量级。
   */
  findByWebContentsId(webContentsId: number): TabRecord | null {
    for (const record of this.records.values()) {
      if (record.webContentsId === webContentsId) return record;
    }
    return null;
  }

  /** Read by tab id. Returns null if unknown OR if the webContents is dead. */
  getWebContentsByTabId(tabId: string): WebContents | null {
    const record = this.records.get(tabId);
    if (!record) return null;
    const wc = this.opts.lookupWebContents(record.webContentsId);
    if (!wc || wc.isDestroyed()) {
      // Lazy GC: a webContents died but we missed the `destroyed` event (this
      // shouldn't happen but is a defensive net). Drop the row.
      this.release(tabId);
      return null;
    }
    return wc;
  }

  /** All currently-registered tabs (snapshot copy — safe to iterate/mutate around). */
  listAll(): TabRecord[] {
    return [...this.records.values()];
  }

  /** Subset for one session. */
  listBySession(sessionId: string): TabRecord[] {
    return [...this.records.values()].filter((r) => r.sessionId === sessionId);
  }

  // ── pin set ────────────────────────────────────────────────────────────────

  /**
   * Mark `tabId` as automation-active. Returns true if state changed (i.e. the
   * tab wasn't already pinned). Pin listeners only fire on transitions, so the
   * IPC broadcaster doesn't re-send no-op pins to the renderer.
   *
   * Pinning an unknown `tabId` is permitted (records the intent; the renderer
   * may still be reporting). When the renderer later reports the tab and
   * reads `isPinned`, automation behavior is consistent.
   */
  pin(tabId: string): boolean {
    if (this.manualPins.has(tabId)) return false;
    this.manualPins.add(tabId);
    if (this.pinned.has(tabId)) return false;
    this.pinned.add(tabId);
    this.firePinChange(tabId, true);
    return true;
  }

  unpin(tabId: string): boolean {
    if (!this.manualPins.delete(tabId)) return false;
    if ((this.pinLeases.get(tabId)?.size ?? 0) > 0) return false;
    if (!this.pinned.delete(tabId)) return false;
    this.firePinChange(tabId, false);
    return true;
  }

  /**
   * Acquire a scoped automation pin. The returned release is idempotent and
   * token-specific, so disposal of one backend generation cannot remove a
   * replacement generation's protection for the same tab.
   */
  acquirePinLease(tabId: string): () => void {
    const token = Symbol(tabId);
    const leases = this.pinLeases.get(tabId) ?? new Set<symbol>();
    leases.add(token);
    this.pinLeases.set(tabId, leases);
    if (!this.pinned.has(tabId)) {
      this.pinned.add(tabId);
      this.firePinChange(tabId, true);
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.pinLeases.get(tabId);
      if (!current?.delete(token)) return;
      if (current.size > 0) return;
      this.pinLeases.delete(tabId);
      if (this.manualPins.has(tabId)) return;
      if (this.pinned.delete(tabId)) this.firePinChange(tabId, false);
    };
  }

  isPinned(tabId: string): boolean {
    return this.pinned.has(tabId);
  }

  /** Snapshot of currently-pinned tab ids. */
  listPinned(): string[] {
    return [...this.pinned];
  }

  onPinChange(listener: PinChangeListener): () => void {
    this.pinListeners.add(listener);
    return () => this.pinListeners.delete(listener);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private attachDestroyedListener(record: TabRecord): void {
    // `report` always detaches first, so any prior listener for this tabId is
    // gone by the time we land here.
    const wc = this.opts.lookupWebContents(record.webContentsId);
    if (!wc) {
      this.opts.logger.warn('webContents not found at report time', record);
      return;
    }
    const onDestroyed = () => {
      // Look up the row again — the renderer may have already explicitly
      // released this tab between attach and destroy, or replaced the
      // webContentsId with a fresh one.
      const current = this.records.get(record.tabId);
      if (current && current.webContentsId === record.webContentsId) {
        this.release(record.tabId);
      }
    };
    wc.once('destroyed', onDestroyed);
    this.destroyedCleanup.set(record.tabId, () => {
      // Electron WebContents.removeListener exists but `once` registers a wrapper;
      // safe to call removeListener with the same fn.
      try {
        wc.removeListener('destroyed', onDestroyed);
      } catch {
        // wc already destroyed — listener fired or auto-cleaned.
      }
    });
  }

  private detachDestroyedListener(tabId: string): void {
    const cleanup = this.destroyedCleanup.get(tabId);
    if (!cleanup) return;
    this.destroyedCleanup.delete(tabId);
    cleanup();
  }

  private firePinChange(tabId: string, pinned: boolean): void {
    for (const l of this.pinListeners) {
      try {
        l(tabId, pinned);
      } catch (err) {
        this.opts.logger.warn('pin listener threw (ignored)', err);
      }
    }
  }
}
