import {
  SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT,
  SESSION_LIST_COLLAPSE_RECENT_WINDOW_MS,
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
  entries,
  showAll,
  disableCollapse,
  isFiltering,
  isActiveEntry,
  hasAttentionEntry,
  nowMs = Date.now(),
  getActivityMs,
  idleCollapseEnabled = false,
  recentWindowMs = idleCollapseEnabled
    ? SIDEBAR_INACTIVE_COLLAPSE_MS
    : SESSION_LIST_COLLAPSE_RECENT_WINDOW_MS,
  minVisibleCount = SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT,
  isContainerEntry,
}: SessionListCollapseViewInput<T> & {
  idleCollapseEnabled?: boolean;
  isContainerEntry?: (entry: T) => boolean;
}): SessionListCollapseView<T> {
  let containerCount = 0;
  const visibleHeadCount = Math.max(0, Math.round(minVisibleCount));
  const visibleEntries = showAll || disableCollapse || isFiltering
    ? entries
    : entries.filter((entry, index) => {
        const container = isContainerEntry?.(entry) ?? false;
        // Container headers keep their own limit so an all-idle group can be reopened.
        const withinHead = container
          ? containerCount++ < visibleHeadCount
          : !idleCollapseEnabled && index < visibleHeadCount;
        return withinHead || isActiveEntry(entry) || hasAttentionEntry(entry) ||
          (!container && getActivityMs != null && getActivityMs(entry) >= nowMs - recentWindowMs);
      });
  const hiddenCount = entries.length - visibleEntries.length;
  return {
    visibleEntries,
    isOverflowing: hiddenCount > 0,
    totalCount: entries.length,
    hiddenCount,
  };
}
