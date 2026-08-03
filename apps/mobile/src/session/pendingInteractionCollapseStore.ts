import { useSyncExternalStore } from 'react';
import type { PendingInteractionLike } from '@cindy/maker-shared/interaction';
import {
  prunePendingInteractionCollapsed,
  togglePendingInteractionCollapsed,
} from '@/session/interactionModel';

/**
 * 「这条待处理请求我先不答」的收起意图,按 sessionId 存,活在模块级。
 *
 * 为什么不是页面组件的 useState:契约是「只有该请求被回答 / 撤销才失效」。放在页面里
 * 时,离开任务导致页面卸载、再进来同一条仍在 pending 的请求会重新展开占满屏
 * (#1493 review)——这与最早那版「卡片内部 useState 被 key 变化冲掉」是同一个病,
 * 只是作用域大了一层。
 *
 * 也不放进 remoteSessionStore:那是被控端会话的镜像(远端事实),收起是本端的 UI 意图,
 * 混进去会让「快照回收」之类的语义互相牵连。
 *
 * store 是唯一真相源、消费方直接 useSyncExternalStore 订阅,不做 useState 镜像:镜像
 * 需要「切 session 时重新装载 + 变化时写回」两个 effect,而它们同帧执行会用新 sessionId
 * 写回旧 state,把上一个会话的收起意图串到新会话。
 */
const collapsedBySession = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();

/**
 * 空快照必须是同一个引用:useSyncExternalStore 用 Object.is 比较,每次新建 []
 * 会让所有订阅者每帧重渲染。
 */
const EMPTY: readonly string[] = [];

/**
 * 最多保留多少个会话的收起意图。
 *
 * 绝大多数会话的卡最终会被回答 → 权威快照 prune 到空 → key 自然删除(见 write)。
 * 只有「收起后一直不答、又离开会话」会留下残条,这里按插入序淘汰最旧的,保证 Map 有界。
 */
const MAX_TRACKED_SESSIONS = 32;

export function getCollapsedPendingRequestIds(sessionId: string): readonly string[] {
  if (!sessionId) return EMPTY;
  return collapsedBySession.get(sessionId) ?? EMPTY;
}

export function subscribeCollapsedPendingRequestIds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCollapsedPendingRequestIds(sessionId: string): readonly string[] {
  return useSyncExternalStore(
    subscribeCollapsedPendingRequestIds,
    () => getCollapsedPendingRequestIds(sessionId),
  );
}

/** 切换这条请求的收起态。 */
export function togglePendingInteractionCollapse(sessionId: string, requestId: string): void {
  if (!sessionId || !requestId) return;
  write(sessionId, togglePendingInteractionCollapsed(getCollapsedPendingRequestIds(sessionId), requestId));
}

/**
 * 按 pending 快照回收收起记录。`authoritative` 的含义见
 * prunePendingInteractionCollapsed:非权威快照(离线清空投影 / 全量快照未到)不清任何东西。
 */
export function prunePendingInteractionCollapse<T extends PendingInteractionLike>(
  sessionId: string,
  pending: readonly T[],
  options: { authoritative: boolean },
): void {
  if (!sessionId) return;
  const current = getCollapsedPendingRequestIds(sessionId);
  if (current.length === 0) return;
  write(sessionId, prunePendingInteractionCollapsed(current, pending, options));
}

/** 仅测试用:清空全部会话的收起意图。 */
export function clearAllPendingInteractionCollapse(): void {
  if (collapsedBySession.size === 0) return;
  collapsedBySession.clear();
  emit();
}

function write(sessionId: string, next: readonly string[]): void {
  const current = collapsedBySession.get(sessionId) ?? EMPTY;
  if (current === next) return;
  if (next.length === 0) {
    if (!collapsedBySession.delete(sessionId)) return;
    emit();
    return;
  }
  collapsedBySession.set(sessionId, next);
  // 插入序淘汰:Map 的迭代顺序就是插入顺序,重写同一个 key 不会把它移到末尾,所以
  // 这里淘汰的是「最久没有新增收起记录」的会话。
  while (collapsedBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = collapsedBySession.keys().next();
    if (oldest.done) break;
    collapsedBySession.delete(oldest.value);
  }
  emit();
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}
