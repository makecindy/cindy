/**
 * 侧栏「按优先级」与灵动岛活任务共用的档位。
 *
 * 正本在 @cindy/maker-shared,桌面与手机共用同一把尺子。本文件只做兼容再导出,
 * 避免桌面存量 import 路径跟着搬家。
 */

export {
  LIVE_TASK_PRIORITY,
  liveTaskPriorityRank,
  type LiveTaskPriorityRank,
  type LiveTaskPrioritySignals,
} from '@cindy/maker-shared/live-task-priority';
