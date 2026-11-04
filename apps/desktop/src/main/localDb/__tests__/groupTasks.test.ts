import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runGroupTasksTransaction } from '../worker/opHandlers/groupTasksTx';
import type Database from 'better-sqlite3';

// 生产入口：runGroupTasksTransaction（desktop 主进程 localDb 事务层，经 types.ts DbTxName 暴露）。
// 可观察结果：group_tasks 等 5 表持久化 + [CODE] 结构化错误（INVALID_TRANSITION/CONFLICT/...）。
// 缺口依据：issue #8863 核心切片——七态迁移、依赖闸门、验收流、单活跃执行均无任何存储层测试。
// 最小失败输入：内存库 + 真实 0146 迁移 SQL + 直接调用事务函数（tier: unit，taskTags.test.ts 范本）。
describe('group task transactions', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createBetterSqliteDatabase(':memory:');
    db.pragma('foreign_keys=ON');
    // group_tasks 通过 FK 挂在 bot_groups 上；issue #8863 的任务表只在已有群聊上使用。
    db.exec("CREATE TABLE bot_groups(id TEXT PRIMARY KEY); INSERT INTO bot_groups(id) VALUES('g1'),('g2');");
    db.exec(
      readFileSync(
        new URL('../../../../drizzle/0146_worried_thunderbolts.sql', import.meta.url),
        'utf8',
      ),
    );
  });
  afterEach(() => db.close());
  const run = (input: unknown) => runGroupTasksTransaction(db, input);
  const create = (groupId: string, title: string, extra: Record<string, unknown> = {}) =>
    run({ action: 'create', groupId, newId: `t-${title}`, title, ...extra }).detail!.task;
  const taskOf = (taskId: string) => run({ action: 'get', taskId }).detail!;
  const freshRevision = (taskId: string) => taskOf(taskId).task.revision;

  it('numbers tasks per group with PROJ semantics and rejects unknown groups', () => {
    const a1 = create('g1', 'Task one');
    const a2 = create('g1', 'Task two');
    const b1 = create('g2', 'Other group');
    expect([a1.number, a2.number, b1.number]).toEqual([1, 2, 1]);
    expect([a1.status, a1.priority, a1.revision]).toEqual(['todo', 'normal', 1]);
    expect(a1.completedAt).toBeNull();
    expect(() => run({ action: 'create', groupId: 'missing', newId: 'x', title: 'T' })).toThrow(
      'NOT_FOUND',
    );
  });

  it('enforces the explicit transition table and stamps/clears terminal timestamps', () => {
    const t = create('g1', 'Flow');
    // 非法：todo 直接 done；终态 canceled 不可离开。
    expect(() => run({ action: 'transition', taskId: t.id, revision: t.revision, to: 'done' })).toThrow(
      'INVALID_TRANSITION',
    );
    run({ action: 'transition', taskId: t.id, revision: t.revision, to: 'in_progress' });
    let now = taskOf(t.id).task;
    expect(now.status).toBe('in_progress');
    run({ action: 'transition', taskId: t.id, revision: now.revision, to: 'done' });
    now = taskOf(t.id).task;
    expect(now.completedAt).toBeTypeOf('number');
    expect(now.canceledAt).toBeNull();
    // done 只能重开为 todo，离开终态后 completed_at 清空。
    run({ action: 'transition', taskId: t.id, revision: now.revision, to: 'todo' });
    now = taskOf(t.id).task;
    expect(now.completedAt).toBeNull();
    run({ action: 'transition', taskId: t.id, revision: now.revision, to: 'canceled' });
    now = taskOf(t.id).task;
    expect(now.canceledAt).toBeTypeOf('number');
    expect(() => run({ action: 'transition', taskId: t.id, revision: now.revision, to: 'todo' })).toThrow(
      'INVALID_TRANSITION',
    );
  });

  it('bumps revision on writes and flags stale writers with CONFLICT', () => {
    const t = create('g1', 'Stale');
    run({ action: 'update', taskId: t.id, revision: t.revision, title: 'Renamed' });
    const after = taskOf(t.id).task;
    expect([after.title, after.revision]).toEqual(['Renamed', 2]);
    expect(() => run({ action: 'update', taskId: t.id, revision: t.revision, title: 'Loser' })).toThrow(
      'CONFLICT',
    );
    expect(() => run({ action: 'transition', taskId: t.id, revision: 99, to: 'in_progress' })).toThrow(
      'CONFLICT',
    );
    expect(taskOf(t.id).task.title).toBe('Renamed');
  });

  it('gates dispatch on unsatisfied same-group dependencies and ignores dangling ids', () => {
    const blocker = create('g1', 'Blocker');
    const gated = create('g1', 'Gated');
    run({ action: 'addDependency', taskId: gated.id, dependsOnTaskId: blocker.id });
    expect(taskOf(gated.id).blockers.map((b) => b.taskId)).toEqual([blocker.id]);
    // 调度闸门：依赖未满足时派单被拒，人工改状态不受限。
    expect(() =>
      run({ action: 'dispatch', taskId: gated.id, assigneeId: 'agent-a', runId: 'r1', now: 100 }),
    ).toThrow('DEPENDENCIES_BLOCKED');
    run({ action: 'transition', taskId: gated.id, revision: freshRevision(gated.id), to: 'in_progress' });
    // 依赖满足（done）后放行。
    run({ action: 'transition', taskId: blocker.id, revision: freshRevision(blocker.id), to: 'in_progress' });
    run({ action: 'transition', taskId: blocker.id, revision: freshRevision(blocker.id), to: 'done' });
    expect(taskOf(gated.id).blockers).toEqual([]);
    const result = run({
      action: 'dispatch',
      taskId: gated.id,
      assigneeId: 'agent-a',
      runId: 'r1',
      now: 100,
    });
    expect(result.detail!.runs.map((r) => [r.id, r.status])).toEqual([['r1', 'queued']]);
    // 悬空依赖 id 忽略：不计入 blockers、不闸派单（FK 失效的历史库中可能残留这种行）。
    const orphanHost = create('g1', 'Orphan host');
    run({ action: 'addDependency', taskId: orphanHost.id, dependsOnTaskId: gated.id });
    db.pragma('foreign_keys=OFF');
    db.prepare('DELETE FROM group_tasks WHERE id=?').run(gated.id);
    db.pragma('foreign_keys=ON');
    expect(taskOf(orphanHost.id).blockers).toEqual([]);
  });

  it('rejects self, cross-group and cyclic dependencies', () => {
    const a = create('g1', 'A');
    const b = create('g1', 'B');
    const other = create('g2', 'Other');
    expect(() => run({ action: 'addDependency', taskId: a.id, dependsOnTaskId: a.id })).toThrow(
      'SELF_DEPENDENCY',
    );
    expect(() => run({ action: 'addDependency', taskId: a.id, dependsOnTaskId: other.id })).toThrow(
      'CROSS_GROUP_DEPENDENCY',
    );
    run({ action: 'addDependency', taskId: a.id, dependsOnTaskId: b.id });
    expect(() => run({ action: 'addDependency', taskId: b.id, dependsOnTaskId: a.id })).toThrow(
      /DEPENDENCY_CYCLE.*g1#1 -> g1#2|DEPENDENCY_CYCLE/,
    );
    expect(() => run({ action: 'addDependency', taskId: a.id, dependsOnTaskId: b.id })).toThrow(
      'ALREADY_EXISTS',
    );
    run({ action: 'removeDependency', taskId: a.id, dependsOnTaskId: b.id });
    expect(taskOf(a.id).dependencies).toEqual([]);
    expect(() => run({ action: 'removeDependency', taskId: a.id, dependsOnTaskId: b.id })).toThrow(
      'NOT_FOUND',
    );
  });

  it('runs the acceptance flow with delivery-scoped verdicts', () => {
    const t = create('g1', 'Review me');
    run({ action: 'transition', taskId: t.id, revision: t.revision, to: 'in_progress' });
    run({ action: 'transition', taskId: t.id, revision: freshRevision(t.id), to: 'in_review' });
    let now = taskOf(t.id);
    expect(now.task.deliverySeq).toBe(1);
    // return 必须带理由；accept 不需要。
    expect(() =>
      run({ action: 'return', taskId: t.id, revision: now.task.revision, reason: '  ' }),
    ).toThrow('REASON_REQUIRED');
    run({
      action: 'return',
      taskId: t.id,
      revision: now.task.revision,
      reason: 'coverage missing',
      reviewer: 'lead',
    });
    now = taskOf(t.id);
    expect([now.task.status, now.verdicts.map((v) => v.action)]).toEqual(['in_progress', ['return']]);
    expect(now.verdicts[0].reason).toBe('coverage missing');
    // 第二次交付：旧验收结论不再展示。
    run({ action: 'transition', taskId: t.id, revision: now.task.revision, to: 'in_review' });
    now = taskOf(t.id);
    expect([now.task.deliverySeq, now.verdicts]).toEqual([2, []]);
    run({ action: 'accept', taskId: t.id, revision: now.task.revision, reviewer: 'lead' });
    now = taskOf(t.id);
    expect([now.task.status, now.task.completedAt != null, now.verdicts.map((v) => v.action)]).toEqual([
      'done',
      true,
      ['accept'],
    ]);
    expect(now.task.deliverySeq).toBe(2);
  });

  it('keeps one active run per task with replace-style redispatch', () => {
    const t = create('g1', 'Dispatched');
    run({ action: 'dispatch', taskId: t.id, assigneeId: 'agent-a', runId: 'r1', now: 100 });
    // 重复派单拒绝（partial unique 兜底 + 服务层预检）。
    expect(() =>
      run({ action: 'dispatch', taskId: t.id, assigneeId: 'agent-b', runId: 'r2', now: 101 }),
    ).toThrow('ACTIVE_RUN_EXISTS');
    // 改派 / 重试：同一动作，取消旧 run 保留审计，排队新 run。
    const replaced = run({
      action: 'dispatch',
      taskId: t.id,
      assigneeId: 'agent-b',
      runId: 'r2',
      now: 102,
      replace: true,
    });
    expect(replaced.detail!.runs.map((r) => [r.id, r.status, r.assigneeId])).toEqual([
      ['r1', 'canceled', 'agent-a'],
      ['r2', 'queued', 'agent-b'],
    ]);
    // 终态作废残留排队运行：todo → canceled 直接取消 queued run。
    run({ action: 'transition', taskId: t.id, revision: freshRevision(t.id), to: 'canceled' });
    const canceled = taskOf(t.id);
    expect(canceled.runs.find((r) => r.id === 'r2')?.status).toBe('canceled');
    expect(() =>
      run({ action: 'dispatch', taskId: t.id, assigneeId: 'agent-b', runId: 'r3', now: 103 }),
    ).toThrow('NOT_DISPATCHABLE');
  });

  it('restricts run lifecycle edges and settles with outcome', () => {
    const t = create('g1', 'Run lifecycle');
    run({ action: 'dispatch', taskId: t.id, assigneeId: 'agent-a', runId: 'r1', now: 100 });
    expect(() => run({ action: 'runSetStatus', runId: 'missing', status: 'running' })).toThrow(
      'NOT_FOUND',
    );
    // queued → settled 跳段拒绝。
    expect(() => run({ action: 'runSetStatus', runId: 'r1', status: 'settled', outcome: 'x' })).toThrow(
      'INVALID_PARAMS',
    );
    run({ action: 'runSetStatus', runId: 'r1', status: 'running', now: 101 });
    run({ action: 'runSetStatus', runId: 'r1', status: 'settled', outcome: 'done-by-agent', now: 102 });
    const settled = taskOf(t.id).runs.find((r) => r.id === 'r1')!;
    expect([settled.status, settled.outcome, settled.startedAt, settled.settledAt]).toEqual([
      'settled',
      'done-by-agent',
      101,
      102,
    ]);
    // settled 是终态。
    expect(() => run({ action: 'runSetStatus', runId: 'r1', status: 'running' })).toThrow(
      'INVALID_PARAMS',
    );
  });

  it('supports parent links, comments and labels with validation', () => {
    const parent = create('g1', 'Parent');
    const child = create('g1', 'Child', { parentTaskId: parent.id, labels: ['backend', 'infra'] });
    expect(child.parentTaskId).toBe(parent.id);
    expect(child.labels).toEqual(['backend', 'infra']);
    expect(() => create('g2', 'Orphan', { parentTaskId: parent.id })).toThrow('CROSS_GROUP_PARENT');
    expect(() => create('g1', 'Ghost parent', { parentTaskId: 'nope' })).toThrow('NOT_FOUND');
    run({ action: 'comment', taskId: parent.id, commentId: 'c1', author: 'lead', body: 'hello' });
    const withComment = taskOf(parent.id);
    expect(withComment.comments.map((c) => [c.id, c.author, c.body])).toEqual([['c1', 'lead', 'hello']]);
    expect(() =>
      run({ action: 'comment', taskId: parent.id, commentId: 'c2', body: ' '.repeat(4001) }),
    ).toThrow(/LIMIT_EXCEEDED|INVALID_PARAMS/);
    // 清单验收：list 返回群内全部任务。
    expect(run({ action: 'list', groupId: 'g1' }).tasks.map((t) => t.id)).toEqual([parent.id, child.id]);
  });
});
