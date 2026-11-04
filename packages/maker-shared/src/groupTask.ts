/**
 * Group task layer for bot group chats (team sessions), issue #8863 core slice.
 *
 * Pure contract + rules only: no IO, no framework. Every rule function takes its
 * inputs as parameters (no module-level constants at runtime) so the desktop
 * opHandler can be embedded verbatim into all three DB transport paths
 * (dbWorker bundle / inproc tx / inline-worker fallback) with a single source
 * of truth. Storage lives in apps/desktop/src/main/localDb (schema + migrations).
 */

export const GROUP_TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'blocked',
  'in_review',
  'done',
  'canceled',
] as const;
export type GroupTaskStatus = (typeof GROUP_TASK_STATUSES)[number];

export const GROUP_TASK_TERMINAL_STATUSES = ['done', 'canceled'] as const;
export type GroupTaskTerminalStatus = (typeof GROUP_TASK_TERMINAL_STATUSES)[number];

export const GROUP_TASK_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type GroupTaskPriority = (typeof GROUP_TASK_PRIORITIES)[number];

export const GROUP_TASK_RUN_STATUSES = ['queued', 'running', 'settled', 'canceled'] as const;
export type GroupTaskRunStatus = (typeof GROUP_TASK_RUN_STATUSES)[number];

export const GROUP_TASK_ACCEPTANCE_ACTIONS = ['accept', 'return'] as const;
export type GroupTaskAcceptanceAction = (typeof GROUP_TASK_ACCEPTANCE_ACTIONS)[number];

/** A run can be dispatched only from a ready or working task. */
export const GROUP_TASK_DISPATCHABLE_STATUSES = ['todo', 'in_progress'] as const;

/** Dependencies gate execution, not manual state changes: dropped tasks do not block. */
export const GROUP_TASK_DEPENDENCY_SATISFIED_STATUSES: readonly GroupTaskStatus[] = [
  'done',
  'canceled',
];

/**
 * Explicit transition table. Examples from the issue: `in_review → in_progress |
 * done | canceled`, `done → todo` reopens. `canceled` is final: recreate instead.
 */
export const GROUP_TASK_TRANSITIONS: Readonly<
  Record<GroupTaskStatus, readonly GroupTaskStatus[]>
> = {
  backlog: ['todo', 'in_progress', 'canceled'],
  todo: ['backlog', 'in_progress', 'canceled'],
  in_progress: ['todo', 'blocked', 'in_review', 'done', 'canceled'],
  blocked: ['todo', 'in_progress', 'canceled'],
  in_review: ['in_progress', 'done', 'canceled'],
  done: ['todo'],
  canceled: [],
};

export const GROUP_TASK_NUMBER_PREFIX = 'PROJ';

export type GroupTaskTransitionTable = Readonly<
  Record<GroupTaskStatus, readonly GroupTaskStatus[]>
>;

export function formatGroupTaskNumber(number: number, prefix: string = GROUP_TASK_NUMBER_PREFIX): string {
  return `${prefix}-${number}`;
}

export function isGroupTaskStatusTerminal(status: GroupTaskStatus): status is GroupTaskTerminalStatus {
  return status === 'done' || status === 'canceled';
}

/** Entering a terminal state stamps its time; any other target clears both stamps. */
export function groupTaskTerminalTimestamps(
  to: GroupTaskStatus,
  now: number,
): { completedAt: number | null; canceledAt: number | null } {
  if (to === 'done') return { completedAt: now, canceledAt: null };
  if (to === 'canceled') return { completedAt: null, canceledAt: now };
  return { completedAt: null, canceledAt: null };
}

export type GroupTaskTransitionResult =
  | { ok: true; from: GroupTaskStatus; to: GroupTaskStatus; terminal: GroupTaskTerminalStatus | null }
  | { ok: false; code: 'INVALID_TRANSITION'; from: GroupTaskStatus; to: GroupTaskStatus };

