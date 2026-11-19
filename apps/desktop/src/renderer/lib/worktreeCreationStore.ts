import { useSyncExternalStore } from 'react';

/**
 * worktreeCreationStore — 临时态 worktree 创建状态(session-keyed)
 * ---------------------------------------------------------------------------
 * 目的:把 worktree 创建过程的反馈从 chat stream 的 SystemCard 移到 ChatInput 底部
 * workingDir chip 行(CCAgentSessionView.tsx)显示,避免在对话内容里留一张"信息卡",
 * 视觉更轻,语义也更准确——worktree 是 session 元数据,不是对话内容。
 *
 * 状态机:
 *   idle(无条目) → creating(创建中) → success(自动 clear,回 idle) | failed(用户手动 clear)
 *
 * 注意:success 状态不保留——成功后 session.workingDir 已经更新为 worktree 路径,
 * UI 自然反映,无需额外标记。只有 creating/failed 需要 UI 介入。
 *
 * 不持久:纯 in-memory,刷新/重启清空。
 */

export type WorktreeCreationState =
  /**
   * startedAt:进入 creating 的时刻(ms),用于加载卡片的「已等待」计时。调用方不必传,
   * set 时自动补上;同一 session 连续 creating 保留首次时刻,切走再切回视图不会从 0 重计。
   */
  | { status: 'creating'; name: string; startedAt?: number }
  | { status: 'failed'; name: string; error: string };

const states = new Map<string, WorktreeCreationState>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 静默:listener 抛错不应影响其它订阅者 */
    }
  }
}

export const worktreeCreationStore = {
  /** 全局订阅:任意 session 状态变化都通知。hook 内部用 sessionId 自筛。 */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },

  /** 返回当前快照(undefined 表示该 session 当前无 worktree 创建态)。 */
  get(sessionId: string): WorktreeCreationState | undefined {
    return states.get(sessionId);
  },

  /** 设置/覆盖某 session 的状态;触发通知。 */
  set(sessionId: string, state: WorktreeCreationState): void {
    if (!sessionId) return;
    if (state.status === 'creating' && state.startedAt === undefined) {
      const previous = states.get(sessionId);
      const startedAt = previous?.status === 'creating' && previous.startedAt !== undefined
        ? previous.startedAt
        : Date.now();
      states.set(sessionId, { ...state, startedAt });
    } else {
      states.set(sessionId, state);
    }
    notify();
  },

  /** 清除某 session 的状态(成功后 / 用户 dismiss failed 后调用)。idempotent。 */
  clear(sessionId: string): void {
    if (!sessionId) return;
    if (!states.has(sessionId)) return;
    states.delete(sessionId);
    notify();
  },

  /** 仅供测试 / 登出清理。 */
  reset(): void {
    if (states.size === 0) return;
    states.clear();
    notify();
  },
};

/**
 * React hook:订阅某 session 的 worktree 创建状态。
 * 没有条目时返回 undefined,UI 走默认 workingDir 显示。
 */
export function useWorktreeCreation(
  sessionId: string | undefined,
): WorktreeCreationState | undefined {
  return useSyncExternalStore(
    worktreeCreationStore.subscribe,
    () => (sessionId ? worktreeCreationStore.get(sessionId) : undefined),
    () => undefined,
  );
}
