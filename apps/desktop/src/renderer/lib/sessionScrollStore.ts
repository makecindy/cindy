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

const store = new Map<string, SessionScrollSnapshot>();

export function saveSessionScroll(sessionId: string, snapshot: SessionScrollSnapshot): void {
  store.set(sessionId, snapshot);
}

export function readSessionScroll(sessionId: string): SessionScrollSnapshot | undefined {
  return store.get(sessionId);
}

export function clearSessionScroll(sessionId: string): void {
  store.delete(sessionId);
}
