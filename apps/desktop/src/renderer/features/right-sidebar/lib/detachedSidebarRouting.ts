/** RSB command 的共享 renderer 路由边界；宿主裁决权在 main。 */

import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import type {
  RsbWindowCommand,
  RsbWindowCommandRouteResult,
} from '../../../../shared/rightSidebarWindow';

/**
 * 主窗口在 detached 偏好下把 tab 动作交给子窗口 renderer；子窗口自身和 attached
 * 形态返回 false，由调用方操作本地 store。sendCommand 会按需打开并等待子窗 ready。
 */
export interface DetachedSidebarRouteOptions {
  /** false 时只向已打开的 detached 窗口发命令，不因命令重新打开窗口。 */
  allowOpen?: boolean;
  /**
   * false = 程序自发的命令(插件 preview / agent 自动化):子窗口照常收内容,
   * 但 main 不得 show/focus 抢走用户前台。缺省 true(用户手势)。
   */
  userInitiated?: boolean;
}

export async function routeSidebarCommand(
  command: RsbWindowCommand,
  opts: DetachedSidebarRouteOptions = {},
): Promise<RsbWindowCommandRouteResult> {
  if (typeof window === 'undefined' || isSecondaryWindow() || isSidebarWindow()) return 'attached';
  const api = window.electronAPI?.rightSidebarWindow;
  if (!api) return 'attached';
  return api.sendCommand({
    command,
    allowOpen: opts.allowOpen !== false,
    userInitiated: opts.userInitiated !== false,
  });
}
