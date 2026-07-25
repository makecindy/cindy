/**
 * scheduler storage DB-tier smoke。
 *
 * 这里覆盖 DrizzleScheduleStorage 的 public CRUD 路径，需要 better-sqlite3，
 * 因此由 test-workspaces 的 db tier 运行，不放进 fast unit tier。
 */

import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import * as schema from '../../localDb/schema';
import { createDbClient } from '../../localDb/client/DbClient';
import type { DbClient } from '../../localDb/client/DbClient';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current';
import { recordScheduleRunCostDirect } from '../runCostLedger';
import { DrizzleScheduleStorage, type SchedulerDrizzleDb } from '../storage';

function actualMoneyFromLegacyUsd(amountUsd: number) {
  return {
    amount: expect.closeTo(amountUsd * 6.7, 10),
    currency: 'CNY' as const,
    approximate: true,
    kind: 'actual-cost' as const,
    estimateReasons: ['fixed-fx', 'legacy-usd'] as const,
  };
}

function estimatedMoneyFromLegacyUsd(amountUsd: number) {
  return {
    amount: expect.closeTo(amountUsd * 6.7, 10),
    currency: 'CNY' as const,
    approximate: true,
    kind: 'value-estimate' as const,
    estimateReasons: ['fixed-fx', 'legacy-usd', 'subscription-value'] as const,
  };
}

const ZERO_ACTUAL_MONEY = {
  amount: 0,
  currency: 'CNY' as const,
  approximate: false,
  kind: 'actual-cost' as const,
};

const ZERO_ESTIMATED_MONEY = {
  amount: 0,
  currency: 'CNY' as const,
  approximate: true,
  kind: 'value-estimate' as const,
  estimateReasons: ['subscription-value'] as const,
};

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

// 这段 SQL 是 ../../localDb/schema.ts 中 scheduler 相关表的最小投影；
// 修改 schedules / schedule_runs 或这些方法会读取的 sessions 列时，需要同步这里。
// 按语句拆成数组:直连 harness 一次 exec,drizzleProxy 回归用例经 client.exec
// 逐条下发(worker 'exec' op 单语句)。
const SCHEDULER_DDL = [
  `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'desktop',
      status TEXT NOT NULL DEFAULT 'active',
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      working_dir TEXT,
      user_send_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL,
      total_cost_amount REAL NOT NULL DEFAULT 0,
      total_cost_currency TEXT,
      total_cost_is_approximate INTEGER NOT NULL DEFAULT 0
    )
  `,
  `
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    )
  `,
  `
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      job_type TEXT NOT NULL DEFAULT 'prompt',
      job_config TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'agent',
      script_config TEXT,
      source TEXT DEFAULT 'user',
      project_config_id TEXT,
      legacy_session_fallback INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'cron',
      cron_expr TEXT NOT NULL,
      timezone TEXT NOT NULL,
      recurring INTEGER NOT NULL DEFAULT 1,
      manual INTEGER NOT NULL DEFAULT 0,
      interval_ms INTEGER,
      agent_kind TEXT NOT NULL,
      model TEXT,
      provider_id TEXT,
      effort TEXT,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      working_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      use_worktree INTEGER NOT NULL DEFAULT 0,
      target_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      persistent_session INTEGER NOT NULL DEFAULT 0,
      silent_when_idle INTEGER NOT NULL DEFAULT 0,
      pre_run_hook_command TEXT,
      pre_run_hook_timeout_ms INTEGER,
      skip_log_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      notify_desktop INTEGER NOT NULL DEFAULT 1,
      notify_feishu INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_fired_at INTEGER,
      last_finished_at INTEGER,
      next_fire_at INTEGER,
      expire_at INTEGER
    )
  `,
  'CREATE INDEX idx_schedules_active_next ON schedules(status, next_fire_at)',
  'CREATE INDEX idx_schedules_target_session ON schedules(target_session_id)',
  `
    CREATE TABLE schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      fired_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      error_msg TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      estimated_value_usd REAL NOT NULL DEFAULT 0,
      cost_amount REAL NOT NULL DEFAULT 0,
      estimated_value_amount REAL NOT NULL DEFAULT 0,
      cost_currency TEXT,
      cost_is_approximate INTEGER NOT NULL DEFAULT 0,
      cost_attribution TEXT NOT NULL DEFAULT 'legacy',
      result_text TEXT,
      pre_run_hook_result TEXT,
      read_at INTEGER,
      heartbeat_at INTEGER
    )
  `,
  'CREATE INDEX idx_schedule_runs_schedule ON schedule_runs(schedule_id, fired_at)',
];

function createStorageHarness() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const statement of SCHEDULER_DDL) sqlite.exec(statement);

  const db = drizzle(sqlite, { schema }) as SchedulerDrizzleDb;
  return {
    close: () => sqlite.close(),
    db,
    storage: new DrizzleScheduleStorage(() => db),
  };
}

function enableLegacySessionFallback(
  harness: ReturnType<typeof createStorageHarness>,
  scheduleId: string,
): void {
  harness.db.run(sql`
    UPDATE schedules
    SET legacy_session_fallback = 1
    WHERE id = ${scheduleId}
  `);
}

