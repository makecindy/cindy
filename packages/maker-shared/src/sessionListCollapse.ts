export const SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT = 5;
export const SESSION_LIST_COLLAPSE_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SessionListCollapseViewInput<T> {
  entries: readonly T[];
  minVisibleCount?: number;
  showAll: boolean;
  disableCollapse: boolean;
  isFiltering: boolean;
  isActiveEntry: (entry: T) => boolean;
  hasAttentionEntry: (entry: T) => boolean;
  /** 传入(配套 getActivityMs)则启用「最近 recentWindowMs 内有活动的条目不折叠」豁免,
   *  用于会话/聊天列表;不传则纯硬性上限(如项目列表)。 */
  nowMs?: number;
  /** 最近活动豁免窗口,默认 24h(SESSION_LIST_COLLAPSE_RECENT_WINDOW_MS)。 */
  recentWindowMs?: number;
  /** 取条目最近活动时间戳(ms);传入即开启 24h 豁免。 */
  getActivityMs?: (entry: T) => number;
}

export interface SessionListCollapseView<T> {
  visibleEntries: readonly T[];
  isOverflowing: boolean;
  totalCount: number;
  hiddenCount: number;
}

export function getSessionListCollapseView<T>({
  entries,
  minVisibleCount = SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT,
  recentWindowMs = SESSION_LIST_COLLAPSE_RECENT_WINDOW_MS,
  nowMs,
  getActivityMs,
  showAll,
  disableCollapse,
  isFiltering,
  isActiveEntry,
  hasAttentionEntry,
}: SessionListCollapseViewInput<T>): SessionListCollapseView<T> {
  const totalCount = entries.length;
  const allVisible = {
    visibleEntries: entries,
    isOverflowing: false,
    totalCount,
    hiddenCount: 0,
  };

  if (showAll || disableCollapse || isFiltering) return allVisible;

  // 折叠规则(用户定稿):默认只显示前 N 条;但**传了 getActivityMs 的列表**(会话/聊天)
  // 额外豁免「最近 recentWindowMs(默认 24h)内有活动」的条目 —— 今天碰过的聊天不收。
  // 不传 getActivityMs 的调用方(如项目列表)走纯硬性上限。另两个安全例外:
  //   1. 需关注(完成/等待/出错)的条目始终显示,避免把"等你处理"的结果藏起来;
  //   2. 当前打开的会话若落在折叠区(罕见),整段展开,避免正在看的会话被收起。
  // 注:当天会话很多的重度用户,24h 豁免会让会话列表几乎不折叠 —— 有意取舍(用户要求今天的不藏)。
  const visibleHeadCount = Math.max(0, Math.round(minVisibleCount));
  const recentSinceMs =
    getActivityMs && typeof nowMs === 'number' && Number.isFinite(nowMs)
      ? nowMs - Math.max(0, recentWindowMs)
      : Infinity;
  const isEntryVisible = (entry: T, index: number): boolean =>
    index < visibleHeadCount ||
    (getActivityMs ? getActivityMs(entry) >= recentSinceMs : false) ||
    hasAttentionEntry(entry);

  const activeInCollapsedRegion = entries.some(
    (entry, index) => isActiveEntry(entry) && !isEntryVisible(entry, index),
  );
  if (activeInCollapsedRegion) return allVisible;

  const visibleEntries = entries.filter(isEntryVisible);
  const hiddenCount = totalCount - visibleEntries.length;

  return {
    visibleEntries,
    isOverflowing: hiddenCount > 0,
    totalCount,
    hiddenCount,
  };
}
