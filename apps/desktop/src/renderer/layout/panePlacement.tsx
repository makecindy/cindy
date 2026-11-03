import { createContext, useContext } from 'react';

/**
 * 布局树给 pane 的容器适配信号。
 *
 * 根级横排沿用既有像素宽度通道；进入插件 grid 的纵向列后，面板必须填满父格，
 * 不能继续拿 manifest 的固定宽度，否则会在列内留下空白或溢出。
 */
const PaneFillContext = createContext(false);
const PaneAtWindowTopContext = createContext(true);
const PaneAtWindowLeftContext = createContext(true);

export const PaneFillProvider = PaneFillContext.Provider;
export const PaneAtWindowTopProvider = PaneAtWindowTopContext.Provider;
export const PaneAtWindowLeftProvider = PaneAtWindowLeftContext.Provider;

export function usePaneFill(): boolean {
  return useContext(PaneFillContext);
}

/** 当前 pane 的可见内容是否贴着主窗口顶边，用于决定是否保留窗口 chrome 拖拽带。 */
export function usePaneAtWindowTop(): boolean {
  return useContext(PaneAtWindowTopContext);
}

/**
 * 当前 pane 是否贴着内容区左边(左栏收起 / rail 时即窗口左上角):mac 的红绿灯与
 * ChromeActions 浮在那里,贴着的面板顶栏要给它们让位。
 */
export function usePaneAtWindowLeft(): boolean {
  return useContext(PaneAtWindowLeftContext);
}
