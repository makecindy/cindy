/**
 * sessionScrollStore — 每个会话「上次浏览位置」的内存快照表。
 * ---------------------------------------------------------------------------
 * 背景:切会话时父组件用 key={sessionId} 强制 MessageStream 整体卸载再重建,
 * 组件内部所有滚动状态归零。要支持「切回某个会话时回到上次浏览位置」,位置就
 * 不能存在组件内,得放到组件外的这张表里。
 *
 * 设计:
 *   - 纯内存 Map,只活在 app 运行期,重启清空 —— 与「来回切着看」的使用场景
 *     吻合,不必落盘(也避免持久化跨版本失效 / DOM 结构变化导致旧锚点失效)。
 *   - 锚点用 render-item 的 stable key + 该 item 顶端被滚到视口上方的像素偏移,
 *     而非绝对 scrollTop —— 绝对值在图片 / markdown 异步加载改变上方高度后会失真,
 *     按条目相对定位才稳。
 */

/** 一个会话的滚动位置快照。 */
export interface SessionScrollSnapshot {
  /** 渲染窗口起始锚点(MessageStream 的 firstVisibleItemKey)。
   *  null = 默认窗口(末尾若干 item);非 null = 用户曾向上扩窗到更早的位置,
   *  还原时需要先把窗口重建到这里,viewportTopKey 才会落在窗口内。 */
  windowAnchorKey: string | null;
  /** 离开时视口顶端那条 render-item 的 stable key。 */
  viewportTopKey: string;
  /** viewportTopKey 这条 item 的顶端被滚到视口上方的像素数(>=0)。 */
  offset: number;
  /** 离开时是否贴在底部。true 时不需要还原,重建后正常 pin 到底即可。 */
  isNearBottom: boolean;
  /**
   * render-window-bidirectional: 锚定窗口的向后 item 上界。
   * 仅在 windowAnchorKey !== null 时写入；null 表示旧版快照（无此字段）或默认窗口。
   * 还原时用于重建足够大的窗口，确保 viewportTopKey 落在 DOM 中。
   */
  anchoredForwardCount?: number;
}

interface SessionViewMemory {
  scroll?: SessionScrollSnapshot;
  /**
   * 当前缓存消息窗口是否已经成功完成过一轮自动历史补载。
   *
   * 这里只记 completed,不记精确轮数:一次 mount 可能只拉 1 页就撑满视口,
   * 离开时消息缓存又会裁掉刚补进来的前缀。若下次 mount 从 1/5 继续算,
   * 仍会把同一页历史重新拉一遍。重挂载时应把自动预算整体视作已用完;
   * 用户明确上滑 / 翻页的加载路径不读取这个标记,仍可继续加载。缓存窗口被
   * 整体丢弃时清除此标记,让新窗口重新获得一次自动补载预算。
   */
  automaticHistoryLoadCompleted?: true;
}

const store = new Map<string, SessionViewMemory>();

export function saveSessionScroll(sessionId: string, snapshot: SessionScrollSnapshot): void {
  const previous = store.get(sessionId);
  store.set(sessionId, { ...previous, scroll: snapshot });
}

export function readSessionScroll(sessionId: string): SessionScrollSnapshot | undefined {
  return store.get(sessionId)?.scroll;
}

/** 记录当前缓存消息窗口已经成功推进过一次自动历史补载。 */
export function markSessionAutomaticHistoryLoadCompleted(sessionId: string): void {
  const previous = store.get(sessionId);
  store.set(sessionId, { ...previous, automaticHistoryLoadCompleted: true });
}

/** 缓存消息窗口被整体重建时,恢复该会话的自动补载预算并保留滚动快照。 */
export function resetSessionAutomaticHistoryLoadCompletion(sessionId: string): void {
  const previous = store.get(sessionId);
  if (!previous?.automaticHistoryLoadCompleted) return;
  const next = { ...previous };
  delete next.automaticHistoryLoadCompleted;
  if (next.scroll) store.set(sessionId, next);
  else store.delete(sessionId);
}

/**
 * 为一次新的 MessageStream mount 恢复自动补载计数。
 * 当前缓存窗口已经完成过补载时直接返回上限,避免切走再切回后重启同一轮补载。
 */
export function restoreSessionAutomaticHistoryLoadAttempts(
  sessionId: string | null | undefined,
  maxAttempts: number,
): number {
  if (!sessionId) return 0;
  return store.get(sessionId)?.automaticHistoryLoadCompleted ? maxAttempts : 0;
}

export function clearSessionScroll(sessionId: string): void {
  store.delete(sessionId);
}
