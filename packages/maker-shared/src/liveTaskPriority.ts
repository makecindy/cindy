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
 * Sections follow whose turn it is. Reading never settles an ordinary task. A task bound to an
 * active automation (any kind; 2026-11-18 user decision, replacing PR follow-ups only) stays in
 * working while nothing is left for the user: completing it there only marks the round read, so
 * its worktree is not recycled and rebuilt every round. Unread results (including notified
 * automation runs) and pending replies return it to inbox.
 * A teammate's task is listed only while it needs the user (a question, a permission or an
 * error: Pending) or runs (Working); otherwise it stays with the teammate and the inbox
 * leaves it out (null), so idle teammate tasks never pile up (2026-11-18 user decision).
 * Tasks the user completed or snoozed keep those sections.
 */
export function taskInboxSection(
  task: TaskInboxState,
  signals: Pick<LiveTaskPrioritySignals, 'waiting' | 'running'> & {
    unread?: boolean;
    following?: boolean;
    /** The task belongs to a teammate (the same test as the task list's teammate filter). */
    teammate?: boolean;
  },
  nowMs: number,
): TaskInboxSection | null {
  if (task.status === 'archived') return 'archived';
  if (taskSnoozeUntil(task) > nowMs) return 'snoozed';
  if (signals.waiting) return 'inbox';
  if (signals.running) return 'working';
  if (signals.teammate) return null;
  if (signals.following && !signals.unread) return 'working';
  return 'inbox';
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

/** Reserved ISO value so older inbox clients still classify the task as snoozed. */
export const INDEFINITE_SNOOZE_UNTIL = '9999-12-31T23:59:59.999Z';

/** A new input (including an automation trigger) returns the task to its live section. */
export function taskSnoozeUntil(task: TaskInboxState): number {
  const until = Date.parse(task.snoozedUntil ?? '');
  const at = Date.parse(task.snoozedAt ?? '');
  const sent = Date.parse(task.userSendAt ?? '');
  if (!Number.isFinite(until) || (Number.isFinite(at) && sent > at)) return 0;
  return task.snoozedUntil === INDEFINITE_SNOOZE_UNTIL ? Infinity : until;
}
