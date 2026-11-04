import { describe, expect, it } from 'vitest';
import {
  GROUP_TASK_STATUSES,
  GROUP_TASK_TRANSITIONS,
  checkGroupTaskDependencyCycle,
  formatGroupTaskNumber,
  groupTaskDependencyBlockers,
  groupTaskTerminalTimestamps,
  isGroupTaskStatusTerminal,
  isGroupTaskVerdictCurrent,
  transitionGroupTaskStatus,
  validateGroupTaskAcceptance,
  validateGroupTaskDispatch,
  type GroupTaskStatus,
} from '../groupTask';
import type { GroupTaskDependencyEdge } from '../groupTask';

/**
 * 测试价值门槛（engineering-conventions.md §3.2）：
 * - 生产入口与可观察结果：`packages/maker-shared/src/groupTask.ts` 纯规则函数，
 *   结果被桌面端 `groupTasksTx.ts`（group_tasks 存储层）直接消费，非法迁移被拒、
 *   环依赖被拒、return 缺理由被拒是用户可观察行为（建卡/派单/验收动作的成败）。
 * - Bug／规则依据：issue #8863（七态显式迁移约束、终态时间戳进终态记录/离开清空、
 *   依赖满足态 done/canceled、悬空依赖忽略、合并环检测、验收 return 理由必填、
 *   每任务至多一个活跃执行）。
 * - 现有覆盖缺口：packages/ 全域此前无任务状态机/依赖闸门/验收规则实现（grep
 *   in_review|backlog|kanban 零任务语义命中），本文件为首份覆盖。
 * - 最小失败输入与 tier：如 `transitionGroupTaskStatus(table,'in_review','backlog')`
 *   必须返回 INVALID_TRANSITION；tier = unit。
 */

describe('group task transition table', () => {
  const allowed = (from: GroupTaskStatus) => new Set(GROUP_TASK_TRANSITIONS[from]);

  it('accepts exactly the transitions the explicit table allows (7x7 matrix)', () => {
    const cases: { from: GroupTaskStatus; to: GroupTaskStatus; ok: boolean }[] = [];
    for (const from of GROUP_TASK_STATUSES) {
      for (const to of GROUP_TASK_STATUSES) {
        cases.push({ from, to, ok: from !== to && allowed(from).has(to) });
      }
    }
    const illegal = cases.filter((c) => !c.ok);
    const legal = cases.filter((c) => c.ok);
    expect(legal.map((c) => [c.from, c.to])).toEqual([
      ['backlog', 'todo'],
      ['backlog', 'in_progress'],
      ['backlog', 'canceled'],
      ['todo', 'backlog'],
      ['todo', 'in_progress'],
      ['todo', 'canceled'],
      ['in_progress', 'todo'],
      ['in_progress', 'blocked'],
      ['in_progress', 'in_review'],
      ['in_progress', 'done'],
      ['in_progress', 'canceled'],
      ['blocked', 'todo'],
      ['blocked', 'in_progress'],
      ['blocked', 'canceled'],
      ['in_review', 'in_progress'],
      ['in_review', 'done'],
      ['in_review', 'canceled'],
      ['done', 'todo'],
    ]);
    for (const { from, to, ok } of cases) {
      const result = transitionGroupTaskStatus(GROUP_TASK_TRANSITIONS, from, to);
      expect({ ...result, from, to, ok: result.ok }).toMatchObject({ from, to, ok });
      if (!ok) expect(result).toMatchObject({ code: 'INVALID_TRANSITION' });
    }
    expect(illegal.length).toBe(49 - legal.length);
  });

  it('rejects no-op self transitions', () => {
    for (const status of GROUP_TASK_STATUSES) {
      expect(transitionGroupTaskStatus(GROUP_TASK_TRANSITIONS, status, status)).toMatchObject({
        ok: false,
        code: 'INVALID_TRANSITION',
      });
    }
  });

  it('flags terminal targets and stamps/clears terminal times', () => {
    expect(transitionGroupTaskStatus(GROUP_TASK_TRANSITIONS, 'in_review', 'done')).toMatchObject({
      ok: true,
      terminal: 'done',
    });
    expect(transitionGroupTaskStatus(GROUP_TASK_TRANSITIONS, 'todo', 'in_progress')).toMatchObject({
      ok: true,
      terminal: null,
    });
    expect(groupTaskTerminalTimestamps('done', 111)).toEqual({ completedAt: 111, canceledAt: null });
    expect(groupTaskTerminalTimestamps('canceled', 222)).toEqual({ completedAt: null, canceledAt: 222 });
    expect(groupTaskTerminalTimestamps('todo', 333)).toEqual({ completedAt: null, canceledAt: null });
    expect(isGroupTaskStatusTerminal('done')).toBe(true);
    expect(isGroupTaskStatusTerminal('canceled')).toBe(true);
    expect(isGroupTaskStatusTerminal('in_review')).toBe(false);
  });

  it('treats canceled as final: nothing leaves it, done only reopens to todo', () => {
    expect(GROUP_TASK_TRANSITIONS.canceled).toEqual([]);
    expect(GROUP_TASK_TRANSITIONS.done).toEqual(['todo']);
  });
});

