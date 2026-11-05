import type Database from 'better-sqlite3';
import type {
  GroupTaskAcceptanceAction,
  GroupTaskAcceptanceRecord,
  GroupTaskCommentRecord,
  GroupTaskDependencyRecord,
  GroupTaskDetail,
  GroupTaskPriority,
  GroupTaskRequest,
  GroupTaskResult,
  GroupTaskRunRecord,
  GroupTaskStatus,
} from '@cindy/maker-shared/group-task';
import {
  GROUP_TASK_DEPENDENCY_SATISFIED_STATUSES,
  GROUP_TASK_DISPATCHABLE_STATUSES,
  GROUP_TASK_PRIORITIES,
  GROUP_TASK_STATUSES,
  GROUP_TASK_TRANSITIONS,
  checkGroupTaskDependencyCycle,
  groupTaskDependencyBlockers,
  groupTaskTerminalTimestamps,
  transitionGroupTaskStatus,
  validateGroupTaskAcceptance,
  validateGroupTaskDispatch,
} from '@cindy/maker-shared/group-task';

/**
 * Group task layer for bot group chats (issue #8863 core slice).
 * Self-contained so the legacy inline worker can embed the same implementation:
 * every rule comes from the pure helpers imported above, which the transports
 * embed alongside this function (see WorkerThreadTransport WORKER_CODE).
 */
