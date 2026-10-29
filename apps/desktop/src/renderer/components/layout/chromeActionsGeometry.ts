/**
 * ChromeActions 与各窗口 drag region 后代挖洞共用的几何约束。
 *
 * Electron 只会可靠识别 drag 元素后代上的 no-drag 区域，因此浮层按钮的位置和
 * 底层挖洞必须引用同一组数值，不能在 Sidebar / ContentHeader / RightSidebar 中
 * 各自维护魔法数。
 */
export const CHROME_ACTIONS_GEOMETRY = {
  /** Windows 与 macOS 全屏时，按钮簇距离窗口左边缘的距离。 */
  defaultLeft: 8,
  /** macOS 非全屏时，按钮簇为红绿灯预留空间后的左偏移。 */
  macTrafficLightLeft: 78,
  /**
   * 四个 28px 按钮加 4px 间距的总宽度：折叠、菜单、浏览历史后退与前进。
   * 加删按钮时同步改这里，挖洞与占位都跟着它。
   */
  clusterWidth: 124,
} as const;

/** macOS 非全屏时浮动按钮簇的右缘（窗口坐标）。 */
export const CHROME_ACTIONS_MAC_RIGHT_EDGE =
  CHROME_ACTIONS_GEOMETRY.macTrafficLightLeft + CHROME_ACTIONS_GEOMETRY.clusterWidth;

/**
 * 左侧面板顶栏必须为浮动按钮簇补挖的 no-drag 宽度。
 *
 * 按钮簇钉死在窗口左上（mac 非全屏 x=78），而面板顶栏里的洞会被面板自己的
 * overflow-hidden 按面板宽度裁掉。面板宽度小于簇右缘时（如侧栏拖到 180 的展开
 * 最小宽），簇的右半截就悬在右侧顶栏的拖拽区上 —— 点前进会被当成拖窗口。这里
 * 算出「超出面板右缘的那一截」，由右侧顶栏补挖；面板够宽（>= 簇右缘）或簇整个
 * 落在面板外（rail 宽 78）时退回边界值。
 */
export function chromeActionsHitHoleWidth(panelRightEdge: number): number {
  const overflow = CHROME_ACTIONS_MAC_RIGHT_EDGE - panelRightEdge;
  return Math.min(CHROME_ACTIONS_GEOMETRY.clusterWidth, Math.max(0, overflow));
}
