/**
 * snapshot-tracker.ts
 * ---------------------------------------------------------------------------
 * Computer-use 窗口快照代际追踪。
 *
 * 背景:动作工具(click / set_value / type_text 等)的 `element_index` 是指向
 * "上一次 get_window_state 返回列表第几项"的裸整数,观察和动作之间 UI 树变化
 * (弹窗 / 刷新 / 动画)时会静默作用到错误元素上——最难归因的一类静默失败。
 *
 * host 侧 driver(cua-driver)没有 UI 树变化事件,在动作前重新拉一次
 * get_window_state 判新鲜度会让每个动作的延迟翻倍。所以这里做代际语义的
 * 最小安全版:get_window_state 每次成功观察都发一个新快照 id 并成为该
 * (session, pid, window_id) 的"最新代";动作携带的快照 id 不是最新代
 * (被更新观察取代 / 未知 / 窗口对不上)→ 判 STALE。它拦不住"最新观察之后
 * UI 又变了"(没有树变化事件谁也拦不住),但能确定性拦住"拿旧代 index 打
 * 新代 UI"这一类。
 *
 * 内存:两个 Map 都有 FIFO 上限,server 实例常驻(codex HTTP bridge 下跨
 * session 共享一个实例)也不会无界增长。
 */

/** 动作携带的快照 id 校验结果。 */
export type SnapshotValidation =
  | { ok: true }
  | {
      ok: false;
      /**
       * unknown_snapshot: id 不存在(从未发过 / 已被淘汰 / 不属于本 session)
       * superseded     : 同窗口有更新的观察,本 id 已过代
       * window_mismatch: id 是别的 pid / window 的观察
       */
      reason: 'unknown_snapshot' | 'superseded' | 'window_mismatch';
      latestSnapshotId?: string;
    };

interface SnapshotMeta {
  windowKey: string;
  sessionKey: string;
  pid: number;
  windowId: number;
  driverSnapshotId?: string;
  elements?: Map<string, number>;
}

/** 保留的窗口数与历史快照数上限(FIFO 淘汰)。 */
const MAX_TRACKED_WINDOWS = 256;
const MAX_TRACKED_SNAPSHOTS = 1024;

export class WindowSnapshotTracker {
  /** (session, pid, window_id) → 最新一代快照 id。 */
  private readonly latestByWindow = new Map<string, string>();
  /** 快照 id → 元信息;保留近期历史以便区分 superseded 和 unknown。 */
  private readonly metaById = new Map<string, SnapshotMeta>();
  /** driver 观察 id / element_token 前缀 → 本层快照 id。 */
  private readonly aliasToId = new Map<string, string>();
  private seq = 0;

  private windowKey(sessionKey: string, pid: number, windowId: number): string {
    return `${sessionKey}\u0000${pid}\u0000${windowId}`;
  }

  private aliasKey(sessionKey: string, alias: string): string {
    return `${sessionKey}\u0000${alias}`;
  }

