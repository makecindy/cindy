import type {
  SessionListCollapseView,
  SessionListCollapseViewInput,
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

/** Desktop-only idle folding (#11233). Container headers retain their count limit. */
export function getSidebarSessionCollapseView<T>({
  entries,
  showAll,
  disableCollapse,
  isFiltering,
  isActiveEntry,
  hasAttentionEntry,
  nowMs = Date.now(),
  getActivityMs,
  recentWindowMs = SIDEBAR_INACTIVE_COLLAPSE_MS,
  minVisibleCount = Infinity,
  isContainerEntry,
}: SessionListCollapseViewInput<T> & {
  isContainerEntry?: (entry: T) => boolean;
}): SessionListCollapseView<T> {
  let containerCount = 0;
  const visibleEntries = showAll || disableCollapse || isFiltering
    ? entries
    : entries.filter((entry) => {
        const container = isContainerEntry?.(entry) ?? false;
        if (container) containerCount++;
        return isActiveEntry(entry) || hasAttentionEntry(entry) || (container
          ? containerCount <= minVisibleCount
          : getActivityMs != null && getActivityMs(entry) >= nowMs - recentWindowMs);
      });
  const hiddenCount = entries.length - visibleEntries.length;
  return {
    visibleEntries,
    isOverflowing: hiddenCount > 0,
    totalCount: entries.length,
    hiddenCount,
  };
}
