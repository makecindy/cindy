/**
 * 侧栏 / 首页「按优先级」与灵动岛活任务共用的档位。
 *
 * waiting(等你处理,含出错) > unread(完成未读) > running > rest。
 * 同一任务同时有旧完成未读和当前轮 running 时按 running:当前轮状态优先,
 * 避免任务视觉上已经运行中、排序却仍占着上一轮 unread 档。
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
  if (signals.unread && !signals.running) return LIVE_TASK_PRIORITY.unread;
  if (signals.running) return LIVE_TASK_PRIORITY.running;
  return LIVE_TASK_PRIORITY.rest;
}


export type TaskInboxSection = 'inbox' | 'working' | 'snoozed' | 'archived';

export interface TaskInboxState {
  status?: string;
  snoozedUntil?: string | null;
  snoozedAt?: string | null;
  userSendAt?: string | null;
}

/**
 * Sections follow whose turn it is. Reading never settles an ordinary task; an active
 * follow-up only keeps the task working while nothing is left for the user. Unread
 * results (including notified automation runs) and pending replies return it to inbox.
 * Pass signals from the viewed-priority rank so the open task stays put until left.
 */
export function taskInboxSection(
  task: TaskInboxState,
  signals: Pick<LiveTaskPrioritySignals, 'waiting' | 'running'> & {
    unread?: boolean;
    following?: boolean;
  },
  nowMs: number,
): TaskInboxSection {
  if (task.status === 'archived') return 'archived';
  if (taskSnoozeUntil(task) > nowMs) return 'snoozed';
  if (signals.waiting) return 'inbox';
  if (signals.running) return 'working';
  if (signals.following && !signals.unread) return 'working';
  return 'inbox';
}

/**
 * Only PR follow-ups put a quiet task in working. It is the host's existing PR-follow
 * contract (prFollowWatch): a configured pre-run check that names a PR / MR URL.
 * Routine automations bound to a task are ordinary tasks for the inbox.
 */
export function scheduleFollowsPr(schedule: { preRunHook?: { command?: string } | null }): boolean {
  const command = schedule.preRunHook?.command ?? '';
  return /https?:\/\/[^\s'"]+\/(?:pull|-\/merge_requests)\/[1-9]\d*(?![0-9])/i.test(command);
}

/**
 * Signals for taskInboxSection. The viewed task keeps a held unread / waiting rank until the
 * user leaves it, but running always comes from the natural rank: a task that finishes while
 * open must leave working at once instead of staying there until another task is opened.
 */
export function taskInboxSignalsFromRank(
  viewedRank: number,
  naturalRank: number,
): Pick<LiveTaskPrioritySignals, 'waiting' | 'unread' | 'running'> {
  return {
    waiting: viewedRank === LIVE_TASK_PRIORITY.waiting,
    unread: viewedRank === LIVE_TASK_PRIORITY.unread,
    running: naturalRank === LIVE_TASK_PRIORITY.running,
  };
}

/** A new input (including an automation trigger) returns the task to its live section. */
export function taskSnoozeUntil(task: TaskInboxState): number {
  const until = Date.parse(task.snoozedUntil ?? '');
  const at = Date.parse(task.snoozedAt ?? '');
  const sent = Date.parse(task.userSendAt ?? '');
  if (!Number.isFinite(until) || (Number.isFinite(at) && sent > at)) return 0;
  return until;
}