describe('DrizzleScheduleStorage (in-memory)', () => {
  it('round-trips schedule and run CRUD through SQLite', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({
      id: 'sch-storage',
      name: 'storage smoke',
      nextFireAt: 1_700_000_120_000,
      // providerId 钉到非原生来源,断言往返保真(insert → get 都带回 'anthropic')。
      providerId: 'anthropic',
    });
    const run: ScheduleRun = {
      id: 'run-storage',
      scheduleId: schedule.id,
      firedAt: 1_700_000_100_000,
      status: 'running',
    };

    try {
      const inserted = await harness.storage.insert(schedule);
      expect(inserted).toEqual(schedule);

      expect(await harness.storage.get(schedule.id)).toEqual(schedule);
      expect((await harness.storage.listActive()).map((item) => item.id)).toEqual([schedule.id]);

      const updated = await harness.storage.update(schedule.id, {
        nextFireAt: undefined,
        status: 'paused',
        updatedAt: 1_700_000_200_000,
      });
      expect(updated?.status).toBe('paused');
      expect(updated?.nextFireAt).toBeUndefined();
      expect(await harness.storage.listActive()).toEqual([]);

      await expect(harness.storage.insertRun(run)).resolves.toEqual({
        ...run,
        costUsd: 0,
        estimatedValueUsd: 0,
        costMoney: ZERO_ACTUAL_MONEY,
        estimatedValueMoney: ZERO_ESTIMATED_MONEY,
        costAttribution: 'exact',
      });
      const completed = await harness.storage.updateRun(run.id, {
        finishedAt: 1_700_000_110_000,
        resultText: 'done',
        status: 'success',
      });
      expect(completed).toMatchObject({
        id: run.id,
        resultText: 'done',
        status: 'success',
      });
      expect((await harness.storage.listRuns(schedule.id)).map((item) => item.id)).toEqual([
        run.id,
      ]);

      await expect(harness.storage.deleteRun(run.id)).resolves.toMatchObject({
        id: run.id,
      });
      await harness.storage.delete(schedule.id);
      await expect(harness.storage.get(schedule.id)).resolves.toBeNull();
    } finally {
      harness.close();
    }
  });

  it('hydrates exact run cost from persisted assistant runId metadata', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({ id: 'sch-run-cost' });
    try {
      harness.db.run(sql`
        INSERT INTO sessions (id, title, source, workspace_kind, created_at, updated_at, total_cost_usd)
        VALUES ('sess-run-cost', 'Persistent schedule session', 'desktop', 'dialogue', 1, 1, 0)
      `);
      await harness.storage.insert(schedule);
      await harness.storage.insertRun({
        id: 'run-exact',
        scheduleId: schedule.id,
        sessionId: 'sess-run-cost',
        firedAt: 10,
        finishedAt: 20,
        status: 'success',
      });
      harness.db.run(sql`
        INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
        VALUES
          ('run-exact-assistant-1', 'run-exact-assistant-1', 'sess-run-cost', 'assistant', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-run-cost","runId":"run-exact"},"turnCostUsd":0.42}', 11),
          ('run-exact-assistant-2', 'run-exact-assistant-2', 'sess-run-cost', 'assistant', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-run-cost","runId":"run-exact"},"turnCostUsd":0.29,"turnCostIsEstimate":true}', 12)
      `);

      await expect(harness.storage.listRuns(schedule.id)).resolves.toEqual([
        expect.objectContaining({
          id: 'run-exact',
          costUsd: 0,
          estimatedValueUsd: 0,
          costMoney: actualMoneyFromLegacyUsd(0.42),
          estimatedValueMoney: estimatedMoneyFromLegacyUsd(0.29),
          costAttribution: 'exact',
        }),
      ]);
    } finally {
      harness.close();
    }
  });

  it('isolates two schedules and manual turns inside one persistent session', async () => {
    const harness = createStorageHarness();
    const scheduleA = baseSchedule({ id: 'sch-a', targetSessionId: 'sess-shared' });
    const scheduleB = baseSchedule({ id: 'sch-b', targetSessionId: 'sess-shared' });
    try {
      harness.db.run(sql`
        INSERT INTO sessions (id, title, source, workspace_kind, created_at, updated_at, total_cost_usd)
        VALUES ('sess-shared', 'Shared persistent session', 'desktop', 'dialogue', 1, 1, 1.1)
      `);
      await harness.storage.insert(scheduleA);
      await harness.storage.insert(scheduleB);
      for (const run of [
        { id: 'run-a1', scheduleId: 'sch-a', firedAt: 10 },
        { id: 'run-b1', scheduleId: 'sch-b', firedAt: 30 },
        { id: 'run-a2', scheduleId: 'sch-a', firedAt: 50 },
      ]) {
        await harness.storage.insertRun({
          ...run,
          sessionId: 'sess-shared',
          finishedAt: run.firedAt + 5,
          status: 'success',
        });
      }
      harness.db.run(sql`
        INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
        VALUES
          ('user-a1', 'user-a1', 'sess-shared', 'user', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-a","runId":"run-a1"}}', 10),
          ('assistant-a1', 'assistant-a1', 'sess-shared', 'assistant', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-a","runId":"run-a1"},"turnCostUsd":0.1}', 11),
          ('manual-user', 'manual-user', 'sess-shared', 'user', '{}', NULL, 20),
          ('manual-assistant', 'manual-assistant', 'sess-shared', 'assistant', '{}',
            '{"turnCostUsd":0.5}', 21),
          ('user-b1', 'user-b1', 'sess-shared', 'user', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-b","runId":"run-b1"}}', 30),
          ('assistant-b1', 'assistant-b1', 'sess-shared', 'assistant', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-b","runId":"run-b1"},"turnCostUsd":0.2}', 31),
          ('user-a2', 'user-a2', 'sess-shared', 'user', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-a","runId":"run-a2"}}', 50),
          ('assistant-a2', 'assistant-a2', 'sess-shared', 'assistant', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-a","runId":"run-a2"},"turnCostUsd":0.3}', 51)
      `);

      const summaries = new Map(
        (await harness.storage.listCostSummaries()).map((summary) => [summary.scheduleId, summary]),
      );
      expect(summaries.get('sch-a')).toMatchObject({
        totalMoney: actualMoneyFromLegacyUsd(0.4),
        totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
      });
      expect(summaries.get('sch-b')).toMatchObject({
        totalMoney: actualMoneyFromLegacyUsd(0.2),
        totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
      });
      expect(await harness.storage.listRuns('sch-a')).toEqual([
        expect.objectContaining({
          id: 'run-a2',
          costMoney: actualMoneyFromLegacyUsd(0.3),
        }),
        expect.objectContaining({
          id: 'run-a1',
          costMoney: actualMoneyFromLegacyUsd(0.1),
        }),
      ]);
      expect(await harness.storage.listRuns('sch-b')).toEqual([
        expect.objectContaining({
          id: 'run-b1',
          costMoney: actualMoneyFromLegacyUsd(0.2),
        }),
      ]);
    } finally {
      harness.close();
    }
  });

  it('claimDueFire: CAS 命中时置空 next_fire_at 并返回行;不命中不动行', async () => {
    const harness = createStorageHarness();
    const due = 1_700_000_060_000;
    try {
      await harness.storage.insert(baseSchedule({ id: 'sch-claim', nextFireAt: due }));

      // 期望值对不上(模拟另一进程已改期/已认领)→ 输,行原样
      expect(await harness.storage.claimDueFire('sch-claim', due + 1)).toBeNull();
      expect((await harness.storage.get('sch-claim'))?.nextFireAt).toBe(due);

      // 期望值精确匹配 → 赢,next_fire_at 被置空
      const claimed = await harness.storage.claimDueFire('sch-claim', due);
      expect(claimed?.id).toBe('sch-claim');
      expect(claimed?.nextFireAt).toBeUndefined();

      // 同一到点第二次认领(模拟双开另一进程紧随其后)→ 输
      expect(await harness.storage.claimDueFire('sch-claim', due)).toBeNull();
    } finally {
      harness.close();
    }
  });

  it('claimDueFire: 经 DbClient drizzleProxy(worker RPC)也能拿到 changes 完成 CAS', async () => {
    // 回归测试 — 防退化:主进程生产链路的 db 是 drizzleProxy,不是直连
    // better-sqlite3 drizzle。代理对隐式 await 的写操作丢弃 { changes },
    // claimDueFire 曾因此每次认领都 throw"driver did not report changes count",
    // 任务到点后无限重试、永不触发(2026-07-04 dev 实测)。此用例保证认领
    // 走真代理链路时胜负语义完整。
    const client = await createDbClient({ useInlineWorker: true });
    const due = 1_700_000_060_000;
    try {
      for (const statement of SCHEDULER_DDL) await client.exec(statement);
      const storage = new DrizzleScheduleStorage(() => client.drizzle as SchedulerDrizzleDb);
      await storage.insert(baseSchedule({ id: 'sch-proxy', nextFireAt: due }));

      // 期望值不匹配 → 判负返回 null(而不是 throw)
      expect(await storage.claimDueFire('sch-proxy', due + 1)).toBeNull();

      // 精确匹配 → 判胜,next_fire_at 置空
      const claimed = await storage.claimDueFire('sch-proxy', due);
      expect(claimed?.id).toBe('sch-proxy');
      expect(claimed?.nextFireAt).toBeUndefined();

      // 二次认领 → 判负
      expect(await storage.claimDueFire('sch-proxy', due)).toBeNull();
    } finally {
      await client.dispose();
    }
  });

  it('markRunningAsInterrupted: 只回收心跳过期的 running 行,排除名单与新鲜心跳都不动', async () => {
    const harness = createStorageHarness();
    const now = 1_700_000_300_000;
    const stale = now - 61_000;
    try {
      await harness.storage.insert(baseSchedule({ id: 'sch-a' }));
      await harness.storage.insert(baseSchedule({ id: 'sch-b', name: 'other' }));
      // 另一活实例正在跑:心跳新鲜 → 不许动
      await harness.storage.insertRun({
        id: 'run-alive',
        scheduleId: 'sch-a',
        firedAt: now - 300_000,
        status: 'running',
        heartbeatAt: now - 5_000,
      });
      // 真僵尸:心跳过期 → 回收
      await harness.storage.insertRun({
        id: 'run-dead',
        scheduleId: 'sch-a',
        firedAt: now - 300_000,
        status: 'running',
        heartbeatAt: now - 120_000,
      });
      // 老版本行(无心跳):按 fired_at 兜底 → 回收
      await harness.storage.insertRun({
        id: 'run-legacy',
        scheduleId: 'sch-b',
        firedAt: now - 120_000,
        status: 'running',
      });
      // 本进程 in-flight(心跳虽然过期也在排除名单里)→ 不许动
      await harness.storage.insertRun({
        id: 'run-mine',
        scheduleId: 'sch-b',
        firedAt: now - 300_000,
        status: 'running',
        heartbeatAt: now - 120_000,
      });
      // 终态行无论心跳如何都不受影响
      await harness.storage.insertRun({
        id: 'run-done',
        scheduleId: 'sch-a',
        firedAt: now - 300_000,
        finishedAt: now - 200_000,
        status: 'success',
      });

      const affected = await harness.storage.markRunningAsInterrupted(stale, ['run-mine']);
      expect(affected.sort()).toEqual(['sch-a', 'sch-b']);

      const byId = new Map(
        [
          ...(await harness.storage.listRuns('sch-a')),
          ...(await harness.storage.listRuns('sch-b')),
        ].map((r) => [r.id, r]),
      );
      expect(byId.get('run-alive')?.status).toBe('running');
      expect(byId.get('run-mine')?.status).toBe('running');
      expect(byId.get('run-done')?.status).toBe('success');
      expect(byId.get('run-dead')?.status).toBe('interrupted');
      expect(byId.get('run-dead')?.errorMsg).toBe('app restarted');
      expect(byId.get('run-legacy')?.status).toBe('interrupted');

      // 再扫一遍(同样的排除名单):已回收的行不重复计入 → 空结果(调用方据此不广播)
      expect(await harness.storage.markRunningAsInterrupted(stale, ['run-mine'])).toEqual([]);

      // legacyStaleBefore(运行期清扫模式):NULL 心跳行(老版本实例写入)按
      // fired_at 走独立宽窗口 —— 窗口内跳过(可能是跨版本活实例正在跑),
      // 窗口外照收(否则老版本崩溃残留永久卡死 busy probe)。
      await harness.storage.insertRun({
        id: 'run-old-version',
        scheduleId: 'sch-a',
        firedAt: now - 300_000,
        status: 'running',
      });
      expect(
        await harness.storage.markRunningAsInterrupted(stale, ['run-mine'], {
          legacyStaleBefore: now - 600_000,
        }),
      ).toEqual([]);
      expect(
        await harness.storage.markRunningAsInterrupted(stale, ['run-mine'], {
          legacyStaleBefore: now - 200_000,
        }),
      ).toEqual(['sch-a']);
    } finally {
      harness.close();
    }
  });

  it('hasRunningRuns: 支持 schedule 范围查询,不受行数影响', async () => {
    const harness = createStorageHarness();
    const now = 1_700_000_300_000;
    try {
      await harness.storage.insert(baseSchedule({ id: 'sch-x' }));
      await harness.storage.insert(baseSchedule({ id: 'sch-y', name: 'other' }));
      // sch-x:一条最老的活 run + 大量更新的终态行(挤出任何展示窗口都不影响)
      await harness.storage.insertRun({
        id: 'run-live',
        scheduleId: 'sch-x',
        firedAt: now - 900_000,
        status: 'running',
        heartbeatAt: now,
      });
      for (let i = 0; i < 15; i++) {
        await harness.storage.insertRun({
          id: `run-done-${i}`,
          scheduleId: 'sch-x',
          firedAt: now - 500_000 + i * 1_000,
          finishedAt: now - 499_000 + i * 1_000,
          status: 'success',
        });
      }
      expect(await harness.storage.hasRunningRuns('sch-x')).toBe(true);
      expect(await harness.storage.hasRunningRuns('sch-y')).toBe(false);
      expect(await harness.storage.hasRunningRuns()).toBe(true);
    } finally {
      harness.close();
    }
  });

  it('touchRunHeartbeats: 只给 running 行续心跳,终态行不补写', async () => {
    const harness = createStorageHarness();
    const now = 1_700_000_300_000;
    try {
      await harness.storage.insert(baseSchedule({ id: 'sch-hb' }));
      await harness.storage.insertRun({
        id: 'run-going',
        scheduleId: 'sch-hb',
        firedAt: now - 30_000,
        status: 'running',
        heartbeatAt: now - 30_000,
      });
      await harness.storage.insertRun({
        id: 'run-over',
        scheduleId: 'sch-hb',
        firedAt: now - 30_000,
        finishedAt: now - 10_000,
        status: 'success',
        heartbeatAt: now - 30_000,
      });
      await harness.storage.touchRunHeartbeats(['run-going', 'run-over'], now);
      const byId = new Map((await harness.storage.listRuns('sch-hb')).map((r) => [r.id, r]));
      expect(byId.get('run-going')?.heartbeatAt).toBe(now);
      expect(byId.get('run-over')?.heartbeatAt).toBe(now - 30_000);
      // 空名单是 no-op(引擎 inflight 清空后的防御调用)
      await expect(harness.storage.touchRunHeartbeats([], now)).resolves.toBeUndefined();
    } finally {
      harness.close();
    }
  });

  it('claimDueFire: 非 active 状态不可认领', async () => {
    const harness = createStorageHarness();
    const due = 1_700_000_060_000;
    try {
      await harness.storage.insert(
        baseSchedule({ id: 'sch-paused', status: 'paused', nextFireAt: due }),
      );
      expect(await harness.storage.claimDueFire('sch-paused', due)).toBeNull();
      expect((await harness.storage.get('sch-paused'))?.nextFireAt).toBe(due);
    } finally {
      harness.close();
    }
  });

  it('script 任务的能力清单经 DB 往返不丢项(回归:mapper 曾私自维护白名单漏掉 feishu.read)', async () => {
    const harness = createStorageHarness();
    const capabilities: NonNullable<Schedule['scriptConfig']>['capabilities'] = [
      'jira.read',
      'jira.comment',
      'sessions.dispatch',
      'feishu.read',
    ];
    try {
      await harness.storage.insert(
        baseSchedule({
          id: 'sch-script-caps',
          prompt: '',
          executionMode: 'script',
          scriptConfig: { command: 'python demo.py', capabilities, timeoutMs: 30_000 },
        }),
      );
      const back = await harness.storage.get('sch-script-caps');
      expect(back?.executionMode).toBe('script');
      expect(back?.scriptConfig).toEqual({
        command: 'python demo.py',
        capabilities,
        timeoutMs: 30_000,
      });
    } finally {
      harness.close();
    }
  });

  it('no-break: 不设 providerId 的 schedule 往返为 undefined(= 原生默认来源)', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({ id: 'sch-no-provider' });
    try {
      harness.db.run(sql`
        INSERT INTO sessions (id, title, source, workspace_kind, created_at, updated_at, total_cost_usd)
        VALUES ('sess-subscription', 'Subscription session', 'desktop', 'dialogue', 1, 1, 0)
      `);
      await harness.storage.insert(schedule);
      const got = await harness.storage.get(schedule.id);
      expect(got?.providerId).toBeUndefined();
    } finally {
      harness.close();
    }
  });

  it('summarizes automation cost from scheduler turns instead of whole bound session cost', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({
      id: 'sch-cost',
      name: 'PR followup',
      targetSessionId: 'sess-bound',
    });

    try {
      harness.db.run(sql`
        INSERT INTO sessions (id, title, source, workspace_kind, working_dir, created_at, updated_at, total_cost_usd)
        VALUES ('sess-bound', 'Existing PR session', 'desktop', 'project', '/repo', 1, 1, 303.26)
      `);
      await harness.storage.insert(schedule);
      await harness.storage.insertRun({
        id: 'run-cost-1',
        scheduleId: schedule.id,
        sessionId: 'sess-bound',
        firedAt: 10,
        finishedAt: 40,
        status: 'success',
      });

      harness.db.run(sql`
        INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at, rewind_at)
        VALUES
          ('m1', 'm1', 'sess-bound', 'assistant', '{}', '{"turnCostUsd":123.45}', 1, NULL),
          ('z-user', 'z-user', 'sess-bound', 'user', '{}', '{"origin":{"kind":"scheduler","scheduleId":"sch-cost","scheduleName":"PR followup"}}', 10, NULL),
          ('a-assistant', 'a-assistant', 'sess-bound', 'assistant', '{}', '{"turnCostUsd":0.42}', 10, NULL),
          ('m4', 'm4', 'sess-bound', 'assistant', '{}', '{"turnCostUsd":0.08}', 30, NULL),
          ('m4-estimate', 'm4-estimate', 'sess-bound', 'assistant', '{}', '{"turnCostUsd":9.99,"turnCostIsEstimate":true}', 35, NULL),
          ('rewound-user', 'rewound-user', 'sess-bound', 'user', '{}', '{"origin":{"kind":"scheduler","scheduleId":"sch-cost","scheduleName":"PR followup"}}', 36, 60),
          ('rewound-assistant', 'rewound-assistant', 'sess-bound', 'assistant', '{}', '{"turnCostUsd":0.25}', 37, 60),
          ('m5', 'm5', 'sess-bound', 'user', '{}', NULL, 40, NULL),
          ('m6', 'm6', 'sess-bound', 'assistant', '{}', '{"turnCostUsd":44}', 50, NULL)
      `);

      await expect(harness.storage.listCostSummaries()).resolves.toEqual([
        {
          scheduleId: schedule.id,
          totalMoney: actualMoneyFromLegacyUsd(0.75),
          totalEstimatedValueMoney: estimatedMoneyFromLegacyUsd(9.99),
          sessionCount: 1,
          sessions: [
            {
              sessionId: 'sess-bound',
              totalMoney: actualMoneyFromLegacyUsd(0.75),
              totalEstimatedValueMoney: estimatedMoneyFromLegacyUsd(9.99),
            },
          ],
        },
      ]);
    } finally {
      harness.close();
    }
  });

  it('summarizes subscription value separately from billable cost', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({ id: 'sch-subscription', targetSessionId: 'sess-subscription' });
    try {
      harness.db.run(sql`
        INSERT INTO sessions (id, title, source, workspace_kind, created_at, updated_at, total_cost_usd)
        VALUES ('sess-subscription', 'Subscription session', 'desktop', 'dialogue', 1, 1, 0)
      `);
      await harness.storage.insert(schedule);
      await harness.storage.insertRun({
        id: 'run-subscription',
        scheduleId: schedule.id,
        sessionId: 'sess-subscription',
        firedAt: 10,
        finishedAt: 20,
        status: 'success',
      });
      harness.db.run(sql`
        INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
        VALUES
          ('subscription-user', 'subscription-user', 'sess-subscription', 'user', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-subscription"}}', 10),
          ('subscription-assistant', 'subscription-assistant', 'sess-subscription', 'assistant', '{}',
            '{"turnCostUsd":0.29,"turnCostIsEstimate":true}', 11)
      `);

      await expect(harness.storage.listCostSummaries()).resolves.toEqual([
        {
          scheduleId: schedule.id,
          totalMoney: ZERO_ACTUAL_MONEY,
          totalEstimatedValueMoney: estimatedMoneyFromLegacyUsd(0.29),
          sessionCount: 1,
          sessions: [
            {
              sessionId: 'sess-subscription',
              totalMoney: ZERO_ACTUAL_MONEY,
              totalEstimatedValueMoney: estimatedMoneyFromLegacyUsd(0.29),
            },
          ],
        },
      ]);
    } finally {
      harness.close();
    }
  });

  it('keeps API cost in the billable field', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({ id: 'sch-api', targetSessionId: 'sess-api' });
    try {
      harness.db.run(sql`
        INSERT INTO sessions (id, title, source, workspace_kind, created_at, updated_at, total_cost_usd)
        VALUES ('sess-api', 'API session', 'desktop', 'dialogue', 1, 1, 0)
      `);
      await harness.storage.insert(schedule);
      await harness.storage.insertRun({
        id: 'run-api',
        scheduleId: schedule.id,
        sessionId: 'sess-api',
        firedAt: 10,
        finishedAt: 20,
        status: 'success',
      });
      harness.db.run(sql`
        INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
        VALUES
          ('api-user', 'api-user', 'sess-api', 'user', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-api"}}', 10),
          ('api-assistant', 'api-assistant', 'sess-api', 'assistant', '{}',
            '{"turnCostUsd":0.42}', 11)
      `);

      await expect(harness.storage.listCostSummaries()).resolves.toEqual([
        {
          scheduleId: schedule.id,
          totalMoney: actualMoneyFromLegacyUsd(0.42),
          totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
          sessionCount: 1,
          sessions: [
            {
              sessionId: 'sess-api',
              totalMoney: actualMoneyFromLegacyUsd(0.42),
              totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
            },
          ],
        },
      ]);
    } finally {
      harness.close();
    }
  });

  it('includes direct run ledger costs when no assistant message can carry origin', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({ id: 'sch-direct', targetSessionId: 'sess-direct' });
    try {
      harness.db.run(sql`
        INSERT INTO sessions (id, title, source, workspace_kind, created_at, updated_at, total_cost_usd)
        VALUES ('sess-direct', 'Direct cost session', 'desktop', 'dialogue', 1, 1, 0.42)
      `);
      await harness.storage.insert(schedule);
      await harness.storage.insertRun({
        id: 'run-direct',
        scheduleId: schedule.id,
        sessionId: 'sess-direct',
        firedAt: 10,
        finishedAt: 20,
        status: 'success',
        costUsd: 0.42,
        costAttribution: 'exact',
      });

      await expect(harness.storage.listCostSummaries()).resolves.toEqual([
        {
          scheduleId: schedule.id,
          totalMoney: actualMoneyFromLegacyUsd(0.42),
          totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
          sessionCount: 1,
          sessions: [
            {
              sessionId: 'sess-direct',
              totalMoney: actualMoneyFromLegacyUsd(0.42),
              totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
            },
          ],
        },
      ]);
    } finally {
      harness.close();
    }
  });

  it('accumulates multiple direct run ledger segments', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({ id: 'sch-direct-segments' });
    const dbClient = { drizzle: harness.db } as unknown as DbClient;
    try {
      await harness.storage.insert(schedule);
      await harness.storage.insertRun({
        id: 'run-direct-segments',
        scheduleId: schedule.id,
        firedAt: 10,
        finishedAt: 20,
        status: 'success',
        costAttribution: 'unavailable',
      });
      setCurrentDbClient(dbClient, 'test-user');

      await recordScheduleRunCostDirect({
        runId: 'run-direct-segments',
        money: { amount: 0.42, currency: 'CNY', approximate: false, kind: 'actual-cost' },
      });
      await recordScheduleRunCostDirect({
        runId: 'run-direct-segments',
        money: { amount: 0.18, currency: 'CNY', approximate: false, kind: 'actual-cost' },
      });
      await recordScheduleRunCostDirect({
        runId: 'run-direct-segments',
        money: { amount: 0, currency: 'CNY', approximate: false, kind: 'actual-cost' },
      });

      await expect(harness.storage.listRuns(schedule.id)).resolves.toEqual([
        expect.objectContaining({
          id: 'run-direct-segments',
          costMoney: {
            amount: expect.closeTo(0.6, 10),
            currency: 'CNY',
            approximate: false,
            kind: 'actual-cost',
          },
          costAttribution: 'direct',
        }),
      ]);
    } finally {
      clearCurrentDbClient(dbClient);
      harness.close();
    }
  });

  it('keeps direct ledger remainder when a run also has message costs', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({ id: 'sch-mixed-ledger', targetSessionId: 'sess-mixed-ledger' });
    try {
      harness.db.run(sql`
        INSERT INTO sessions (id, title, source, workspace_kind, created_at, updated_at, total_cost_usd)
        VALUES ('sess-mixed-ledger', 'Mixed ledger session', 'desktop', 'dialogue', 1, 1, 0)
      `);
      await harness.storage.insert(schedule);
      await harness.storage.insertRun({
        id: 'run-mixed-ledger',
        scheduleId: schedule.id,
        sessionId: 'sess-mixed-ledger',
        firedAt: 10,
        finishedAt: 20,
        status: 'success',
        costUsd: 0.6,
        costAttribution: 'mixed',
      });
      harness.db.run(sql`
        INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
        VALUES
          ('mixed-user', 'mixed-user', 'sess-mixed-ledger', 'user', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-mixed-ledger","runId":"run-mixed-ledger"}}', 10),
          ('mixed-assistant', 'mixed-assistant', 'sess-mixed-ledger', 'assistant', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-mixed-ledger","runId":"run-mixed-ledger"},"turnCostUsd":0.42}', 11)
      `);

      await expect(harness.storage.listCostSummaries()).resolves.toEqual([
        {
          scheduleId: schedule.id,
          totalMoney: actualMoneyFromLegacyUsd(0.6),
          totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
          sessionCount: 1,
          sessions: [
            {
              sessionId: 'sess-mixed-ledger',
              totalMoney: actualMoneyFromLegacyUsd(0.6),
              totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
            },
          ],
        },
      ]);
    } finally {
      harness.close();
    }
  });

  it('merges direct-only snapshot with a later message ledger update', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({ id: 'sch-direct-only-snapshot', targetSessionId: 'sess-direct-only' });
    const dbClient = { drizzle: harness.db } as unknown as DbClient;
    try {
      harness.db.run(sql`
        INSERT INTO sessions (id, title, source, workspace_kind, created_at, updated_at, total_cost_usd)
        VALUES ('sess-direct-only', 'Direct-only snapshot session', 'desktop', 'dialogue', 1, 1, 0)
      `);
      await harness.storage.insert(schedule);
      await harness.storage.insertRun({
        id: 'run-direct-only-snapshot',
        scheduleId: schedule.id,
        sessionId: 'sess-direct-only',
        firedAt: 10,
        finishedAt: 20,
        status: 'success',
        costAttribution: 'unavailable',
      });
      setCurrentDbClient(dbClient, 'test-user');
      await recordScheduleRunCostDirect({
        runId: 'run-direct-only-snapshot',
        money: {
          amount: 4.02,
          currency: 'CNY',
          approximate: true,
          kind: 'actual-cost',
          estimateReasons: ['fixed-fx'],
        },
      });
      harness.db.run(sql`
        INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
        VALUES
          ('direct-only-user', 'direct-only-user', 'sess-direct-only', 'user', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-direct-only-snapshot","runId":"run-direct-only-snapshot"}}', 10),
          ('direct-only-assistant', 'direct-only-assistant', 'sess-direct-only', 'assistant', '{}',
            '{"origin":{"kind":"scheduler","scheduleId":"sch-direct-only-snapshot","runId":"run-direct-only-snapshot"},"turnCostUsd":0.4}', 11)
      `);

      await expect(harness.storage.listRuns(schedule.id)).resolves.toEqual([
        expect.objectContaining({
          id: 'run-direct-only-snapshot',
          costMoney: actualMoneyFromLegacyUsd(1),
          costAttribution: 'exact',
        }),
      ]);
      await expect(harness.storage.listCostSummaries()).resolves.toEqual([
        {
          scheduleId: schedule.id,
          totalMoney: actualMoneyFromLegacyUsd(1),
          totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
          sessionCount: 1,
          sessions: [
            {
              sessionId: 'sess-direct-only',
              totalMoney: actualMoneyFromLegacyUsd(1),
              totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
            },
          ],
        },
      ]);
    } finally {
      clearCurrentDbClient(dbClient);
      harness.close();
    }
  });

  it('marks runs with no reliable pricing as unavailable instead of zero', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({ id: 'sch-unavailable', targetSessionId: 'sess-unavailable' });
    try {
      harness.db.run(sql`
        INSERT INTO sessions (id, title, source, workspace_kind, created_at, updated_at, total_cost_usd)
        VALUES ('sess-unavailable', 'Unavailable cost session', 'desktop', 'dialogue', 1, 1, 0)
      `);
      await harness.storage.insert(schedule);
      await harness.storage.insertRun({
        id: 'run-unavailable',
        scheduleId: schedule.id,
        sessionId: 'sess-unavailable',
        firedAt: 10,
        finishedAt: 20,
        status: 'success',
        costAttribution: 'unavailable',
      });

      await expect(harness.storage.listCostSummaries()).resolves.toEqual([
        {
          scheduleId: schedule.id,
          totalMoney: ZERO_ACTUAL_MONEY,
          totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
          hasUnavailableCost: true,
          sessionCount: 1,
          sessions: [
            {
              sessionId: 'sess-unavailable',
              totalMoney: ZERO_ACTUAL_MONEY,
              totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
            },
          ],
        },
      ]);
    } finally {
      harness.close();
    }
  });

  it('keeps a confirmed zero-cost run distinct from unavailable pricing', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({ id: 'sch-zero', executionMode: 'script' });
    try {
      await harness.storage.insert(schedule);
      await harness.storage.insertRun({
        id: 'run-zero',
        scheduleId: schedule.id,
        firedAt: 10,
        finishedAt: 20,
        status: 'success',
        costAttribution: 'zero',
      });

      await expect(harness.storage.listCostSummaries()).resolves.toEqual([
        {
          scheduleId: schedule.id,
          totalMoney: ZERO_ACTUAL_MONEY,
          totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
          sessionCount: 0,
          sessions: [],
        },
      ]);
    } finally {
      harness.close();
    }
  });

  it('preserves legacy baseline when a scheduler session later gains turn costs', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({
      id: 'sch-mixed',
      name: 'legacy task',
      workspaceKind: 'project',
      workingDir: '/repo',
      persistentSession: true,
      targetSessionId: 'sess-legacy',
    });

    try {
      harness.db.run(sql`
        INSERT INTO sessions (id, title, source, workspace_kind, working_dir, created_at, updated_at, total_cost_usd)
        VALUES ('sess-legacy', '[Schedule] legacy task', 'scheduler', 'project', '/repo', 1, 60, 4.25)
      `);
      await harness.storage.insert(schedule);
      enableLegacySessionFallback(harness, schedule.id);
      harness.db.run(sql`
        INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
        VALUES
          ('mixed-user', 'mixed-user', 'sess-legacy', 'user', '{}', '{"origin":{"kind":"scheduler","scheduleId":"sch-mixed","scheduleName":"legacy task"}}', 40),
          ('mixed-assistant', 'mixed-assistant', 'sess-legacy', 'assistant', '{}', '{"turnCostUsd":1.25}', 50),
          ('structured-assistant', 'structured-assistant', 'sess-legacy', 'assistant', '{}', '{"turnCost":{"amount":5,"currency":"CNY","approximate":false,"kind":"actual-cost"}}', 52),
          ('manual-user', 'manual-user', 'sess-legacy', 'user', '{}', NULL, 55),
          ('manual-assistant', 'manual-assistant', 'sess-legacy', 'assistant', '{}', '{"turnCostUsd":2}', 60)
      `);

      await expect(harness.storage.listCostSummaries()).resolves.toEqual([
        {
          scheduleId: schedule.id,
          totalMoney: {
            ...actualMoneyFromLegacyUsd(2.25),
            amount: expect.closeTo(2.25 * 6.7 + 5, 10),
          },
          totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
          sessionCount: 1,
          sessions: [
            {
              sessionId: 'sess-legacy',
              totalMoney: {
                ...actualMoneyFromLegacyUsd(2.25),
                amount: expect.closeTo(2.25 * 6.7 + 5, 10),
              },
              totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
            },
          ],
        },
      ]);
    } finally {
      harness.close();
    }
  });

  it('subtracts post-metadata manual costs from unlinked legacy sessions', async () => {
    const harness = createStorageHarness();
    const schedule = baseSchedule({
      id: 'sch-unlinked',
      name: 'unlinked legacy',
      workspaceKind: 'project',
      workingDir: '/repo',
      persistentSession: true,
    });

    try {
      harness.db.run(sql`
        INSERT INTO sessions (id, title, source, workspace_kind, working_dir, created_at, updated_at, total_cost_usd)
        VALUES ('sess-unlinked', '[Schedule] unlinked legacy', 'scheduler', 'project', '/repo', 1, 60, 3.5)
      `);
      await harness.storage.insert(schedule);
      enableLegacySessionFallback(harness, schedule.id);

      harness.db.run(sql`
        INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
        VALUES
          ('unlinked-manual-user', 'unlinked-manual-user', 'sess-unlinked', 'user', '{}', NULL, 40),
          ('unlinked-manual-assistant', 'unlinked-manual-assistant', 'sess-unlinked', 'assistant', '{}', '{"turnCostUsd":2}', 50)
      `);

      await expect(harness.storage.listCostSummaries()).resolves.toEqual([
        {
          scheduleId: schedule.id,
          totalMoney: actualMoneyFromLegacyUsd(1.5),
          totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
          sessionCount: 1,
          sessions: [
            {
              sessionId: 'sess-unlinked',
              totalMoney: actualMoneyFromLegacyUsd(1.5),
              totalEstimatedValueMoney: ZERO_ESTIMATED_MONEY,
            },
          ],
        },
      ]);
    } finally {
      harness.close();
    }
  });

  it('does not attach retained legacy sessions to a deleted and recreated same-name schedule', async () => {
    const harness = createStorageHarness();
    const oldSchedule = baseSchedule({
      id: 'sch-old-generation',
      name: 'weekly summary',
      workingDir: '/repo',
    });
    const newSchedule = baseSchedule({
      id: 'sch-new-generation',
      name: oldSchedule.name,
      workingDir: oldSchedule.workingDir,
      createdAt: oldSchedule.createdAt + 10_000,
      updatedAt: oldSchedule.updatedAt + 10_000,
    });

    try {
      await harness.storage.insert(oldSchedule);
      // 模拟 0079 migration：升级时已经存在的任务保留 legacy fallback 资格。
      enableLegacySessionFallback(harness, oldSchedule.id);
      harness.db.run(sql`
        INSERT INTO sessions (
          id, title, source, workspace_kind, working_dir, created_at, updated_at, total_cost_usd
        ) VALUES
          (
            'sess-old-retained', '[Schedule] weekly summary', 'scheduler', 'project', '/repo',
            ${oldSchedule.createdAt + 1}, ${oldSchedule.createdAt + 2}, 4.25
          ),
          (
            'sess-old-archived', '[Schedule] weekly summary', 'scheduler', 'project', '/repo',
            ${oldSchedule.createdAt + 3}, ${oldSchedule.createdAt + 4}, 2.5
          ),
          (
            'sess-old-deleted', '[Schedule] weekly summary', 'scheduler', 'project', '/repo',
            ${oldSchedule.createdAt + 5}, ${oldSchedule.createdAt + 6}, 1.25
          )
      `);

      expect((await harness.storage.listRuns(oldSchedule.id)).map((run) => run.sessionId)).toEqual(
        expect.arrayContaining(['sess-old-retained', 'sess-old-archived', 'sess-old-deleted']),
      );

      // 分别模拟删除弹窗的三种会话处置：保留、归档、删除。
      await harness.storage.delete(oldSchedule.id);
      harness.db.run(sql`UPDATE sessions SET status = 'archived' WHERE id = 'sess-old-archived'`);
      harness.db.run(sql`DELETE FROM sessions WHERE id = 'sess-old-deleted'`);
      await harness.storage.insert(newSchedule);

      await expect(harness.storage.listRuns(newSchedule.id)).resolves.toEqual([]);
      expect(await harness.storage.listSidebarIndexRuns()).toEqual([]);
      expect(await harness.storage.listCostSummaries()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it('keeps legacy sessions owned by the fallback schedule when a duplicate is added', async () => {
    const harness = createStorageHarness();
    const legacySchedule = baseSchedule({
      id: 'sch-legacy-owner',
      name: 'weekly summary',
      workingDir: '/repo',
    });
    const duplicate = baseSchedule({
      id: 'sch-new-duplicate',
      name: legacySchedule.name,
      workingDir: legacySchedule.workingDir,
      createdAt: legacySchedule.createdAt + 10_000,
      updatedAt: legacySchedule.updatedAt + 10_000,
    });

    try {
      await harness.storage.insert(legacySchedule);
      enableLegacySessionFallback(harness, legacySchedule.id);
      harness.db.run(sql`
        INSERT INTO sessions (
          id, title, source, workspace_kind, working_dir, created_at, updated_at, total_cost_usd
        ) VALUES (
          'sess-legacy-owner', '[Schedule] weekly summary', 'scheduler', 'project', '/repo',
          ${legacySchedule.createdAt + 1}, ${legacySchedule.createdAt + 2}, 4.25
        )
      `);
      await harness.storage.insert(duplicate);

      await expect(harness.storage.listRuns(legacySchedule.id)).resolves.toEqual([
        expect.objectContaining({
          scheduleId: legacySchedule.id,
          sessionId: 'sess-legacy-owner',
        }),
      ]);
      await expect(harness.storage.listRuns(duplicate.id)).resolves.toEqual([]);
      await expect(harness.storage.listSidebarIndexRuns()).resolves.toEqual([
        expect.objectContaining({
          scheduleId: legacySchedule.id,
          sessionId: 'sess-legacy-owner',
        }),
      ]);
      await expect(harness.storage.listCostSummaries()).resolves.toEqual([
        expect.objectContaining({
          scheduleId: legacySchedule.id,
          sessionCount: 1,
        }),
      ]);
    } finally {
      harness.close();
    }
  });
});
