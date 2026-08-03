/**
 * ghostUnreadStore.ts — 意识未读角标(badge 槽)的 renderer 侧状态源。
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

import { useEffect, useState, useSyncExternalStore } from 'react';

interface UnreadEntry {
  summary?: string;
  at: number;
}

const unread = new Map<string, UnreadEntry>();
const listeners = new Set<() => void>();
let ready = false;

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
  clearUnread?: (id: string, seenAt?: number) => Promise<{ ok: boolean }>;
}

function api(): GhostUnreadApi | undefined {
  return (window as unknown as { electronAPI?: { ghosts?: GhostUnreadApi } }).electronAPI?.ghosts;
}

function emit(): void {
  for (const cb of [...listeners]) cb();
}

function toEntry(entry: UnreadSnapshotEntry): UnreadEntry | null {
  if (typeof entry?.ghostId !== 'string' || typeof entry.at !== 'number') return null;
  return { ...(entry.summary ? { summary: entry.summary } : {}), at: entry.at };
}

/** 整表替换。**换账号**专用:新 owner 的账本就是全部事实,旧的必须整体作废。 */
function applySnapshot(entries: UnreadSnapshotEntry[] | undefined): void {
  unread.clear();
  for (const entry of entries ?? []) {
    const value = toEntry(entry);
    if (value) unread.set(entry.ghostId, value);
  }
}

/**
 * 首次落位:**补齐缺的,不动已有的**。
 *
 * 不能复用整表替换:监听是在同步读之前绑好的(见 ensureReady),读取返回之前到达
 * 的推送已经写进表里,整表替换会把它抹掉——等于换个姿势重新丢掉那条推送。
 * 活推送比落盘快照新,冲突时以推送为准。
 */
function seedSnapshot(entries: UnreadSnapshotEntry[] | undefined): void {
  for (const entry of entries ?? []) {
    const value = toEntry(entry);
    if (value && !unread.has(entry.ghostId)) unread.set(entry.ghostId, value);
  }
}

/**
 * 惰性就绪:**绑增量监听 → 取同步快照**,顺序不可颠倒,且必须在第一次
 * getSnapshot 之前完成——所以每个 getSnapshot 都先过这里,不是只挂在 subscribe 上。
 *
 * 两条约束各自解决一个真问题:
 *
 * 1. **必须早于第一次 getSnapshot**。useSyncExternalStore 的顺序是 render 期先调
 *    getSnapshot、mount 后才调 subscribe。把同步读放在 subscribe 里的话,首帧一定
 *    读到空表,要等 React 订阅后复查快照才纠正——绿点与摘要**晚一帧跳出来**,
 *    恰好抵消了当初做 `unreadSync` 同步读的全部意义。
 * 2. **必须先绑监听再读快照**。反过来的话,两步之间插件恰好点亮角标,那条推送
 *    无人接收,而就绪标记已置位不会再读——那颗点会一直缺到重启或换账号快照。
 *    主机是「先落盘再广播」,所以绑定之后的这次读一定含得上窗口期内的变化。
 *
 * 幂等且只读一次;拿不到就按"全无未读"起步,后续推送照常生效(未读是提醒不是内容)。
 * 模块导入零副作用;测试环境无 electronAPI 时整段是空转,同样安全。
 */
function ensureReady(): void {
  if (ready) return;
  ready = true;
  const ghosts = api();
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
  try {
    seedSnapshot(ghosts?.unreadSync?.().entries);
  } catch {
    /* 读不到就空表起步 */
  }
}

function subscribe(cb: () => void): () => void {
  ensureReady();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 某意识当前是否有未读(primitive 快照,per-row 精准订阅)。 */
export function useGhostUnread(ghostId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      ensureReady();
      return unread.has(ghostId);
    },
    () => false,
  );
}

/** 某意识最新一条未读的摘要(没有未读或意识没给摘要时 undefined)。 */
export function useGhostUnreadSummary(ghostId: string): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => {
      ensureReady();
      return unread.get(ghostId)?.summary;
    },
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
    () => {
      ensureReady();
      return unread.size > 0;
    },
    () => false,
  );
}

