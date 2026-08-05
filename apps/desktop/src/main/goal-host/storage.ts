/**
 * GoalStorage —— `session_goals` 表的 SQLite 实现(GoalStorageLike)。
 *
 * 设计要点(对齐 scheduler-host/storage.ts):
 *   - 构造接收 `getDb: () => GoalDrizzleDb`(lazy):storage 可在 localDb 还没
 *     ensureReady 时就 new 出来,调用方法时才解引用 DB。
 *   - **所有方法 async + `await db.select()...`**:xdt-maker 的 localDb 是异步
 *     proxy 驱动(drizzle query builder 是 thenable),**不能**用 better-sqlite3
 *     的同步 `.all()` / `.run()` / `.get()`(运行时它们不返回数组,会抛
 *     `.all(...).map is not a function`)。这点必须与 DrizzleScheduleStorage 一致。
 *   - row ↔ GoalState 在本文件就地转换(goal 状态是 main 内部态,不像 Session/
 *     Schedule 需要跨 IPC 当完整域对象,故**不**进 localDb/mapper.ts,降低耦合)。
 *     drizzle 推断的 row 本就是 camelCase + 正确枚举类型,转换几乎是恒等。
 */

import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from '../localDb/schema';
import { sessionGoals } from '../localDb/schema';
import type { GoalState, GoalStorageLike } from './types';

export type GoalDrizzleDb = BetterSQLite3Database<typeof schema>;

type GoalRow = typeof sessionGoals.$inferSelect;
type GoalInsert = typeof sessionGoals.$inferInsert;

function rowToState(row: GoalRow): GoalState {
  return {
    sessionId: row.sessionId,
    objective: row.objective,
    status: row.status,
    budgetTokens: row.budgetTokens,
    maxTurns: row.maxTurns,
    noProgressLimit: row.noProgressLimit,
    turnsUsed: row.turnsUsed,
    tokensUsed: row.tokensUsed,
    noProgressStreak: row.noProgressStreak,
    usageResetAt: row.usageResetAt,
    lastReason: row.lastReason,
    agentKind: row.agentKind,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
  };
}

function stateToInsert(state: GoalState): GoalInsert {
  return {
    sessionId: state.sessionId,
    objective: state.objective,
    status: state.status,
    budgetTokens: state.budgetTokens,
    maxTurns: state.maxTurns,
    noProgressLimit: state.noProgressLimit,
    turnsUsed: state.turnsUsed,
    tokensUsed: state.tokensUsed,
    noProgressStreak: state.noProgressStreak,
    usageResetAt: state.usageResetAt,
    lastReason: state.lastReason,
    agentKind: state.agentKind,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  };
}

export class GoalStorage implements GoalStorageLike {
  constructor(private readonly getDb: () => GoalDrizzleDb) {}

  async get(sessionId: string): Promise<GoalState | null> {
    const rows = await this.getDb()
      .select()
      .from(sessionGoals)
      .where(eq(sessionGoals.sessionId, sessionId))
      .limit(1);
    return rows.length > 0 ? rowToState(rows[0]) : null;
  }

  /**
   * 整行写入(创建 / 替换)。**原子 upsert**:单条 INSERT ... ON CONFLICT DO UPDATE,
   * sessionId 为主键,冲突即整行覆盖 —— 取代旧的 delete+insert(两步之间崩溃会丢行)。
   * 同一 BetterSQLite3 db 上 dailySpend / recentWorkdirs 等模块均用此原语,proxy 行为已验证。
   */
  async upsert(state: GoalState): Promise<void> {
    const row = stateToInsert(state);
    await this.getDb()
      .insert(sessionGoals)
      .values(row)
      .onConflictDoUpdate({ target: sessionGoals.sessionId, set: row });
  }

  /** 部分更新;找不到行返回 null(不 throw),与 scheduler storage 契约一致。 */
  async update(sessionId: string, patch: Partial<GoalState>): Promise<GoalState | null> {
    const existing = await this.get(sessionId);
    if (!existing) return null;
    // 只挑允许更新的列,避免把 sessionId/startedAt 等覆盖掉。
    const set: Partial<GoalInsert> = {};
    if (patch.objective !== undefined) set.objective = patch.objective;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.budgetTokens !== undefined) set.budgetTokens = patch.budgetTokens;
    if (patch.maxTurns !== undefined) set.maxTurns = patch.maxTurns;
    if (patch.noProgressLimit !== undefined) set.noProgressLimit = patch.noProgressLimit;
    if (patch.turnsUsed !== undefined) set.turnsUsed = patch.turnsUsed;
    if (patch.tokensUsed !== undefined) set.tokensUsed = patch.tokensUsed;
    if (patch.noProgressStreak !== undefined) set.noProgressStreak = patch.noProgressStreak;
    if (patch.usageResetAt !== undefined) set.usageResetAt = patch.usageResetAt;
    if (patch.lastReason !== undefined) set.lastReason = patch.lastReason;
    if (patch.updatedAt !== undefined) set.updatedAt = patch.updatedAt;
    if (Object.keys(set).length === 0) return existing;
    await this.getDb().update(sessionGoals).set(set).where(eq(sessionGoals.sessionId, sessionId));
    return this.get(sessionId);
  }

  async clear(sessionId: string): Promise<void> {
    await this.getDb().delete(sessionGoals).where(eq(sessionGoals.sessionId, sessionId));
  }

  async listActive(): Promise<GoalState[]> {
    const rows = await this.getDb()
      .select()
      .from(sessionGoals)
      .where(eq(sessionGoals.status, 'active'));
    return rows.map(rowToState);
  }

  async listUsageLimited(): Promise<GoalState[]> {
    const rows = await this.getDb()
      .select()
      .from(sessionGoals)
      .where(eq(sessionGoals.status, 'usageLimited'));
    return rows.map(rowToState);
  }
}
