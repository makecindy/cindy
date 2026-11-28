// 折叠算法本体已上移到 @cindy/maker-shared(桌面侧栏与手机版首页共用同一套
// 「前 N 条 + 24h 活动 / 需关注豁免」策略,单侧改动会破坏两端一致性)。
// 本文件保留为 re-export,维持桌面既有 import 路径稳定。
import {
  getSessionListCollapseView,
  SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT,
  type SessionListCollapseView,
  type SessionListCollapseViewInput,
} from '@cindy/maker-shared/session-list-collapse';
import { SIDEBAR_INACTIVE_COLLAPSE_MS } from './sidebarCollapseConfig';

export {
  SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT,
  SESSION_LIST_COLLAPSE_RECENT_WINDOW_MS,
  getSessionListCollapseView,
  type SessionListCollapseView,
  type SessionListCollapseViewInput,
} from '@cindy/maker-shared/session-list-collapse';

/** 桌面「闲置收起」偏好:关闭走共享策略;开启后普通任务无数量保底,只有容器占前 N 名额,当前条目只保留自身。 */
export function getSidebarSessionCollapseView<T>({
  idleCollapseEnabled = false,
  isContainerEntry,
  ...input
}: SessionListCollapseViewInput<T> & {
  idleCollapseEnabled?: boolean;
  isContainerEntry?: (entry: T) => boolean;
}): SessionListCollapseView<T> {
  if (!idleCollapseEnabled) return getSessionListCollapseView(input);

  const {
    entries,
    minVisibleCount = SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT,
    recentWindowMs = SIDEBAR_INACTIVE_COLLAPSE_MS,
    nowMs = Date.now(),
    getActivityMs,
  } = input;
  const totalCount = entries.length;
  if (input.showAll || input.disableCollapse || input.isFiltering) {
    return { visibleEntries: entries, isOverflowing: false, totalCount, hiddenCount: 0 };
  }

  const containerHeadCount = isContainerEntry ? Math.max(0, Math.round(minVisibleCount)) : 0;
  const recentSinceMs = Number.isFinite(nowMs) ? nowMs - Math.max(0, recentWindowMs) : Infinity;
  let containerCount = 0;
  const visibleEntries = entries.filter((entry) => {
    const isContainer = isContainerEntry?.(entry) ?? false;
    const keep = isContainer
      ? containerCount++ < containerHeadCount
      : getActivityMs != null && getActivityMs(entry) >= recentSinceMs;
    return keep || input.hasAttentionEntry(entry) || input.isActiveEntry(entry);
  });
  const hiddenCount = totalCount - visibleEntries.length;
  return { visibleEntries, isOverflowing: hiddenCount > 0, totalCount, hiddenCount };
}