  /** get_window_state 成功后调用:登记新一代快照并返回其 id。 */
  record(sessionId: string | undefined, pid: number, windowId: number): string {
    const sessionKey = sessionId ?? '';
    const windowKey = this.windowKey(sessionKey, pid, windowId);
    if (!this.latestByWindow.has(windowKey) && this.latestByWindow.size >= MAX_TRACKED_WINDOWS) {
      const oldestKey = this.latestByWindow.keys().next().value;
      if (oldestKey !== undefined) this.latestByWindow.delete(oldestKey);
    }
    while (this.metaById.size >= MAX_TRACKED_SNAPSHOTS) {
      const oldestId = this.metaById.keys().next().value;
      if (oldestId === undefined) break;
      this.metaById.delete(oldestId);
      for (const [alias, id] of this.aliasToId) {
        if (id === oldestId) this.aliasToId.delete(alias);
      }
    }
    this.seq += 1;
    const id = `ws-${this.seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.latestByWindow.set(windowKey, id);
    this.metaById.set(id, { windowKey, sessionKey, pid, windowId });
    return id;
  }

  /** A failed observation invalidates earlier IDs and aliases without issuing a usable ID. */
  invalidate(
    sessionId: string | undefined,
    pid: number,
    windowId: number,
  ): void {
    this.latestByWindow.delete(this.windowKey(sessionId ?? '', pid, windowId));
  }

  /** Register a host/driver snapshot id as an alias for the MCP-level guard id. */
  registerAlias(snapshotId: string, alias: string): void {
    const meta = this.metaById.get(snapshotId);
    if (alias.length === 0 || alias === snapshotId || !meta) return;
    meta.driverSnapshotId = alias;
    const key = this.aliasKey(meta.sessionKey, alias);
    // Some drivers may expose a stable per-window id instead of a per-observation id.
    // Never overwrite an existing alias, otherwise an old element_index paired with
    // that stable alias could be silently treated as fresh after a later observation.
    if (this.aliasToId.has(key)) return;
    if (this.aliasToId.size >= MAX_TRACKED_SNAPSHOTS) {
      const oldestAlias = this.aliasToId.keys().next().value;
      if (oldestAlias !== undefined) this.aliasToId.delete(oldestAlias);
    }
    this.aliasToId.set(key, snapshotId);
  }

  /** Resolve host ids to the driver's original id; never send a ws-* id to a driver. */
  driverSnapshotId(sessionId: string | undefined, snapshotId: string): string | undefined {
    const sessionKey = sessionId ?? '';
    const id = this.aliasToId.get(this.aliasKey(sessionKey, snapshotId)) ?? snapshotId;
    const meta = this.metaById.get(id);
    return meta?.sessionKey === sessionKey ? meta.driverSnapshotId : undefined;
  }

  sameSnapshot(sessionId: string | undefined, left: string, right: string): boolean {
    const key = sessionId ?? '';
    const a = this.aliasToId.get(this.aliasKey(key, left)) ?? left;
    const b = this.aliasToId.get(this.aliasKey(key, right)) ?? right;
    return a === b && this.metaById.get(a)?.sessionKey === key;
  }

  windowId(sessionId: string | undefined, snapshotId: string): number | undefined {
    const key = sessionId ?? '';
    const id = this.aliasToId.get(this.aliasKey(key, snapshotId)) ?? snapshotId;
    const meta = this.metaById.get(id);
    return meta?.sessionKey === key ? meta.windowId : undefined;
  }

  recordElements(snapshotId: string, elements: unknown): void {
    const meta = this.metaById.get(snapshotId);
    if (!meta || !Array.isArray(elements)) return;
    meta.elements = new Map();
    for (const element of elements.slice(0, 2000)) {
      if (typeof element?.element_token === 'string' && typeof element?.element_index === 'number') {
        meta.elements.set(element.element_token, element.element_index);
      }
    }
  }

  elementReference(sessionId: string | undefined, token: string, observationId?: string) {
    // A repeated token is ambiguous without an explicit observation. Never silently
    // promote an old reference to the newest generation just because its text matches.
    const canonicalId = observationId === undefined ? undefined
      : this.aliasToId.get(this.aliasKey(sessionId ?? '', observationId)) ?? observationId;
    for (const [snapshotId, meta] of this.metaById) {
      if (canonicalId !== undefined && snapshotId !== canonicalId) continue;
      const index = meta.elements?.get(token);
      if (meta.sessionKey === (sessionId ?? '') && index !== undefined) {
        return { snapshotId, index, windowId: meta.windowId };
      }
    }
    return undefined;
  }

  /**
   * 动作携带快照 id 时调用:校验它是否仍是目标窗口的最新观察。
   * windowId 缺省(动作允许省略 window_id)时只对 pid 做窗口一致性校验。
   */
  validate(
    sessionId: string | undefined,
    snapshotId: string,
    pid: number,
    windowId?: number,
  ): SnapshotValidation {
    const sessionKey = sessionId ?? '';
    const canonicalSnapshotId = this.aliasToId.get(this.aliasKey(sessionKey, snapshotId)) ?? snapshotId;
    const meta = this.metaById.get(canonicalSnapshotId);
    if (!meta || meta.sessionKey !== sessionKey) {
      return { ok: false, reason: 'unknown_snapshot' };
    }
    if (meta.pid !== pid || (windowId !== undefined && meta.windowId !== windowId)) {
      return {
        ok: false,
        reason: 'window_mismatch',
        latestSnapshotId: this.latestByWindow.get(meta.windowKey),
      };
    }
    const latest = this.latestByWindow.get(meta.windowKey);
    if (latest !== canonicalSnapshotId) {
      return { ok: false, reason: 'superseded', latestSnapshotId: latest };
    }
    return { ok: true };
  }
}
