import { createContext, useContext } from 'react';

/**
 * paneWidths —— 引擎面板宽度通道(缝即把手,宽度主权归引擎)。
 *
 * 两个 context:
 * - ContentAvailableWidthContext:仅为分割线交互 / 测试提供可用宽提示；生产布局
 *   不再逐像素发布窗口宽度，起拖时直接测量容器；
 * - PaneWidthContext:LayoutRoot 按树上 fraction 生成各面板的 CSS 响应式宽度
 *   (按 panelKind 索引;chat-main 弹性吸收剩余,不在表内)。拖动引擎分割线
 *   期间为临时值(实时跟手),松手后回落到树的持久化值。
 *
 * 面板消费方式:usePanelWidth(自己的 kind) —— 返回 null 表示引擎未接管
 * (Provider 缺失 / 自己是弹性面板),面板回落自己的旧宽度来源。
 */

export const ContentAvailableWidthContext = createContext<number | null>(null);
export const ContentAvailableWidthProvider = ContentAvailableWidthContext.Provider;

export function useContentAvailableWidth(): number | null {
  return useContext(ContentAvailableWidthContext);
}

export type PaneWidth = number | string;

export const PaneWidthContext = createContext<Record<string, PaneWidth> | null>(null);
export const PaneWidthProvider = PaneWidthContext.Provider;

/** 读取引擎为某 panelKind 计算的响应式宽度;null = 引擎未接管,面板自行回落。 */
export function usePanelWidth(kind: string): PaneWidth | null {
  const widths = useContext(PaneWidthContext);
  return widths?.[kind] ?? null;
}