export function runGroupTasksTransaction(db: Database.Database, raw: unknown): GroupTaskResult {
  const fail = (code: string, detail?: string): never => {
    throw new Error(
      detail
        ? `[${code}] Group task operation failed: ${detail}`
        : `[${code}] Group task operation failed`,
    );
  };
  const TITLE_MAX = 200;
  const DESCRIPTION_MAX = 10000;
  const COMMENT_MAX = 4000;
  const REASON_MAX = 2000;
  const OUTCOME_MAX = 2000;
  const ID_MAX = 128;
  const NAME_MAX = 128;
  const LABELS_MAX = 20;
  const LABEL_MAX = 64;
  const RUN_TARGET_STATUSES = ['running', 'settled', 'canceled'];
  const text = (value: unknown, max: number): string => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
      return fail('INVALID_PARAMS');
    return value.trim();
  };
  const optText = (value: unknown, max: number): string | undefined => {
    if (value === undefined) return undefined;
    return text(value, max);
  };
  /**
   * Description accepts an explicit empty string (clearing) but rejects
   * blank-only text; the length cap stays identical to `text`.
   */
  const descText = (value: unknown, max: number): string => {
    if (typeof value !== 'string') return fail('INVALID_PARAMS');
    if (value === '') return '';
    return text(value, max);
  };
  const optNumber = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) return fail('INVALID_PARAMS');
    return value;
  };
  const parseLabels = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > LABELS_MAX) return fail('LIMIT_EXCEEDED');
    return value.map((item) => text(item, LABEL_MAX));
  };
  const readLabels = (json: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(json);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  };
  const nowOf = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
  interface GroupTaskRow {
    id: string;
    group_id: string;
    number: number;
    title: string;
    description: string;
    status: string;
    priority: string;
    assignee_id: string | null;
    created_by: string;
    parent_task_id: string | null;
    sort_order: number;
    due_at: number | null;
    estimate_hours: number | null;
    labels_json: string;
    delivery_seq: number;
    revision: number;
    completed_at: number | null;
    canceled_at: number | null;
    created_at: number;
    updated_at: number;
  }
  interface RunRow {
    id: string;
    task_id: string;
    assignee_id: string;
    status: string;
    dispatched_at: number;
    started_at: number | null;
    settled_at: number | null;
    outcome: string | null;
  }
  interface VerdictRow {
    id: string;
    task_id: string;
    delivery_seq: number;
    action: string;
    reason: string;
    reviewer: string;
    created_at: number;
  }
  const mapTask = (row: GroupTaskRow) => ({
    id: row.id,
    groupId: row.group_id,
    number: row.number,
    title: row.title,
    description: row.description,
    status: row.status as GroupTaskStatus,
    priority: row.priority as GroupTaskPriority,
    assigneeId: row.assignee_id,
    createdBy: row.created_by,
    parentTaskId: row.parent_task_id,
    sortOrder: row.sort_order,
    dueAt: row.due_at,
    estimateHours: row.estimate_hours,
    labels: readLabels(row.labels_json),
    deliverySeq: row.delivery_seq,
    revision: row.revision,
    completedAt: row.completed_at,
    canceledAt: row.canceled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const mapRun = (row: RunRow): GroupTaskRunRecord => ({
    id: row.id,
    taskId: row.task_id,
    assigneeId: row.assignee_id,
    status: row.status as GroupTaskRunRecord['status'],
    dispatchedAt: row.dispatched_at,
    startedAt: row.started_at,
    settledAt: row.settled_at,
    outcome: row.outcome,
  });
  const mapVerdict = (row: VerdictRow): GroupTaskAcceptanceRecord => ({
    id: row.id,
    taskId: row.task_id,
    deliverySeq: row.delivery_seq,
    action: row.action as GroupTaskAcceptanceAction,
    reason: row.reason,
    reviewer: row.reviewer,
    createdAt: row.created_at,
  });
  const taskRow = (id: string): GroupTaskRow => {
    const row = db.prepare('SELECT * FROM group_tasks WHERE id=?').get(id) as GroupTaskRow | undefined;
    if (!row) return fail('NOT_FOUND');
    return row;
  };
  const statusOfOrNull = (id: string): GroupTaskStatus | null => {
    const row = db.prepare('SELECT status FROM group_tasks WHERE id=?').get(id) as
      | { status: string }
      | undefined;
    if (!row || !(GROUP_TASK_STATUSES as readonly string[]).includes(row.status)) return null;
    return row.status as GroupTaskStatus;
  };
  const listTasks = (groupId: string) =>
    db
      .prepare('SELECT * FROM group_tasks WHERE group_id=? ORDER BY number,id')
      .all(groupId)
      .map((row) => mapTask(row as GroupTaskRow));
  const activeRunCount = (taskId: string): number =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM group_task_runs WHERE task_id=? AND status IN ('queued','running')",
        )
        .get(taskId) as { n: number }
    ).n;
  const cancelQueuedRuns = (taskId: string, now: number) => {
    db.prepare(
      "UPDATE group_task_runs SET status='canceled', settled_at=? WHERE task_id=? AND status='queued'",
    ).run(now, taskId);
  };
  const requireGroup = (groupId: string) => {
    if (!db.prepare('SELECT id FROM bot_groups WHERE id=?').get(groupId)) return fail('NOT_FOUND');
  };
  const requireRevision = (current: number, expected: unknown) => {
    if (expected !== current) return fail('CONFLICT');
  };
  const requireTaskStatus = (value: unknown): GroupTaskStatus => {
    if (typeof value !== 'string' || !(GROUP_TASK_STATUSES as readonly string[]).includes(value))
      return fail('INVALID_PARAMS');
    return value as GroupTaskStatus;
  };
  const requireRunTarget = (value: unknown): string => {
    if (typeof value !== 'string' || !RUN_TARGET_STATUSES.includes(value)) return fail('INVALID_PARAMS');
    return value;
  };
  const requirePriority = (value: unknown): GroupTaskPriority => {
    if (typeof value !== 'string' || !(GROUP_TASK_PRIORITIES as readonly string[]).includes(value))
      return fail('INVALID_PARAMS');
    return value as GroupTaskPriority;
  };
  const detail = (taskId: string): GroupTaskDetail => {
    const row = taskRow(taskId);
    const comments = db
      .prepare('SELECT * FROM group_task_comments WHERE task_id=? ORDER BY created_at,id')
      .all(taskId);
    const dependencies = db
      .prepare(
        'SELECT task_id AS taskId, depends_on_task_id AS dependsOnTaskId, created_at AS createdAt FROM group_task_dependencies WHERE task_id=? ORDER BY depends_on_task_id',
      )
      .all(taskId);
    const runs = db
      .prepare('SELECT * FROM group_task_runs WHERE task_id=? ORDER BY dispatched_at,id')
      .all(taskId);
    const verdicts = db
      .prepare(
        'SELECT * FROM group_task_acceptances WHERE task_id=? AND delivery_seq=? ORDER BY created_at,id',
      )
      .all(taskId, row.delivery_seq);
    const depRefs = (dependencies as { dependsOnTaskId: string }[]).map((dep) => ({
      taskId: dep.dependsOnTaskId,
      status: statusOfOrNull(dep.dependsOnTaskId),
    }));
    return {
      task: mapTask(row),
      comments: (comments as { id: string; task_id: string; author: string; body: string; created_at: number }[]).map(
        (row): GroupTaskCommentRecord => ({
          id: row.id,
          taskId: row.task_id,
          author: row.author,
          body: row.body,
          createdAt: row.created_at,
        }),
      ),
      dependencies: dependencies as GroupTaskDependencyRecord[],
      blockers: groupTaskDependencyBlockers(depRefs, GROUP_TASK_DEPENDENCY_SATISFIED_STATUSES),
      runs: (runs as RunRow[]).map(mapRun),
      verdicts: (verdicts as VerdictRow[]).map(mapVerdict),
    };
  };
  const result = (groupId: string, taskDetail: GroupTaskDetail | null): GroupTaskResult => ({
    tasks: listTasks(groupId),
    detail: taskDetail,
  });
  /** Shared write path for `transition` / `accept` / `return`; expects all checks done. */
  const applyTransition = (taskId: string, from: GroupTaskStatus, to: GroupTaskStatus, now: number) => {
    const transition = transitionGroupTaskStatus(GROUP_TASK_TRANSITIONS, from, to);
    if (!transition.ok) return fail('INVALID_TRANSITION', `${from} -> ${to}`);
    const stamps = groupTaskTerminalTimestamps(transition.to, now);
    const row = db.prepare('SELECT delivery_seq FROM group_tasks WHERE id=?').get(taskId) as {
      delivery_seq: number;
    };
    const deliverySeq = transition.to === 'in_review' ? row.delivery_seq + 1 : row.delivery_seq;
    db.prepare(
      'UPDATE group_tasks SET status=?, completed_at=?, canceled_at=?, delivery_seq=?, revision=revision+1, updated_at=? WHERE id=?',
    ).run(transition.to, stamps.completedAt, stamps.canceledAt, deliverySeq, now, taskId);
    // Issue #8863: entering a terminal state voids leftover queued runs so a
    // finished task cannot start running afterwards. Running runs settle as-is.
    if (transition.terminal) cancelQueuedRuns(taskId, now);
    return transition;
  };
  /** Verdict id is derived: one accept or one return per delivery period. */
  const verdictId = (taskId: string, deliverySeq: number, action: GroupTaskAcceptanceAction): string =>
    `${taskId}#${deliverySeq}#${action}`;
  const recordVerdict = (
    taskId: string,
    deliverySeq: number,
    action: GroupTaskAcceptanceAction,
    reason: string,
    reviewer: string,
    now: number,
  ) => {
    db.prepare(
      'INSERT INTO group_task_acceptances(id,task_id,delivery_seq,action,reason,reviewer,created_at) VALUES(?,?,?,?,?,?,?)',
    ).run(verdictId(taskId, deliverySeq, action), taskId, deliverySeq, action, reason, reviewer, now);
  };

  return db.transaction(() => {
    if (!raw || typeof raw !== 'object') return fail('INVALID_PARAMS');
    const body = raw as GroupTaskRequest;
    switch (body.action) {
      case 'list': {
        const groupId = text(body.groupId, ID_MAX);
        requireGroup(groupId);
        return result(groupId, null);
      }
      case 'get': {
        const row = taskRow(text(body.taskId, ID_MAX));
        return result(row.group_id, detail(row.id));
      }
      case 'create': {
        const groupId = text(body.groupId, ID_MAX);
        requireGroup(groupId);
        const title = text(body.title, TITLE_MAX);
        const description = body.description === undefined ? '' : descText(body.description, DESCRIPTION_MAX);
        const priority = body.priority === undefined ? 'normal' : requirePriority(body.priority);
        const newId = text(body.newId, ID_MAX);
        const now = nowOf(body.now);
        if (body.parentTaskId !== undefined) {
          const parent = db
            .prepare('SELECT group_id FROM group_tasks WHERE id=?')
            .get(text(body.parentTaskId, ID_MAX)) as { group_id: string } | undefined;
          if (!parent) return fail('NOT_FOUND');
          if (parent.group_id !== groupId) return fail('CROSS_GROUP_PARENT');
        }
        const nextNumber =
          (
            db
              .prepare('SELECT COALESCE(MAX(number),0)+1 AS next FROM group_tasks WHERE group_id=?')
              .get(groupId) as { next: number }
          ).next;
        db.prepare(
          "INSERT INTO group_tasks(id,group_id,number,title,description,status,priority,assignee_id,created_by,parent_task_id,sort_order,due_at,estimate_hours,labels_json,delivery_seq,revision,completed_at,canceled_at,created_at,updated_at) VALUES(?,?,?,?,?,'todo',?,?,?,?,0,?,?,?,0,1,NULL,NULL,?,?)",
        ).run(
          newId,
          groupId,
          nextNumber,
          title,
          description,
          priority,
          body.assigneeId === undefined ? null : text(body.assigneeId, NAME_MAX),
          optText(body.createdBy, NAME_MAX) ?? '',
          body.parentTaskId === undefined ? null : text(body.parentTaskId, ID_MAX),
          body.dueAt === undefined ? null : optNumber(body.dueAt),
          body.estimateHours === undefined ? null : optNumber(body.estimateHours),
          JSON.stringify(parseLabels(body.labels) ?? []),
          now,
          now,
        );
        return result(groupId, detail(newId));
      }
      case 'update': {
        const row = taskRow(text(body.taskId, ID_MAX));
        requireRevision(row.revision, body.revision);
        const title = optText(body.title, TITLE_MAX) ?? row.title;
        const description = body.description === undefined ? row.description : descText(body.description, DESCRIPTION_MAX);
        const priority = body.priority === undefined ? row.priority : requirePriority(body.priority);
        const assigneeId =
          body.assigneeId === undefined
            ? row.assignee_id
            : body.assigneeId === null
              ? null
              : text(body.assigneeId, NAME_MAX);
        const sortOrder = optNumber(body.sortOrder) ?? row.sort_order;
        const dueAt = body.dueAt === undefined ? row.due_at : body.dueAt === null ? null : optNumber(body.dueAt);
        const estimateHours =
          body.estimateHours === undefined
            ? row.estimate_hours
            : body.estimateHours === null
              ? null
              : optNumber(body.estimateHours);
        const labelsJson = JSON.stringify(parseLabels(body.labels) ?? readLabels(row.labels_json));
        const now = Date.now();
        db.prepare(
          'UPDATE group_tasks SET title=?,description=?,priority=?,assignee_id=?,sort_order=?,due_at=?,estimate_hours=?,labels_json=?,revision=revision+1,updated_at=? WHERE id=?',
        ).run(title, description, priority, assigneeId, sortOrder, dueAt, estimateHours, labelsJson, now, row.id);
        return result(row.group_id, detail(row.id));
      }
      case 'transition': {
        const row = taskRow(text(body.taskId, ID_MAX));
        requireRevision(row.revision, body.revision);
        const to = requireTaskStatus(body.to);
        applyTransition(row.id, row.status as GroupTaskStatus, to, Date.now());
        return result(row.group_id, detail(row.id));
      }
      case 'dispatch': {
        const row = taskRow(text(body.taskId, ID_MAX));
        const assigneeId = text(body.assigneeId, NAME_MAX);
        const runId = text(body.runId, ID_MAX);
        const now = nowOf(body.now);
        const active = activeRunCount(row.id);
        const check = validateGroupTaskDispatch(
          row.status as GroupTaskStatus,
          active,
          GROUP_TASK_DISPATCHABLE_STATUSES,
        );
        // 改派/重试本身就意味着已有活跃执行：只拦状态不可派与依赖闸门。
        if (!check.ok && !(body.replace === true && check.code === 'ACTIVE_RUN_EXISTS')) {
          return fail(check.code);
        }
        // Issue #8863: dependencies are a dispatch gate, not a status lock —
        // manual transitions stay allowed, only handing out a run is blocked.
        const blocked = detail(row.id).blockers;
        if (blocked.length > 0) {
          return fail('DEPENDENCIES_BLOCKED', blocked.map((b) => b.taskId).join(','));
        }
        if (body.replace === true && active > 0) {
          // 改派 / 重试是同一动作：cancel the active run (kept for audit), then queue the new one.
          db.prepare(
            "UPDATE group_task_runs SET status='canceled', settled_at=? WHERE task_id=? AND status IN ('queued','running')",
          ).run(now, row.id);
        }
        try {
          db.prepare(
            "INSERT INTO group_task_runs(id,task_id,assignee_id,status,dispatched_at) VALUES(?,?,?,'queued',?)",
          ).run(runId, row.id, assigneeId, now);
        } catch {
          // Backstop for the partial unique index on active runs.
          return fail('ACTIVE_RUN_EXISTS');
        }
        return result(row.group_id, detail(row.id));
      }
      case 'runSetStatus': {
        const runId = text(body.runId, ID_MAX);
        const run = db.prepare('SELECT * FROM group_task_runs WHERE id=?').get(runId) as
          | RunRow
          | undefined;
        if (!run) return fail('NOT_FOUND');
        const now = nowOf(body.now);
        const next = requireRunTarget(body.status);
        const outcome = body.outcome === undefined ? undefined : text(body.outcome, OUTCOME_MAX);
        if (outcome !== undefined && next !== 'settled') return fail('INVALID_PARAMS');
        const from = run.status;
        const allowed =
          (from === 'queued' && (next === 'running' || next === 'canceled')) ||
          (from === 'running' && (next === 'settled' || next === 'canceled'));
        if (!allowed) return fail('INVALID_PARAMS');
        if (next === 'running') {
          db.prepare("UPDATE group_task_runs SET status='running', started_at=? WHERE id=?").run(now, runId);
        } else if (next === 'settled') {
          db.prepare("UPDATE group_task_runs SET status='settled', settled_at=?, outcome=? WHERE id=?").run(
            now,
            outcome ?? null,
            runId,
          );
        } else {
          db.prepare("UPDATE group_task_runs SET status='canceled', settled_at=? WHERE id=?").run(now, runId);
        }
        return result(taskRow(run.task_id).group_id, detail(run.task_id));
      }
      case 'comment': {
        const row = taskRow(text(body.taskId, ID_MAX));
        db.prepare(
          'INSERT INTO group_task_comments(id,task_id,author,body,created_at) VALUES(?,?,?,?,?)',
        ).run(
          text(body.commentId, ID_MAX),
          row.id,
          optText(body.author, NAME_MAX) ?? '',
          text(body.body, COMMENT_MAX),
          Date.now(),
        );
        return result(row.group_id, detail(row.id));
      }
      case 'addDependency': {
        const row = taskRow(text(body.taskId, ID_MAX));
        const depRow = taskRow(text(body.dependsOnTaskId, ID_MAX));
        if (depRow.id === row.id) return fail('SELF_DEPENDENCY');
        if (depRow.group_id !== row.group_id) return fail('CROSS_GROUP_DEPENDENCY');
        if (
          db
            .prepare('SELECT 1 FROM group_task_dependencies WHERE task_id=? AND depends_on_task_id=?')
            .get(row.id, depRow.id)
        )
          return fail('ALREADY_EXISTS');
        const edges = db
          .prepare('SELECT task_id AS taskId, depends_on_task_id AS dependsOnTaskId FROM group_task_dependencies')
          .all();
        const cycle = checkGroupTaskDependencyCycle(
          edges as { taskId: string; dependsOnTaskId: string }[],
          { taskId: row.id, dependsOnTaskId: depRow.id },
        );
        if (!cycle.ok) return fail('DEPENDENCY_CYCLE', cycle.cycle.join(' -> '));
        db.prepare(
          'INSERT INTO group_task_dependencies(task_id,depends_on_task_id,created_at) VALUES(?,?,?)',
        ).run(row.id, depRow.id, Date.now());
        return result(row.group_id, detail(row.id));
      }
      case 'removeDependency': {
        const row = taskRow(text(body.taskId, ID_MAX));
        const depId = text(body.dependsOnTaskId, ID_MAX);
        if (
          !db
            .prepare('SELECT 1 FROM group_task_dependencies WHERE task_id=? AND depends_on_task_id=?')
            .get(row.id, depId)
        )
          return fail('NOT_FOUND');
        db.prepare('DELETE FROM group_task_dependencies WHERE task_id=? AND depends_on_task_id=?').run(
          row.id,
          depId,
        );
        return result(row.group_id, detail(row.id));
      }
      case 'accept': {
        const row = taskRow(text(body.taskId, ID_MAX));
        requireRevision(row.revision, body.revision);
        const check = validateGroupTaskAcceptance(row.status as GroupTaskStatus, 'accept');
        if (!check.ok) return fail(check.code);
        const now = nowOf(body.now);
        applyTransition(row.id, row.status as GroupTaskStatus, 'done', now);
        recordVerdict(row.id, row.delivery_seq, 'accept', '', optText(body.reviewer, NAME_MAX) ?? '', now);
        return result(row.group_id, detail(row.id));
      }
      case 'return': {
        const row = taskRow(text(body.taskId, ID_MAX));
        requireRevision(row.revision, body.revision);
        // 先校验状态与理由语义（空/空白理由 → REASON_REQUIRED），再做长度规整。
        const check = validateGroupTaskAcceptance(
          row.status as GroupTaskStatus,
          'return',
          typeof body.reason === 'string' ? body.reason : undefined,
        );
        if (!check.ok) return fail(check.code);
        const reason = text(body.reason, REASON_MAX);
        const now = nowOf(body.now);
        applyTransition(row.id, row.status as GroupTaskStatus, 'in_progress', now);
        recordVerdict(row.id, row.delivery_seq, 'return', reason, optText(body.reviewer, NAME_MAX) ?? '', now);
        return result(row.group_id, detail(row.id));
      }
      default:
        return fail('INVALID_PARAMS');
    }
  })();
}
