/**
 * messageNavRailWheel
 * ---------------------------------------------------------------------------
 * 悬停刻度带时的滚轮转发(MessageNavRail 专用,无 DOM 依赖,node 环境直接单测)。
 *
 * 导航条是聊天滚动容器的**兄弟 overlay**(设计上不能做它的子元素:刻度要钉在
 * 容器左缘留白处、还不能挡住从留白起手的文字划选);刻度按钮自身
 * pointer-events-auto,悬停时 wheel 事件的目标落在按钮上,冒泡路径不经过滚动
 * 容器,浏览器不会替我们滚聊天区 —— 悬停刻度带时对话滚不动(PR #830 review)。
 * 这里把 wheel 增量原样转发成滚动容器的真实位移,补上这条缺口。
 *
 * 分工:本模块只负责**位移**;root 上既有 wheel 监听承载的**滚动意图**信号
 * (贴底跟随解锚 / 顶部意图补页 / chip 抑制解除 / 乐观 pending 放弃)由组件侧
 * 向滚动容器重派合成 wheel 事件触发(DOM 依赖,不进本模块),见
 * MessageNavRail.tsx 的 handleRailWheel。
 *
 * 不做 deltaMode 行/页换算:桌面端跑在 Electron(Chromium)里,
 * WheelEvent.deltaMode 恒为 DOM_DELTA_PIXEL。
 */

export interface NavRailWheelDelta {
  deltaX: number;
  deltaY: number;
}

export function forwardNavRailWheel(
  scroller: { scrollBy: (options: ScrollToOptions) => void } | null,
  delta: NavRailWheelDelta,
): void {
  if (!scroller) return;
  scroller.scrollBy({ left: delta.deltaX, top: delta.deltaY });
}