/**
 * 宿主窗口此刻是否真的在用户眼前(可见 **且** 聚焦)。
 *
 * 「面板挂载」不等于「用户看见了」:停靠面板与独立面板窗口会一直挂着,窗口最小化、
 * 被别的窗口盖住、或者用户切到别的 app 时,插件新点亮的未读会被立刻当成已读清掉
 * ——常开面板的用户从此**再也收不到这个插件的提醒**(codex review P1)。
 *
 * 判据取两条的交集:`visibilityState` 可靠覆盖最小化 / 后台;`hasFocus` 覆盖失焦,
 * 并顺带兜住「被别的窗口盖住」——遮挡在 Chromium 里不可靠上报,拿聚焦当代理是
 * 目前唯一站得住的近似。代价是用户切回窗口那一刻才清零,这恰恰是对的语义:
 * **他看的时候才算看过**。
 */
export function useHostWindowForeground(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const events = ['visibilitychange', 'focus', 'blur'] as const;
      for (const name of events) {
        (name === 'visibilitychange' ? document : window).addEventListener(name, cb);
      }
      return () => {
        for (const name of events) {
          (name === 'visibilitychange' ? document : window).removeEventListener(name, cb);
        }
      };
    },
    () => document.visibilityState === 'visible' && document.hasFocus(),
    () => false,
  );
}

/**
 * 这个元素此刻是否真的占着可见面积。
 *
 * 「宿主窗口在前台」还不够:同一个前台窗口里,另一个停靠面板被最大化时,本面板
 * **仍然挂载**但被压成零宽/隐藏——用户根本没看到内容,却会被当成已读清零,
 * 切回来时那颗点已经没了(codex review)。
 *
 * 判据用 IntersectionObserver(能同时覆盖零尺寸与滚出可视区);环境不支持时
 * fail-open,退回「窗口前台」那一层,不会比改动前更差。
 *
 * **入参是 callback ref 而不是 ref 对象**:ref 对象的身份永不变化,effect 依赖它
 * 就永远不会重跑——面板崩溃走 fallback、用户点「重载」生成一个**新的** host 元素
 * 之后,观察器还盯着已经脱离 DOM 的旧节点,从此再也不会报告可见,那颗点永远
 * 清不掉(codex review)。改成把元素本身放进 state,换了节点就自然重挂观察器。
 */
export function useElementVisible(): {
  ref: (el: Element | null) => void;
  visible: boolean;
} {
  const [el, setEl] = useState<Element | null>(null);
  /**
   * 初值必须是 **false = 尚未观测到可见**,不能图省事写 true。
   *
   * `IntersectionObserver` 的首次结果要下一拍才到。若初值为 true,面板一挂载
   * (或恢复挂载)时清零 effect 就已经跑完了——而它此刻很可能正躺在被邻居
   * 最大化压成零宽的容器里,用户没看到内容却已经丢了角标(greptile review P1)。
   *
   * 清零是**消费型**动作:宁可晚一拍,不可误清。观测结果到达后 effect 自会重跑。
   */
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!el) {
      setVisible(false); // 还没挂上元素 = 还不知道,不许当成"看见了"
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true); // 观测不了就 fail-open,退回「宿主窗口前台」那一层判据
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setVisible(entry.isIntersecting && entry.intersectionRatio > 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return { ref: setEl, visible };
}

/**
 * 用户明确已读(打开面板)。本地先熄灭再报主机:面板已经在眼前展开了,
 * 点还亮着半秒是可见的错;主机那边失败也只是下次重启又亮起来,不丢内容。
 */
export function clearGhostUnread(ghostId: string): void {
  ensureReady();
  // 带上**当前这条**的点亮时刻:清除请求与插件的新点亮走两条独立 IPC,
  // "新点亮先到、旧清除后到"完全可能发生。main 按它条件删除,陈旧清除不会
  // 抹掉用户还没看到的新摘要(codex review)。
  const seenAt = unread.get(ghostId)?.at;
  if (unread.delete(ghostId)) emit();
  void api()?.clearUnread?.(ghostId, seenAt)?.catch(() => undefined);
}

/** 测试专用:直灌一条角标变化(绕过 IPC)。 */
export function __ingestGhostBadgeForTest(
  ghostId: string,
  payload: { unread: boolean; summary?: string; at?: number },
): void {
  // 先把就绪落定(无 electronAPI 时是空转),否则灌进来的条目会被随后首个
  // 消费者触发的 ensureReady → applySnapshot 整表清掉。
  ensureReady();
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
  ready = false;
}
