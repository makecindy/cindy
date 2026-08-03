/**
 * ghostUnreadStore.ts — 意识未读角标(notify.badge)的 renderer 侧状态源。
 * ---------------------------------------------------------------------------
 * 主机在意识上行 badge 时点亮、用户打开面板 / 停用 / 卸载时熄灭,变化经
 * 'ghosts:badge' 推送到达;首帧用 unreadSync() 同步取快照(绿点要与插件入口
 * 同帧出现,晚一帧跳出来是可见跳变)。
 *
 * 订阅纪律与 ghostSessionActivityStore / sessionAttentionStore 同款(性能不变量):
 * 组件按 ghostId 订阅 **primitive**(boolean / string | undefined),逐行挂载不
 * 退回整表订阅。摘要与"有没有未读"因此拆成两个 hook——返回对象会让
 * useSyncExternalStore 每次拿到新引用而无限重渲染。
 */

import { useSyncExternalStore } from 'react';

interface UnreadEntry {
  summary?: string;
  at: number;
}

const unread = new Map<string, UnreadEntry>();
const listeners = new Set<() => void>();
let subscribed = false;

interface UnreadSnapshotEntry {
  ghostId: string;
  summary?: string;
  at: number;
}

interface GhostUnreadApi {
  onBadge?: (
    cb: (p: { ghostId: string; unread: boolean; summary?: string; at?: number }) => void,
  ) => () => void;
  onUnreadSnapshot?: (cb: (p: { entries: UnreadSnapshotEntry[] }) => void) => () => void;
  unreadSync?: () => { entries: UnreadSnapshotEntry[] };
  clearUnread?: (id: string) => Promise<{ ok: boolean }>;
}

function api(): GhostUnreadApi | undefined {
  return (window as unknown as { electronAPI?: { ghosts?: GhostUnreadApi } }).electronAPI?.ghosts;
}

function emit(): void {
  for (const cb of [...listeners]) cb();
}

/** 首次被消费时才取快照 + 挂推送(模块导入零副作用;测试环境无 electronAPI 也安全)。 */
/** 整表替换(首帧同步读与换账号快照共用一处落位)。 */
function applySnapshot(entries: UnreadSnapshotEntry[] | undefined): void {
  unread.clear();
  for (const entry of entries ?? []) {
    if (typeof entry?.ghostId !== 'string' || typeof entry.at !== 'number') continue;
    unread.set(entry.ghostId, {
      ...(entry.summary ? { summary: entry.summary } : {}),
      at: entry.at,
    });
  }
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  const ghosts = api();
  try {
    applySnapshot(ghosts?.unreadSync?.().entries);
  } catch {
    // 未读是提醒不是内容:快照拿不到就按"全无未读"起步,后续推送照常生效。
  }
  // 换账号:main 在 auth 状态变化后推一份新 owner 的全量快照,这里整表替换。
  // 只订阅增量的话,账号 A 的绿点与摘要会留在账号 B 的界面上(跨账号残留)。
  ghosts?.onUnreadSnapshot?.((payload) => {
    applySnapshot(payload?.entries);
    emit();
  });
  ghosts?.onBadge?.((payload) => {
    if (!payload || typeof payload.ghostId !== 'string') return;
    if (payload.unread) {
      unread.set(payload.ghostId, {
        ...(payload.summary ? { summary: payload.summary } : {}),
        at: typeof payload.at === 'number' ? payload.at : 0,
      });
    } else if (!unread.delete(payload.ghostId)) {
      return; // 本来就没亮,不惊动订阅者
    }
    emit();
  });
}

function subscribe(cb: () => void): () => void {
  ensureSubscribed();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 某意识当前是否有未读(primitive 快照,per-row 精准订阅)。 */
export function useGhostUnread(ghostId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => unread.has(ghostId),
    () => false,
  );
}

/** 某意识最新一条未读的摘要(没有未读或意识没给摘要时 undefined)。 */
export function useGhostUnreadSummary(ghostId: string): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => unread.get(ghostId)?.summary,
    () => undefined,
  );
}

/**
 * 是否**任一**意识有未读(侧栏插件入口的聚合静态点)。
 * 返回 boolean 而非计数:入口点不显示数量,订阅 boolean 能少掉一大半重渲染。
 */
export function useAnyGhostUnread(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => unread.size > 0,
    () => false,
  );
}

/**
 * 用户明确已读(打开面板)。本地先熄灭再报主机:面板已经在眼前展开了,
 * 点还亮着半秒是可见的错;主机那边失败也只是下次重启又亮起来,不丢内容。
 */
export function clearGhostUnread(ghostId: string): void {
  ensureSubscribed();
  if (unread.delete(ghostId)) emit();
  void api()?.clearUnread?.(ghostId)?.catch(() => undefined);
}

/** 测试专用:直灌一条角标变化(绕过 IPC)。 */
export function __ingestGhostBadgeForTest(
  ghostId: string,
  payload: { unread: boolean; summary?: string; at?: number },
): void {
  // 先把订阅落定(无 electronAPI 时是空转),否则灌进来的条目会被随后首个
  // 消费者触发的 ensureSubscribed → applySnapshot 整表清掉。
  ensureSubscribed();
  if (payload.unread) {
    unread.set(ghostId, {
      ...(payload.summary ? { summary: payload.summary } : {}),
      at: payload.at ?? 0,
    });
  } else {
    unread.delete(ghostId);
  }
  emit();
}

/** 测试专用:清空全部状态。 */
export function __resetGhostUnreadForTest(): void {
  unread.clear();
  listeners.clear();
  subscribed = false;
}