export function transitionGroupTaskStatus(
  table: GroupTaskTransitionTable,
  from: GroupTaskStatus,
  to: GroupTaskStatus,
): GroupTaskTransitionResult {
  const allowed = table[from];
  if (from !== to && allowed && allowed.includes(to)) {
    return { ok: true, from, to, terminal: isGroupTaskStatusTerminal(to) ? to : null };
  }
  return { ok: false, code: 'INVALID_TRANSITION', from, to };
}

export interface GroupTaskDependencyEdge {
  taskId: string;
  dependsOnTaskId: string;
}

export type GroupTaskCycleResult =
  | { ok: true }
  | { ok: false; code: 'DEPENDENCY_CYCLE'; cycle: string[] };

/**
 * Cycle check for merging one candidate edge into the existing edge set.
 * Edges point from a task to what it waits on; a cycle is any path from the
 * candidate target back to the candidate task. Returns the cycle path for
 * display (`A -> B -> A`).
 */
export function checkGroupTaskDependencyCycle(
  edges: readonly GroupTaskDependencyEdge[],
  candidate: GroupTaskDependencyEdge,
): GroupTaskCycleResult {
  const waits = new Map<string, string[]>();
  for (const edge of edges) {
    const list = waits.get(edge.taskId);
    if (list) list.push(edge.dependsOnTaskId);
    else waits.set(edge.taskId, [edge.dependsOnTaskId]);
  }
  const start = candidate.dependsOnTaskId;
  const goal = candidate.taskId;
  const visited = new Set<string>();
  let frontier: { id: string; path: string[] }[] = [{ id: start, path: [goal, start] }];
  while (frontier.length) {
    const next: { id: string; path: string[] }[] = [];
    for (const node of frontier) {
      if (node.id === goal) return { ok: false, code: 'DEPENDENCY_CYCLE', cycle: node.path };
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      for (const dep of waits.get(node.id) ?? []) {
        next.push({ id: dep, path: [...node.path, dep] });
      }
    }
    frontier = next;
  }
  return { ok: true };
}

export interface GroupTaskDependencyRef {
  taskId: string;
  /** null = dangling reference; dangling deps are ignored, never blockers. */
  status: GroupTaskStatus | null;
}

/** Only the deps still in the way: missing or settled (`done`/`canceled`) deps are not blockers. */
export function groupTaskDependencyBlockers(
  refs: readonly GroupTaskDependencyRef[],
  satisfied: readonly GroupTaskStatus[] = GROUP_TASK_DEPENDENCY_SATISFIED_STATUSES,
): { taskId: string; status: GroupTaskStatus }[] {
  const blockers: { taskId: string; status: GroupTaskStatus }[] = [];
  for (const ref of refs) {
    if (ref.status && !satisfied.includes(ref.status)) blockers.push({ taskId: ref.taskId, status: ref.status });
  }
  return blockers;
}

export type GroupTaskAcceptanceCheck =
  | { ok: true }
  | { ok: false; code: 'NOT_IN_REVIEW' | 'REASON_REQUIRED' };

/**
 * `accept` (→ done) and `return` (back to the executor, reason required) both
 * operate on the `in_review` kanban state only.
 */
export function validateGroupTaskAcceptance(
  status: GroupTaskStatus,
  action: GroupTaskAcceptanceAction,
  reason?: string,
): GroupTaskAcceptanceCheck {
  if (status !== 'in_review') return { ok: false, code: 'NOT_IN_REVIEW' };
  if (action === 'return' && (typeof reason !== 'string' || !reason.trim()))
    return { ok: false, code: 'REASON_REQUIRED' };
  return { ok: true };
}

/** Verdicts only count for the delivery they reviewed: a new delivery supersedes older ones. */
export function isGroupTaskVerdictCurrent(verdictDeliverySeq: number, taskDeliverySeq: number): boolean {
  return verdictDeliverySeq === taskDeliverySeq;
}

export type GroupTaskDispatchCheck =
  | { ok: true }
  | { ok: false; code: 'NOT_DISPATCHABLE' | 'ACTIVE_RUN_EXISTS' };

