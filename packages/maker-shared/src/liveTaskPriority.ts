/**
 * 侧栏 / 首页「按优先级」与灵动岛活任务共用的档位。
 *
 * waiting(等你处理,含出错) > unread(完成未读) > running > rest。
 * 数字越小越靠前,对齐 Codex 侧栏(waiting:0 / unread:1 / active:2 / idle:3)。
 *
 * 灵动岛不展示 rest;它自己的短暂置顶 / 展开钉住顺序叠在这把尺子外面。
 */

export const LIVE_TASK_PRIORITY = {
  waiting: 0,
  unread: 1,
  running: 2,
  rest: 3,
} as const;

export type LiveTaskPriorityRank = (typeof LIVE_TASK_PRIORITY)[keyof typeof LIVE_TASK_PRIORITY];

export interface LiveTaskPrioritySignals {
  waiting: boolean;
  unread: boolean;
  running: boolean;
}

export function liveTaskPriorityRank(signals: LiveTaskPrioritySignals): LiveTaskPriorityRank {
  if (signals.waiting) return LIVE_TASK_PRIORITY.waiting;
  if (signals.unread) return LIVE_TASK_PRIORITY.unread;
  if (signals.running) return LIVE_TASK_PRIORITY.running;
  return LIVE_TASK_PRIORITY.rest;
}
