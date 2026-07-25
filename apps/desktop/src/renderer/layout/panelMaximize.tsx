import { createContext, useContext } from 'react';

/**
 * PanelMaximizeContext —— 停靠面板「撑满内容区」的引擎级视图态。
 *
 * 语义与边界(2026-07-25 首版):
 * - 这是**视图态而非布局树变换**:maximized 期间树数据(fraction / 顺序)一字
 *   不动,还原即回原样 —— 不触碰 architecture-invariants 的树结构不变量;
 *   chat-main 仅被视觉收起(0 宽裁切,保持挂载),与 RSB maximize 隐藏主区的
 *   既有先例同一档语义。
 * - 会话级瞬时态,不持久化:重启回到常规布局(撑满是"临时看大图"式的查看态)。
 * - 状态由 LayoutRoot 持有并下发;标准头(PanelChrome)凭 panelKind 消费,
 *   面板作者无感 —— 系统按钮由引擎统一长出,不进面板自绘区。
 */
export interface PanelMaximizeState {
  /** 当前撑满的面板 kind;null = 常规布局。 */
  maximizedKind: string | null;
  /** 切换某面板的撑满态(同 kind 再点 = 还原)。 */
  toggle: (kind: string) => void;
}

export const PanelMaximizeContext = createContext<PanelMaximizeState | null>(null);

/** 面板侧消费入口;LayoutRoot 之外(如测试单渲组件)拿到 null,按钮不渲染。 */
export function usePanelMaximize(): PanelMaximizeState | null {
  return useContext(PanelMaximizeContext);
}