/** At most one active (queued/running) execution per task; re-dispatch needs an explicit replace. */
export function validateGroupTaskDispatch(
  status: GroupTaskStatus,
  activeRunCount: number,
  dispatchable: readonly GroupTaskStatus[] = GROUP_TASK_DISPATCHABLE_STATUSES,
): GroupTaskDispatchCheck {
  if (!dispatchable.includes(status)) return { ok: false, code: 'NOT_DISPATCHABLE' };
  if (activeRunCount > 0) return { ok: false, code: 'ACTIVE_RUN_EXISTS' };
  return { ok: true };
}

export interface GroupTaskRecord {
  id: string;
  groupId: string;
  /** Per-group auto-increment; display key is `PROJ-<number>`. */
  number: number;
  title: string;
  description: string;
  status: GroupTaskStatus;
  priority: GroupTaskPriority;
  assigneeId: string | null;
  createdBy: string;
  parentTaskId: string | null;
  sortOrder: number;
  dueAt: number | null;
  estimateHours: number | null;
  labels: string[];
  /** Bumped every time the task enters `in_review`; verdicts are scoped to it. */
  deliverySeq: number;
  revision: number;
  completedAt: number | null;
  canceledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface GroupTaskRunRecord {
  id: string;
  taskId: string;
  assigneeId: string;
  status: GroupTaskRunStatus;
  dispatchedAt: number;
  startedAt: number | null;
  settledAt: number | null;
  outcome: string | null;
}

export interface GroupTaskCommentRecord {
  id: string;
  taskId: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface GroupTaskDependencyRecord {
  taskId: string;
  dependsOnTaskId: string;
  createdAt: number;
}

export interface GroupTaskAcceptanceRecord {
  id: string;
  taskId: string;
  deliverySeq: number;
  action: GroupTaskAcceptanceAction;
  reason: string;
  reviewer: string;
  createdAt: number;
}

export interface GroupTaskDetail {
  task: GroupTaskRecord;
  comments: GroupTaskCommentRecord[];
  dependencies: GroupTaskDependencyRecord[];
  blockers: { taskId: string; status: GroupTaskStatus }[];
  runs: GroupTaskRunRecord[];
  /** Acceptance verdicts for the current delivery only. */
  verdicts: GroupTaskAcceptanceRecord[];
}

export interface GroupTaskResult {
  tasks: GroupTaskRecord[];
  detail: GroupTaskDetail | null;
}

export type GroupTaskRequest =
  | { action: 'list'; groupId: string }
  | { action: 'get'; taskId: string }
  | {
      action: 'create';
      groupId: string;
      title: string;
      description?: string;
      priority?: GroupTaskPriority;
      assigneeId?: string;
      createdBy?: string;
      parentTaskId?: string;
      dueAt?: number;
      estimateHours?: number;
      labels?: string[];
      newId: string;
      now?: number;
    }
  | {
      action: 'update';
      taskId: string;
      revision: number;
      title?: string;
      description?: string;
      priority?: GroupTaskPriority;
      assigneeId?: string | null;
      sortOrder?: number;
      dueAt?: number | null;
      estimateHours?: number | null;
      labels?: string[];
    }
  | { action: 'transition'; taskId: string; revision: number; to: GroupTaskStatus; actor?: string }
  | {
      action: 'dispatch';
      taskId: string;
      assigneeId: string;
      /** 改派 / 重试是同一动作：true cancels the active run first (audit trail kept). */
      replace?: boolean;
      runId: string;
      now?: number;
    }
  | {
      action: 'runSetStatus';
      runId: string;
      status: Exclude<GroupTaskRunStatus, 'queued'>;
      outcome?: string;
      now?: number;
    }
  | { action: 'comment'; taskId: string; body: string; author?: string; commentId: string }
  | { action: 'addDependency'; taskId: string; dependsOnTaskId: string }
  | { action: 'removeDependency'; taskId: string; dependsOnTaskId: string }
  | { action: 'accept'; taskId: string; revision: number; reviewer?: string; now?: number }
  | { action: 'return'; taskId: string; revision: number; reason: string; reviewer?: string; now?: number };
