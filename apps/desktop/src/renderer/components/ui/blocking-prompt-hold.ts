import { createContext, useContext, useState } from 'react';

/**
 * 全局阻断提示(`confirm({ blocking: true })`,如登录过期)是否有项在显示或退场中。
 * 由 ConfirmDialogProvider 提供给它包住的界面;provider 自己的两个确认槽位不在其内。
 * 不在 provider 下渲染时为 false。
 */
export const BlockingPromptActiveContext = createContext(false);

/**
 * 阻断提示期间暂缓新打开的弹层:返回实际要用的 open。
 *
 * Radix 按挂载顺序而不是 zIndex 决定焦点、Esc 与外部点击归谁。阻断提示打开后才挂载的
 * 弹层虽然画在它下面,却会抢走焦点、吃掉 Esc,并让阻断提示的按钮点不到。所以阻断期间
 * 新变为 open 的弹层先不挂载,阻断提示全部关闭(含退场)后再显示;阻断提示打开前已在
 * 显示的弹层先挂载,不受影响,原地保留在它下面。
 */
export function useHeldWhileBlockingPrompt(open: boolean): boolean {
  const blockingActive = useContext(BlockingPromptActiveContext);
  const [shown, setShown] = useState(() => open && !blockingActive);
  const next = open && (shown || !blockingActive);
  // 依上一次渲染派生状态(React 推荐的渲染期 setState 写法),不经 effect,避免先挂载再撤下。
  if (next !== shown) setShown(next);
  return next;
}
