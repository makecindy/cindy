/**
 * scheduler 模块 storage / mapper 单测。
 *
 * 本文件只覆盖不依赖 DB 的 mapper 契约：schedule / scheduleRun 的
 * camel↔row 双向映射、嵌套 notify 拆解/合成、patch 的"undefined 写 NULL vs
 * key 不存在则跳过"双语义。
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../shared/brandRegion', () => ({
  CURRENT_CINDY_REGION: 'cn',
  CURRENT_APP_ID: 'com.xd.cindycn',
}));

import {
  scheduleToCamel,
  scheduleCreateToRow,
  schedulePatchToRow,
  scheduleRunToCamel,
  scheduleRunCreateToRow,
  scheduleRunPatchToRow,
} from '../../localDb/mapper';
import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';

// 用 ScheduleInsert 的"行级"形态（snake_case + null + numbers）构造一份基准 row，
// 不引入 drizzle inferSelect 类型——保持单测对 schema 实现细节解耦。
type ScheduleRowLike = Parameters<typeof scheduleToCamel>[0];
type ScheduleRunRowLike = Parameters<typeof scheduleRunToCamel>[0];

function baseRow(overrides: Partial<ScheduleRowLike> = {}): ScheduleRowLike {
  return {
    id: 'sch-1',
    name: 'daily standup',
    prompt: '/standup',
    executionMode: 'agent',
    scriptConfig: null,
    kind: 'cron',
    cronExpr: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
    recurring: true,
    agentKind: 'claude-code',
    model: null,
    effort: null,
    workspaceKind: 'project',
    workingDir: null,
    useWorktree: false,
    targetSessionId: null,
    notifyDesktop: true,
    notifyFeishu: false,
    status: 'active',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastFiredAt: null,
    nextFireAt: 1_700_000_060_000,
    expireAt: null,
    ...overrides,
  } as ScheduleRowLike;
}

function baseSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch-1',
    name: 'daily standup',
    prompt: '/standup',
    jobType: 'prompt',
    jobConfig: undefined,
    source: 'user',
    projectConfigId: undefined,
    kind: 'cron',
    cronExpr: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    intervalMs: undefined,
    agentKind: 'claude-code',
    executionMode: 'agent',
    scriptConfig: undefined,
    // 布尔列默认值要显式写入 fixture，避免 round-trip 断言混入默认值差异。
    fastMode: false,
    workspaceKind: 'project',
    useWorktree: false,
    persistentSession: false,
    silentWhenIdle: false,
    notify: { desktop: true, feishu: false },
    status: 'active',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastFinishedAt: undefined,
    nextFireAt: 1_700_000_060_000,
    ...overrides,
  };
}

// ============================================================================
// 1. Schedule mapper
// ============================================================================

describe('scheduleToCamel', () => {
  it('合成 notify {desktop, feishu} 嵌套对象', () => {
    const s = scheduleToCamel(baseRow({ notifyDesktop: true, notifyFeishu: true }));
    expect(s.notify).toEqual({ desktop: true, feishu: true });
  });

  it('null 列 → undefined（保持 Schedule 可选字段语义）', () => {
    const s = scheduleToCamel(
      baseRow({
        model: null,
        effort: null,
        workingDir: null,
        targetSessionId: null,
        lastFiredAt: null,
        nextFireAt: null,
        expireAt: null,
      }),
    );
    expect(s.model).toBeUndefined();
    expect(s.effort).toBeUndefined();
    expect(s.workspaceKind).toBe('project');
    expect(s.workingDir).toBeUndefined();
    expect(s.targetSessionId).toBeUndefined();
    expect(s.lastFiredAt).toBeUndefined();
    expect(s.nextFireAt).toBeUndefined();
    expect(s.expireAt).toBeUndefined();
  });

  it('boolean 列被 SQLite int 形态时仍 truthy', () => {
    // drizzle mode:'boolean' 实际存 0/1；模拟 row 已 int → mapper 用 !! 兜住
    const rowAsInt = baseRow({
      recurring: 1 as unknown as boolean,
      useWorktree: 0 as unknown as boolean,
      notifyDesktop: 1 as unknown as boolean,
      notifyFeishu: 0 as unknown as boolean,
    });
    const s = scheduleToCamel(rowAsInt);
    expect(s.recurring).toBe(true);
    expect(s.useWorktree).toBe(false);
    expect(s.notify).toEqual({ desktop: true, feishu: false });
  });

  it('workspace_kind=dialogue maps to schedule.workspaceKind', () => {
    const s = scheduleToCamel(baseRow({ workspaceKind: 'dialogue', workingDir: null }));
    expect(s.workspaceKind).toBe('dialogue');
    expect(s.workingDir).toBeUndefined();
  });
});

describe('scheduleCreateToRow', () => {
  it('拆 notify 为两列', () => {
    const row = scheduleCreateToRow(baseSchedule({ notify: { desktop: false, feishu: true } }));
    expect(row.notifyDesktop).toBe(false);
    expect(row.notifyFeishu).toBe(true);
    // 嵌套字段不直接出现在行里
    expect((row as Record<string, unknown>).notify).toBeUndefined();
  });

  it('undefined 可选字段 → null（DB 列存 NULL）', () => {
    const row = scheduleCreateToRow(baseSchedule());
    expect(row.model).toBeNull();
    expect(row.effort).toBeNull();
    expect(row.workspaceKind).toBe('project');
    expect(row.workingDir).toBeNull();
    expect(row.targetSessionId).toBeNull();
    expect(row.lastFiredAt).toBeNull();
    expect(row.expireAt).toBeNull();
    expect(row.nextFireAt).toBe(1_700_000_060_000);
  });

  it('round-trip: row → camel → row 全字段对齐', () => {
    const original = baseSchedule({
      model: 'claude-sonnet-4-6',
      effort: 'high',
      workspaceKind: 'dialogue',
      workingDir: '/repo',
      targetSessionId: 'sess-x',
      notify: { desktop: true, feishu: true },
      lastFiredAt: 1_700_000_900_000,
      expireAt: 1_800_000_000_000,
    });
    const row = scheduleCreateToRow(original);
    const back = scheduleToCamel(row as ScheduleRowLike);
    expect(back).toEqual(original);
  });
});

describe('schedulePatchToRow — patch 清空语义', () => {
  it('key 不存在 → 该列不出现（drizzle 不更新）', () => {
    const out = schedulePatchToRow({ name: 'x' });
    expect(Object.keys(out)).toEqual(['name']);
    expect(out.name).toBe('x');
    expect('nextFireAt' in out).toBe(false);
  });

  it('key 存在但值是 undefined → 写 null（清空列）', () => {
    // 业务通过 undefined 清空可空时间戳；key 不存在才表示不更新。
    const out = schedulePatchToRow({ nextFireAt: undefined });
    expect('nextFireAt' in out).toBe(true);
    expect(out.nextFireAt).toBeNull();
  });

  it('显式 null 也写 null', () => {
    const out = schedulePatchToRow({
      // Schedule 类型上 lastFiredAt 是 number | undefined，但 patch 是 Partial 容许
      // null 值穿透到行；mapper 兜底成 null。
      lastFiredAt: null as unknown as number | undefined,
    });
    expect(out.lastFiredAt).toBeNull();
  });

  it('notify 对象只更新调用方实际提供的渠道', () => {
    const out = schedulePatchToRow({ notify: { desktop: false, feishu: true } });
    expect(out.notifyDesktop).toBe(false);
    expect(out.notifyFeishu).toBe(true);
    expect('notifyWecomGroup' in out).toBe(false);
  });

  it('notify 显式清空时关闭全部渠道', () => {
    const out = schedulePatchToRow({
      notify: undefined,
    });
    expect(out.notifyDesktop).toBe(false);
    expect(out.notifyFeishu).toBe(false);
    expect(out.notifyWecomGroup).toBe(false);
  });

  it('workspaceKind patch 写 workspace_kind 列', () => {
    const out = schedulePatchToRow({ workspaceKind: 'dialogue' });
    expect(out.workspaceKind).toBe('dialogue');
  });

  it('多字段 patch 只输出列出的字段', () => {
    const out = schedulePatchToRow({
      name: 'renamed',
      status: 'paused',
      updatedAt: 1_700_000_999_999,
    });
    expect(Object.keys(out).sort()).toEqual(['name', 'status', 'updatedAt']);
  });

  it('空 patch → 空 setObj（storage 据此跳过 UPDATE）', () => {
    expect(schedulePatchToRow({})).toEqual({});
  });
});

// ============================================================================
// 2. ScheduleRun mapper
// ============================================================================

function baseRunRow(overrides: Partial<ScheduleRunRowLike> = {}): ScheduleRunRowLike {
  return {
    id: 'run-1',
    scheduleId: 'sch-1',
    sessionId: null,
    firedAt: 1_700_000_000_000,
    finishedAt: null,
    status: 'success',
    errorMsg: null,
    costUsd: 0,
    estimatedValueUsd: 0,
    costAmount: 0,
    estimatedValueAmount: 0,
    costCurrency: null,
    costIsApproximate: false,
    costAttribution: 'legacy',
    resultText: null,
    preRunHookResult: null,
    readAt: null,
    heartbeatAt: null,
    ...overrides,
  } as ScheduleRunRowLike;
}

describe('scheduleRunToCamel / scheduleRunCreateToRow', () => {
  it('null → undefined 出口', () => {
    const r = scheduleRunToCamel(baseRunRow());
    expect(r.sessionId).toBeUndefined();
    expect(r.finishedAt).toBeUndefined();
    expect(r.errorMsg).toBeUndefined();
  });

  it('round-trip: camel → row → camel 字段对齐', () => {
    const original: ScheduleRun = {
      id: 'run-1',
      scheduleId: 'sch-1',
      sessionId: 'sess-1',
      firedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_010_000,
      status: 'failed',
      errorMsg: 'timeout',
      costUsd: 0.42,
      estimatedValueUsd: 0.19,
      costAttribution: 'exact',
      resultText: undefined,
      preRunHookResult: {
        status: 'timed_out',
        decision: 'block',
        exitCode: null,
        durationMs: 5000,
        stdout: '',
        stderr: 'timed out',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: true,
        aborted: false,
        error: 'pre-run hook timed out after 5000ms',
      },
      readAt: undefined,
      heartbeatAt: undefined,
    };
    const row = scheduleRunCreateToRow(original);
    const back = scheduleRunToCamel(row as ScheduleRunRowLike);
    expect(back).toEqual({
      ...original,
      costMoney: {
        amount: 0.42,
        currency: 'USD',
        approximate: false,
        kind: 'actual-cost',
      },
      estimatedValueMoney: {
        amount: 0.19,
        currency: 'USD',
        approximate: true,
        kind: 'value-estimate',
        estimateReasons: ['legacy-usd', 'subscription-value'],
      },
    });
  });

  it('订阅估值不写入真实费用的约值标记', () => {
    const run: ScheduleRun = {
      id: 'run-money',
      scheduleId: 'sch-1',
      firedAt: 1,
      status: 'success',
      costMoney: {
        amount: 0.42,
        currency: 'CNY',
        approximate: false,
        kind: 'actual-cost',
      },
      estimatedValueMoney: {
        amount: 0.19,
        currency: 'CNY',
        approximate: true,
        kind: 'value-estimate',
        estimateReasons: ['subscription-value'],
      },
    };
    expect(scheduleRunCreateToRow(run).costIsApproximate).toBe(false);
    expect(
      'costIsApproximate' in
        scheduleRunPatchToRow({
          estimatedValueMoney: run.estimatedValueMoney,
        }),
    ).toBe(false);
  });

  it('可选字段 undefined → null 写入', () => {
    const minimal: ScheduleRun = {
      id: 'r',
      scheduleId: 'sch',
      firedAt: 1_700_000_000_000,
      status: 'running',
    };
    const row = scheduleRunCreateToRow(minimal);
    expect(row.sessionId).toBeNull();
    expect(row.finishedAt).toBeNull();
    expect(row.errorMsg).toBeNull();
    expect(row.preRunHookResult).toBeNull();
  });
});

describe('scheduleRunPatchToRow', () => {
  it('key 不在 → 不更新；undefined → null', () => {
    const out = scheduleRunPatchToRow({
      status: 'success',
      finishedAt: undefined,
    });
    expect(out.status).toBe('success');
    expect('finishedAt' in out).toBe(true);
    expect(out.finishedAt).toBeNull();
    expect('errorMsg' in out).toBe(false);
  });

  it('preRunHookResult undefined 显式清空，结构化结果序列化为 JSON', () => {
    expect(scheduleRunPatchToRow({ preRunHookResult: undefined }).preRunHookResult).toBeNull();
    const result: NonNullable<ScheduleRun['preRunHookResult']> = {
      status: 'passed',
      decision: 'run',
      exitCode: 0,
      durationMs: 12,
      stdout: 'ok',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
    };
    expect(scheduleRunPatchToRow({ preRunHookResult: result }).preRunHookResult).toBe(
      JSON.stringify(result),
    );
  });

  it('空 patch → 空 set', () => {
    expect(scheduleRunPatchToRow({})).toEqual({});
  });
});
