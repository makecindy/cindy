/**
 * 右栏面板是否「就绪到可以据此调整窗口宽度」。
 *
 * 任务语境必须等该任务的开合存档读进来：窗口刚起来时还没读到记忆，这时把展开当成
 * 用户开栏会把窗口拉宽（bootstrap 门）。无任务语境的全局具名页（`/plugins` 等）没有
 * 存档可等，出现即就绪 —— 否则直接从这里打开全局视图永远走未就绪分支，只压缩内容区。
 *
 * 关掉最后一个全局页签时 `globalViewAvailable` 会先变 false：这时面板已被间接收起
 * （见 MainLayout 的 `handleRightSidebarEmptied`），不能按「离开就绪区间」去收窄窗口。
 */
export interface RightSidebarReadiness {
  /** main 已返回分离/打开状态，且内置 Shell 已装载。 */
  windowLoaded: boolean;
  /** 侧栏正在独立窗口里。 */
  detached: boolean;
  /** 当前路由视图声明了任务侧栏（全屏聊天视图在场）。 */
  taskSidebarAvailable: boolean;
  /** 该任务记住的开合状态已读入。 */
  tabsRestored: boolean;
  /** 无任务语境下仍可用的全局具名页。 */
  globalViewAvailable: boolean;
}

export function rightSidebarExpansionReady(ready: RightSidebarReadiness): boolean {
  if (!ready.windowLoaded || ready.detached) return false;
  return ready.taskSidebarAvailable ? ready.tabsRestored : ready.globalViewAvailable;
}
