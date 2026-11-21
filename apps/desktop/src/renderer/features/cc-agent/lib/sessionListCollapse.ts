import {
  getSessionListCollapseView,
  type SessionListCollapseView,
  type SessionListCollapseViewInput,
} from '@cindy/maker-shared/session-list-collapse';
import { SIDEBAR_INACTIVE_COLLAPSE_MS } from './sidebarCollapseConfig';

// 保留共享算法供原有数量上限与自动化运行列表使用；手机端默认规则不变。
export {
  SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT,
  SESSION_LIST_COLLAPSE_RECENT_WINDOW_MS,
  getSessionListCollapseView,
  type SessionListCollapseView,
  type SessionListCollapseViewInput,
} from '@cindy/maker-shared/session-list-collapse';

/** The opt-in replaces the task count floor with a shorter activity window. */
export function getSidebarSessionCollapseView<T>({
  idleCollapseEnabled = false,
  isContainerEntry,
  nowMs = Date.now(),
  recentWindowMs,
  ...input
}: Omit<SessionListCollapseViewInput<T>, 'expandGroupForHiddenActiveEntry'> & {
  idleCollapseEnabled?: boolean;
}): SessionListCollapseView<T> {
  if (!idleCollapseEnabled) return getSessionListCollapseView({ ...input, nowMs, recentWindowMs });

  return getSessionListCollapseView({
    ...input,
    nowMs,
    recentWindowMs: recentWindowMs ?? SIDEBAR_INACTIVE_COLLAPSE_MS,
    minVisibleCount: isContainerEntry ? input.minVisibleCount : 0,
    isContainerEntry,
    expandGroupForHiddenActiveEntry: false,
  });
}