describe('group task dependency cycle detection', () => {
  const edge = (taskId: string, dependsOnTaskId: string): GroupTaskDependencyEdge => ({
    taskId,
    dependsOnTaskId,
  });

  it('accepts an acyclic merge', () => {
    const edges = [edge('A', 'B'), edge('B', 'C')];
    // A additionally waits on C: A -> C, B -> C stays acyclic.
    expect(checkGroupTaskDependencyCycle(edges, edge('A', 'C'))).toEqual({ ok: true });
    expect(checkGroupTaskDependencyCycle(edges, edge('D', 'A'))).toEqual({ ok: true });
  });

  it('rejects a merge that closes a cycle and returns the path', () => {
    const edges = [edge('A', 'B'), edge('B', 'C')];
    const result = checkGroupTaskDependencyCycle(edges, edge('C', 'A'));
    expect(result).toEqual({ ok: false, code: 'DEPENDENCY_CYCLE', cycle: ['C', 'A', 'B', 'C'] });
  });

  it('rejects a self dependency', () => {
    expect(checkGroupTaskDependencyCycle([], edge('A', 'A'))).toEqual({
      ok: false,
      code: 'DEPENDENCY_CYCLE',
      cycle: ['A', 'A'],
    });
  });
});

describe('group task dependency gate', () => {
  it('lists only the deps still in the way and ignores dangling ones', () => {
    const refs = [
      { taskId: 'p1', status: 'backlog' as GroupTaskStatus },
      { taskId: 'p2', status: 'in_progress' as GroupTaskStatus },
      { taskId: 'p3', status: 'done' as GroupTaskStatus },
      { taskId: 'p4', status: 'canceled' as GroupTaskStatus },
      { taskId: 'gone', status: null },
    ];
    expect(groupTaskDependencyBlockers(refs)).toEqual([
      { taskId: 'p1', status: 'backlog' },
      { taskId: 'p2', status: 'in_progress' },
    ]);
  });
});

describe('group task acceptance rules', () => {
  it('requires in_review for both actions', () => {
    expect(validateGroupTaskAcceptance('in_progress', 'accept')).toEqual({
      ok: false,
      code: 'NOT_IN_REVIEW',
    });
    expect(validateGroupTaskAcceptance('done', 'return', '理由')).toEqual({
      ok: false,
      code: 'NOT_IN_REVIEW',
    });
  });

  it('requires a non-blank reason for return only', () => {
    expect(validateGroupTaskAcceptance('in_review', 'return')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
    expect(validateGroupTaskAcceptance('in_review', 'return', '   ')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
    expect(validateGroupTaskAcceptance('in_review', 'return', '截图缺失')).toEqual({ ok: true });
    expect(validateGroupTaskAcceptance('in_review', 'accept')).toEqual({ ok: true });
  });

  it('scopes verdicts to the current delivery', () => {
    expect(isGroupTaskVerdictCurrent(2, 2)).toBe(true);
    expect(isGroupTaskVerdictCurrent(1, 2)).toBe(false);
  });
});

describe('group task dispatch constraints', () => {
  it('dispatches only from todo/in_progress with no active run', () => {
    expect(validateGroupTaskDispatch('todo', 0)).toEqual({ ok: true });
    expect(validateGroupTaskDispatch('in_progress', 0)).toEqual({ ok: true });
    expect(validateGroupTaskDispatch('backlog', 0)).toEqual({
      ok: false,
      code: 'NOT_DISPATCHABLE',
    });
    expect(validateGroupTaskDispatch('done', 0)).toEqual({ ok: false, code: 'NOT_DISPATCHABLE' });
    expect(validateGroupTaskDispatch('todo', 1)).toEqual({ ok: false, code: 'ACTIVE_RUN_EXISTS' });
  });
});

describe('group task display key', () => {
  it('formats PROJ-<n>', () => {
    expect(formatGroupTaskNumber(7)).toBe('PROJ-7');
    expect(formatGroupTaskNumber(12, 'TEAM')).toBe('TEAM-12');
  });
});
