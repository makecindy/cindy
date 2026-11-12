import { useEffect, useState } from 'react';

export interface RetainedRightSidebarMountInput {
  /** 当前路由是否声明了右栏（全屏聊天视图等）。 */
  available: boolean;
  /** 右栏窗口状态（detach 偏好）是否已从 main 同步完成。 */
  loaded: boolean;
  /** 右栏是否已在独立窗口中显示（此时内嵌右栏不渲染）。 */
  detached: boolean;
}

export interface RetainedRightSidebarMount {
  /** 是否渲染内嵌右栏。 */
  mounted: boolean;
  /** 路由不声明右栏但右栏仍保持挂载时为 true：只派生强制折叠，不写入折叠偏好。 */
  forceCollapsed: boolean;
}

/**
 * 右栏一旦在场过，经过不声明右栏的路由（如无项目目录的新建页）时仍保持挂载并强制折叠：
 * 卸载 Shell 会把内置浏览器的 webview 宿主移出 DOM，销毁 Electron guest 并丢失页面内存态
 * （#6485）。detach / 窗口状态未就绪时内嵌右栏本就不渲染，在场标记随之复位，之后重新附着
 * 不会凭空挂出一个隐藏右栏。
 */
export function useRetainedRightSidebarMount({
  available,
  loaded,
  detached,
}: RetainedRightSidebarMountInput): RetainedRightSidebarMount {
  const mountable = loaded && !detached;
  const [everMounted, setEverMounted] = useState(false);
  useEffect(() => {
    if (!mountable) setEverMounted(false);
    else if (available) setEverMounted(true);
  }, [available, mountable]);

  return { mounted: mountable && (available || everMounted), forceCollapsed: !available };
}
