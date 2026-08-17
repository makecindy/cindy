/**
 * Phase 2: DrizzleScheduleStorage —— `ScheduleStorage` 接口的 SQLite 实现。
 *
 * 设计要点：
 *   - **构造接收 `getDb: () => DrizzleDb`**，沿用 maker-host / sessions IPC 的 lazy
 *     模式（参见 `localDb/index.ts:35` getDrizzle）。这样 storage 实例可在
 *     localDb 还没 ensureReady 时就 new 出来，调用方法时才解引用 DB。
 *   - **只 import 来自 `@cindy/maker-scheduler` 的 type/interface**（type-only），
 *     **绝不** import 引擎类（Scheduler / nextRun）。Phase 2 hardrule。
 *   - **storage 不生成 run id**：Plan 明示 id 由 Scheduler 引擎传入 `insertRun(run)`。
 *   - **`update(id, patch)` 找不到 row 时返回 `null`，不 throw**：与 Phase 1 接口
 *     契约一致（参见 Phase 1 changelog L1133）。drizzle 的 update 不会自动 throw，
 *     需要主动 select 验证是否真的命中了行。
 *   - snake↔camel 全部走 `localDb/mapper.ts`，本文件不写字段转换代码。
 */

import { eq, desc, and, isNull, isNotNull, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { broadcastSessionPatched } from '../localDb/ipc/sessions.js';

import type { Schedule, ScheduleRun, ScheduleStorage, ListFilter } from '@cindy/maker-scheduler';

import * as schema from '../localDb/schema';
import { messages, schedules, scheduleRuns, sessions } from '../localDb/schema';
import {
  scheduleToCamel,
  scheduleCreateToRow,
  schedulePatchToRow,
  scheduleRunToCamel,
  scheduleRunCreateToRow,
  scheduleRunPatchToRow,
} from '../localDb/mapper';
import {
  addRegionalMoney,
  asValueEstimateMoney,
  DEFAULT_USAGE_CURRENCY,
  legacyUsdMoney,
  normalizeRegionalMoney,
  type RegionalMoney,
  zeroUsageMoney,
} from '../../shared/regionalMoney.js';
import { sdkEstimatedValuePart } from '../../shared/customProviderBilling.js';
import { normalizeTurnUsageDetails } from '../../shared/turnUsageDetails.js';

export type SchedulerDrizzleDb = BetterSQLite3Database<typeof schema>;

export interface ScheduleSidebarIndexRun {
  runId: string;
  scheduleId: string;
  scheduleName: string;
  scheduleStatus: Schedule['status'];
  scheduleSource?: Schedule['source'];
  nextFireAt?: number;
  workingDir?: string;
  projectConfigId?: string;
  sessionId?: string;
  status: ScheduleRun['status'];
  readAt?: number;
}

export interface ScheduleCostSummary {
  scheduleId: string;
  totalMoney: RegionalMoney;
  totalEstimatedValueMoney: RegionalMoney;
  totalSdkEstimatedValueMoney?: RegionalMoney;
  totalCostUsd?: number;
  totalEstimatedValueUsd?: number;
  /** 至少一轮 agent run 无法得到可靠费用。 */
  hasUnavailableCost?: boolean;
  sessionCount: number;
  sessions: ScheduleSessionCostSummary[];
}

export interface ScheduleSessionCostSummary {
  sessionId: string;
  totalMoney: RegionalMoney;
  totalEstimatedValueMoney: RegionalMoney;
  totalSdkEstimatedValueMoney?: RegionalMoney;
  totalCostUsd?: number;
  totalEstimatedValueUsd?: number;
}

interface ScheduleMoneyValues {
  costValues: RegionalMoney[];
  estimatedValueValues: RegionalMoney[];
  sdkEstimatedValueValues: RegionalMoney[];
  /** 最新一笔金额的币种(按时间戳取最大)——汇总聚合的偏好币种。 */
  latestCurrency?: RegionalMoney['currency'];
  latestCurrencyAt?: number;
}

/**
 * 记录「当前账本币种」:跨币种切换的 schedule 汇总必须偏好最新片段的币种,
 * 静态 USD 偏好会让任意历史 USD 片段把切换后的新币种 run 整段挤出汇总。
 */
function noteLatestCurrency(
  values: ScheduleMoneyValues,
  money: RegionalMoney | null | undefined,
  at: number,
): void {
  if (!money || money.amount <= 0) return;
  if (values.latestCurrencyAt === undefined || at >= values.latestCurrencyAt) {
    values.latestCurrencyAt = at;
    values.latestCurrency = money.currency;
  }
}

interface ScheduleTurnCostState extends ScheduleMoneyValues {
  hasUnavailableCost: boolean;
  sessionIds: Set<string>;
  sessionCosts: Map<string, ScheduleMoneyValues>;
}

function emptyScheduleMoneyValues(): ScheduleMoneyValues {
  return {
    costValues: [],
    estimatedValueValues: [],
    sdkEstimatedValueValues: [],
  };
}

function emptyScheduleTurnCostState(): ScheduleTurnCostState {
  return {
    ...emptyScheduleMoneyValues(),
    hasUnavailableCost: false,
    sessionIds: new Set<string>(),
    sessionCosts: new Map<string, ScheduleMoneyValues>(),
  };
}

/**
 * 与 shared addCompatibleRegionalMoney 同语义的本地版(带显式 preferred 参数
 * 的调用点较多故保留):preferred 币种没有任何值时回退第一个 actual-cost 值
 * 的币种——全 CNY(来源真声明)账本绝不能被 USD 偏好清零。
 */
function addCompatibleRegionalMoney(
  values: readonly RegionalMoney[],
  currency: RegionalMoney['currency'] = DEFAULT_USAGE_CURRENCY,
): RegionalMoney | null {
  if (values.length === 0) return null;
  const actualValues = values.filter((value) => value.kind === 'actual-cost');
  const candidates = actualValues.length > 0 ? actualValues : values;
  const effective =
    candidates.find((value) => value.currency === currency)?.currency ??
    candidates[0].currency;
  const compatible = values.filter((value) => value.currency === effective);
  return compatible.length > 0 ? addRegionalMoney(compatible) : null;
}

// Keep IN (...) bind counts well below SQLite's historical 999 variable limit.
const SQLITE_IN_CHUNK_SIZE = 500;

interface LegacyScheduleLookupEntry {
  id: string;
  name: string;
  status: Schedule['status'];
  source?: Schedule['source'];
  nextFireAt?: number;
  workspaceKind: Schedule['workspaceKind'];
  workingDir?: string;
  projectConfigId?: string;
}

interface LegacyScheduleSessionAlias {
  name: string;
  workspaceKind: Schedule['workspaceKind'];
  workingDir?: string | null;
}

const LEGACY_SCHEDULE_TITLE_PREFIX = '[Schedule] ';
const LEGACY_SESSION_RUN_ID_PREFIX = 'legacy-session:';

const UNREAD_TERMINAL_RUN_STATUSES: ScheduleRun['status'][] = [
  'success',
  'failed',
  'aborted',
  'interrupted',
];

function toScheduleSource(value: string | null): Schedule['source'] | undefined {
  if (value === 'user' || value === 'project') return value;
  return undefined;
}

function legacyScheduleTitle(name: string): string {
  return `${LEGACY_SCHEDULE_TITLE_PREFIX}${name}`;
}

function legacyTitleWhere() {
  return and(
    eq(sessions.source, 'scheduler'),
    sql`${sessions.title} LIKE ${`${LEGACY_SCHEDULE_TITLE_PREFIX}%`}`,
  );
}

function legacyScheduleNameFromSessionTitle(title: string): string | null {
  if (!title.startsWith(LEGACY_SCHEDULE_TITLE_PREFIX)) return null;
  const name = title.slice(LEGACY_SCHEDULE_TITLE_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

function legacyScheduleKey(input: {
  name: string;
  workspaceKind: Schedule['workspaceKind'];
  workingDir?: string | null;
}): string {
  const dir =
    input.workspaceKind === 'dialogue'
      ? '__dialogue__'
      : (input.workingDir ?? '__no_working_dir__');
  return `${input.workspaceKind}\u0000${dir}\u0000${input.name}`;
}

interface PersistedSchedulerOrigin {
  scheduleId: string;
  runId?: string;
}

function scheduleOriginFromAgentMeta(agentMeta: string | null): PersistedSchedulerOrigin | null {
  if (!agentMeta) return null;
  try {
    const parsed = JSON.parse(agentMeta) as {
      origin?: { kind?: unknown; scheduleId?: unknown; runId?: unknown };
    };
    const origin = parsed.origin;
    if (origin?.kind !== 'scheduler' || typeof origin.scheduleId !== 'string') return null;
    if (origin.scheduleId.length === 0) return null;
    return {
      scheduleId: origin.scheduleId,
      ...(typeof origin.runId === 'string' && origin.runId.length > 0
        ? { runId: origin.runId }
        : {}),
    };
  } catch {
    return null;
  }
}

function turnCostFromAgentMeta(agentMeta: string | null): {
  costMoney: RegionalMoney | null;
  estimatedValueMoney: RegionalMoney | null;
  sdkEstimatedValueMoney: RegionalMoney | null;
  legacyProjectedActualAmount: number;
} {
  if (!agentMeta) {
    return {
      costMoney: null,
      estimatedValueMoney: null,
      sdkEstimatedValueMoney: null,
      legacyProjectedActualAmount: 0,
    };
  }
  try {
    const parsed = JSON.parse(agentMeta) as {
      turnCost?: unknown;
      turnCostUsd?: unknown;
      turnCostIsEstimate?: unknown;
      turnCostIsCustomProvider?: unknown;
      turnUsageDetails?: unknown;
    };
    const structured = normalizeRegionalMoney(parsed.turnCost);
    const legacy =
      typeof parsed.turnCostUsd === 'number' &&
      Number.isFinite(parsed.turnCostUsd) &&
      parsed.turnCostUsd > 0
        ? legacyUsdMoney(parsed.turnCostUsd)
        : undefined;
    const money = structured ?? legacy;
    if (!money || money.amount <= 0) {
      return {
        costMoney: null,
        estimatedValueMoney: null,
        sdkEstimatedValueMoney: null,
        legacyProjectedActualAmount: 0,
      };
    }
    const turnUsageDetails = normalizeTurnUsageDetails(parsed.turnUsageDetails);
    const sdkEstimatedValueMoney = sdkEstimatedValuePart(
      money,
      turnUsageDetails?.perModelCost?.map((entry) => entry.money),
      parsed.turnCostIsCustomProvider === true,
    );
    const isHistoricalCustomProviderSdkCost =
      money.kind === 'actual-cost' && sdkEstimatedValueMoney !== null;
    const isEstimate =
      parsed.turnCostIsEstimate === true ||
      money.kind === 'value-estimate' ||
      isHistoricalCustomProviderSdkCost;
    return {
      costMoney: isEstimate ? null : money,
      estimatedValueMoney: isEstimate
        ? isHistoricalCustomProviderSdkCost
          ? sdkEstimatedValueMoney
          : asValueEstimateMoney(money)
        : null,
      sdkEstimatedValueMoney: isEstimate ? sdkEstimatedValueMoney : null,
      legacyProjectedActualAmount: !structured && !isEstimate ? money.amount : 0,
    };
  } catch {
    return {
      costMoney: null,
      estimatedValueMoney: null,
      sdkEstimatedValueMoney: null,
      legacyProjectedActualAmount: 0,
    };
  }
}

function finitePositiveNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function legacyRunFromSession(
  scheduleId: string,
  row: {
    id: string;
    userSendAt: number | null;
    createdAt: number;
    updatedAt: number;
  },
): ScheduleRun {
  const firedAt = row.userSendAt ?? row.createdAt ?? row.updatedAt;
  const finishedAt = row.updatedAt ?? firedAt;
  return {
    id: `${LEGACY_SESSION_RUN_ID_PREFIX}${row.id}`,
    scheduleId,
    sessionId: row.id,
    firedAt,
    finishedAt,
    status: 'success',
    costUsd: 0,
    estimatedValueUsd: 0,
    costAttribution: 'legacy',
    // Legacy fallback sessions have no schedule_runs.read_at row. Treat them as read
    // so old imported history does not create new attention dots.
    readAt: finishedAt,
  };
}

export class DrizzleScheduleStorage implements ScheduleStorage {
  constructor(private readonly getDb: () => SchedulerDrizzleDb) {}

  // ---------- Schedule CRUD ----------

  async list(filter?: ListFilter): Promise<Schedule[]> {
    const db = this.getDb();
    const query = db.select().from(schedules);
    const rows = filter?.status
      ? await query.where(eq(schedules.status, filter.status))
      : await query;
    return rows.map(scheduleToCamel);
  }

  async listActive(): Promise<Schedule[]> {
    const db = this.getDb();
    const rows = await db.select().from(schedules).where(eq(schedules.status, 'active'));
    return rows.map(scheduleToCamel);
  }

  async get(id: string): Promise<Schedule | null> {
    const db = this.getDb();
    const [row] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
    return row ? scheduleToCamel(row) : null;
  }

  async insert(s: Schedule): Promise<Schedule> {
    const db = this.getDb();
    await db.insert(schedules).values(scheduleCreateToRow(s));
    // 返回 round-tripped 版本（确保 timezone/booleans/默认值都按 DB 实际形态回流）
    const inserted = await this.get(s.id);
    if (!inserted) {
      // 理论上不可能：刚插完；防御性 throw 让上层立刻看到
      throw new Error(`DrizzleScheduleStorage: insert verify failed for id=${s.id}`);
    }
    return inserted;
  }

  async update(id: string, patch: Partial<Schedule>): Promise<Schedule | null> {
    const db = this.getDb();
    const setObj = schedulePatchToRow(patch);
    if (Object.keys(setObj).length === 0) {
      // patch 为空：不发 UPDATE，但仍然返回当前 row（或 null）以保持语义一致
      return this.get(id);
    }
    await db.update(schedules).set(setObj).where(eq(schedules.id, id));
    // drizzle update 不会 throw "not found"——主动 SELECT 验证
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    const db = this.getDb();
    // schedule_runs.schedule_id ON DELETE CASCADE，相关 run 由 SQLite 自动清
    await db.delete(schedules).where(eq(schedules.id, id));
  }

  /**
   * 跨进程"认领"一次到点触发(dev / release 双开共用同一 DB 时的互斥核心)。
   * 单条 UPDATE 做 compare-and-swap:仅当任务仍 active 且 next_fire_at 仍等于
   * 调用方内存里看到的 expected 值时,把 next_fire_at 置 NULL(= 这次触发已被
   * 本进程拿走)。两个进程同时到点只会有一个 UPDATE 命中行;另一个 changes=0
   * → 返回 null,引擎据此放弃本次触发。原子性由 SQLite 单语句写锁保证。
   */
  async claimDueFire(id: string, expectedNextFireAt: number): Promise<Schedule | null> {
    const db = this.getDb();
    // ⚠️ 写操作要读 changes 必须显式 .run():主进程的 db 实际是 drizzleProxy
    // (worker RPC 代理),隐式 await(then → executeAll)对非 SELECT 会丢弃写结果
    // 返回 [],changes 永远是 undefined;只有 .run() 终结符透传 worker 返回的
    // { changes, lastInsertRowid }。真 better-sqlite3 drizzle 下 .run() 同样返回
    // RunResult,两种环境形状一致。本文件其余读 changes 处同此约束。
    const result = await db
      .update(schedules)
      .set({ nextFireAt: null })
      .where(
        and(
          eq(schedules.id, id),
          eq(schedules.status, 'active'),
          eq(schedules.nextFireAt, expectedNextFireAt),
        ),
      )
      .run();
    const changes = (result as unknown as { changes?: number }).changes;
    // changes 读不到(驱动返回形状变化)必须 throw 而不是按"输"处理:UPDATE 可能已
    // 生效,按输返回 null 会置空 nextFireAt 又放弃执行,任务静默停摆到下次重启。
    // throw 落进引擎的 catch 分支(放回内存、下个 tick 重试),方向安全。
    if (typeof changes !== 'number') {
      throw new Error('claimDueFire: sqlite driver did not report changes count');
    }
    if (changes === 0) return null;
    return this.get(id);
  }

  // ---------- ScheduleRun CRUD ----------

  async insertRun(run: ScheduleRun): Promise<ScheduleRun> {
    const db = this.getDb();
    await db.insert(scheduleRuns).values(scheduleRunCreateToRow(run));
    const [row] = await db.select().from(scheduleRuns).where(eq(scheduleRuns.id, run.id)).limit(1);
    if (!row) {
      throw new Error(`DrizzleScheduleStorage: insertRun verify failed for id=${run.id}`);
    }
    return scheduleRunToCamel(row);
  }

  async updateRun(id: string, patch: Partial<ScheduleRun>): Promise<ScheduleRun | null> {
    const db = this.getDb();
    const setObj = scheduleRunPatchToRow(patch);
    if (Object.keys(setObj).length === 0) {
      const [row] = await db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)).limit(1);
      return row ? scheduleRunToCamel(row) : null;
    }
    await db.update(scheduleRuns).set(setObj).where(eq(scheduleRuns.id, id));
    const [row] = await db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)).limit(1);
    // 联动:run 终态落 finishedAt 时,把绑定 session 的 updatedAt 一并推到该时刻。
    // 侧栏时间轴统一读 sessions.updatedAt,"任务结束"作为一次会话被推进的动作,
    // 必须进入这个时间轴 —— 否则用户看到的会话时间在 run 结束后停在 fire 触发那刻,
    // 与"刚跑完一轮"直觉相悖(schedules.lastFinishedAt / schedule_runs.finishedAt
    // 同一时刻写入,这里挑 run 侧作为唯一联动点,避免 schedule 侧再重复一次)。
    if (patch.finishedAt !== undefined && row?.sessionId) {
      await db
        .update(sessions)
        // 用 MAX 防止倒退：若另一路径（用户发送/clear）在 run 结束前已推进了
        // updatedAt，不应该被 finishedAt 覆盖回旧值。
        .set({ updatedAt: sql`MAX(${sessions.updatedAt}, ${patch.finishedAt})` })
        .where(eq(sessions.id, row.sessionId));
      // 双路广播（webContents.send + device-link tap）让本机和远端 renderer
      // sessionsStore.patchLocal 就地更新 updatedAt，侧栏时间立即跳到"刚跑完"。
      broadcastSessionPatched(row.sessionId, {
        updatedAt: new Date(patch.finishedAt).toISOString(),
      });
    }
    return row ? scheduleRunToCamel(row) : null;
  }

  async listRuns(scheduleId: string, limit?: number): Promise<ScheduleRun[]> {
    const db = this.getDb();
    const cap = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50;
    const [scheduleRow] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.id, scheduleId))
      .limit(1);
    const rows = await db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.scheduleId, scheduleId))
      // 最近的一次在前，便于 UI 抽屉直接展示
      .orderBy(desc(scheduleRuns.firedAt))
      .limit(cap);
    const runs = await this.hydrateRunCostsFromMessages(db, rows.map(scheduleRunToCamel));
    if (!scheduleRow) return runs;

    const linkedSessionIds = new Set(
      runs.map((run) => run.sessionId).filter((id): id is string => Boolean(id)),
    );
    const legacyAliases = await this.listLegacyAliasesForSchedule(db, scheduleToCamel(scheduleRow));
    const legacyRuns = await this.listLegacySessionRuns(
      db,
      scheduleRow.id,
      linkedSessionIds,
      legacyAliases,
    );
    return [...runs, ...legacyRuns].sort((a, b) => b.firedAt - a.firedAt).slice(0, cap);
  }

  /**
   * message agent_meta 是 runId + 单段费用的持久化账本。正常路径已同步更新
   * schedule_runs 聚合；这里在读取时用消息账本覆盖，修复进程恰好在两次写之间退出
   * 留下的短暂不一致。legacy run 没有 runId，保持“不可精确拆分”。
   */
  private async hydrateRunCostsFromMessages(
    db: SchedulerDrizzleDb,
    runs: ScheduleRun[],
  ): Promise<ScheduleRun[]> {
    const attributableRunIds = new Set(
      runs.filter((run) => run.costAttribution !== 'legacy').map((run) => run.id),
    );
    const sessionIds = new Set(
      runs
        .filter((run) => attributableRunIds.has(run.id))
        .map((run) => run.sessionId)
        .filter((id): id is string => Boolean(id)),
    );
    if (attributableRunIds.size === 0 || sessionIds.size === 0) {
      return runs;
    }

    const rows = (
      await Promise.all(
        chunkArray([...sessionIds], SQLITE_IN_CHUNK_SIZE).map((sessionIdChunk) =>
          db
            .select({ agentMeta: messages.agentMeta })
            .from(messages)
            .where(
              and(inArray(messages.sessionId, sessionIdChunk), eq(messages.role, 'assistant')),
            ),
        ),
      )
    ).flat();
    const ledger = new Map<
      string,
      {
        costValues: RegionalMoney[];
        estimatedValues: RegionalMoney[];
        sdkEstimatedValues: RegionalMoney[];
      }
    >();
    for (const row of rows) {
      const origin = scheduleOriginFromAgentMeta(row.agentMeta);
      if (!origin?.runId || !attributableRunIds.has(origin.runId)) continue;
      const cost = turnCostFromAgentMeta(row.agentMeta);
      const current = ledger.get(origin.runId) ?? {
        costValues: [],
        estimatedValues: [],
        sdkEstimatedValues: [],
      };
      if (cost.costMoney) current.costValues.push(cost.costMoney);
      if (cost.estimatedValueMoney) {
        current.estimatedValues.push(cost.estimatedValueMoney);
      }
      if (cost.sdkEstimatedValueMoney) {
        current.sdkEstimatedValues.push(cost.sdkEstimatedValueMoney);
      }
      ledger.set(origin.runId, current);
    }

    return runs.map((run) => {
      const persisted = ledger.get(run.id);
      if (!persisted) return run;
      if (run.costAttribution === 'direct') {
        const costValues = [
          ...(run.costMoney && run.costMoney.amount > 0 ? [run.costMoney] : []),
          ...persisted.costValues,
        ];
        const estimatedValues = [
          ...(run.estimatedValueMoney && run.estimatedValueMoney.amount > 0
            ? [run.estimatedValueMoney]
            : []),
          ...persisted.estimatedValues,
        ];
        const sdkEstimatedValues = [
          ...(run.sdkEstimatedValueMoney && run.sdkEstimatedValueMoney.amount > 0
            ? [run.sdkEstimatedValueMoney]
            : []),
          ...persisted.sdkEstimatedValues,
        ];
        return {
          ...run,
          costMoney:
            addCompatibleRegionalMoney(
              costValues,
              run.costMoney?.currency,
            ) ?? zeroUsageMoney(),
          estimatedValueMoney:
            addCompatibleRegionalMoney(
              estimatedValues,
              run.estimatedValueMoney?.currency,
            ) ?? zeroUsageMoney('value-estimate'),
          sdkEstimatedValueMoney:
            addCompatibleRegionalMoney(
              sdkEstimatedValues,
              run.sdkEstimatedValueMoney?.currency,
            ) ?? undefined,
          costAttribution: 'exact',
        };
      }
      if (run.costAttribution === 'mixed') {
        return { ...run, costAttribution: 'exact' };
      }
      return {
        ...run,
        costMoney:
          addCompatibleRegionalMoney(persisted.costValues) ??
          zeroUsageMoney(),
        estimatedValueMoney:
          addCompatibleRegionalMoney(persisted.estimatedValues) ??
          zeroUsageMoney('value-estimate'),
        sdkEstimatedValueMoney:
          addCompatibleRegionalMoney(persisted.sdkEstimatedValues) ?? undefined,
        costAttribution: 'exact',
      };
    });
  }

  /**
   * Sidebar 聚合索引用的轻量 run 列表：
   * - 所有带 sessionId 的 run 都返回，保证高频 schedule 超过 history limit 后仍能归组。
   * - 额外包含无 sessionId 的未读终态 run，保证自动化任务列表的小红点不被漏掉。
   */
  async listSidebarIndexRuns(): Promise<ScheduleSidebarIndexRun[]> {
    const db = this.getDb();
    const rows = await db
      .select({
        runId: scheduleRuns.id,
        scheduleId: schedules.id,
        scheduleName: schedules.name,
        scheduleStatus: schedules.status,
        scheduleSource: schedules.source,
        nextFireAt: schedules.nextFireAt,
        workingDir: schedules.workingDir,
        projectConfigId: schedules.projectConfigId,
        sessionId: scheduleRuns.sessionId,
        status: scheduleRuns.status,
        readAt: scheduleRuns.readAt,
      })
      .from(scheduleRuns)
      .innerJoin(schedules, eq(scheduleRuns.scheduleId, schedules.id))
      .where(
        or(
          isNotNull(scheduleRuns.sessionId),
          and(
            isNull(scheduleRuns.readAt),
            inArray(scheduleRuns.status, UNREAD_TERMINAL_RUN_STATUSES),
          ),
        ),
      );

    const indexedRuns = rows.map((row) => ({
      runId: row.runId,
      scheduleId: row.scheduleId,
      scheduleName: row.scheduleName,
      scheduleStatus: row.scheduleStatus,
      scheduleSource: toScheduleSource(row.scheduleSource),
      nextFireAt: row.nextFireAt ?? undefined,
      workingDir: row.workingDir ?? undefined,
      projectConfigId: row.projectConfigId ?? undefined,
      sessionId: row.sessionId ?? undefined,
      status: row.status,
      readAt: row.readAt ?? undefined,
    }));

    const linkedSessionIds = new Set(
      indexedRuns.map((run) => run.sessionId).filter((id): id is string => Boolean(id)),
    );
    const scheduleByLegacyKey = await this.listSchedulesByLegacyKey(db);
    const legacySessions = await db
      .select({
        id: sessions.id,
        title: sessions.title,
        workspaceKind: sessions.workspaceKind,
        workingDir: sessions.workingDir,
        updatedAt: sessions.updatedAt,
      })
      .from(sessions)
      .where(legacyTitleWhere());
    const legacyRuns: ScheduleSidebarIndexRun[] = [];

    for (const session of legacySessions) {
      if (linkedSessionIds.has(session.id)) continue;
      const name = legacyScheduleNameFromSessionTitle(session.title);
      if (!name) continue;
      const schedule = scheduleByLegacyKey.get(
        legacyScheduleKey({
          name,
          workspaceKind: session.workspaceKind,
          workingDir: session.workingDir,
        }),
      );
      if (!schedule) continue;

      legacyRuns.push({
        runId: `${LEGACY_SESSION_RUN_ID_PREFIX}${session.id}`,
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        scheduleStatus: schedule.status,
        scheduleSource: schedule.source,
        nextFireAt: schedule.nextFireAt,
        workingDir: schedule.workingDir,
        projectConfigId: schedule.projectConfigId,
        sessionId: session.id,
        status: 'success',
        // Legacy rows have no schedule_runs.read_at. Treat them as read so old
        // history can group under the real schedule without creating new dots.
        readAt: session.updatedAt,
      });
    }

    return [...indexedRuns, ...legacyRuns];
  }

  /**
   * Automation 任务总开销：新数据按 scheduler user 消息标记的 turn 归属汇总
   * messages.agent_meta.turnCostUsd；绑定到已有会话时不把整条 session 的历史 cost 算进来。
   * 老数据没有 origin 标记，继续按 legacy schedule session 的总 cost 兜底。
   */
  async listCostSummaries(): Promise<ScheduleCostSummary[]> {
    const db = this.getDb();
    const runCostRows = (await db.select().from(scheduleRuns)).map(scheduleRunToCamel);

    const bySchedule = new Map<string, ScheduleTurnCostState>();
    const linkedSessionIds = new Set<string>();
    const linkedScheduleIds = new Set<string>();
    for (const row of runCostRows) {
      linkedScheduleIds.add(row.scheduleId);
      if (row.sessionId) linkedSessionIds.add(row.sessionId);
    }

    const scheduleByLegacyKey = await this.listSchedulesByLegacyKey(db);

    const legacySessions = await db
      .select({
        id: sessions.id,
        title: sessions.title,
        workspaceKind: sessions.workspaceKind,
        workingDir: sessions.workingDir,
        totalCostUsd: sessions.totalCostUsd,
      })
      .from(sessions)
      .where(legacyTitleWhere());

    const legacySessionScheduleIds = new Map<string, string>();
    const scanSessionIds = new Set(linkedSessionIds);
    for (const session of legacySessions) {
      const name = legacyScheduleNameFromSessionTitle(session.title);
      if (!name) continue;
      const schedule = scheduleByLegacyKey.get(
        legacyScheduleKey({
          name,
          workspaceKind: session.workspaceKind,
          workingDir: session.workingDir,
        }),
      );
      if (!schedule) continue;
      legacySessionScheduleIds.set(session.id, schedule.id);
      scanSessionIds.add(session.id);
      linkedScheduleIds.add(schedule.id);
    }

    const messageRows =
      scanSessionIds.size === 0
        ? []
        : (
            await Promise.all(
              chunkArray([...scanSessionIds], SQLITE_IN_CHUNK_SIZE).map((sessionIdChunk) =>
                db
                  .select({
                    sessionId: messages.sessionId,
                    role: messages.role,
                    agentMeta: messages.agentMeta,
                    createdAt: messages.createdAt,
                    id: messages.id,
                  })
                  .from(messages)
                  .where(
                    and(
                      inArray(messages.sessionId, sessionIdChunk),
                      inArray(messages.role, ['user', 'assistant']),
                    ),
                  )
                  .orderBy(
                    messages.sessionId,
                    messages.createdAt,
                    // If a scheduler user message and its assistant result land in the
                    // same millisecond, the user row must establish activeScheduleId first.
                    sql`case ${messages.role} when 'user' then 0 else 1 end`,
                    messages.id,
                  ),
              ),
            )
          ).flat();

    let activeSessionId: string | null = null;
    let activeScheduleId: string | null = null;
    const messageCostRunIds = new Set<string>();
    const messageCostByRunId = new Map<string, ScheduleMoneyValues>();
    const legacyMessageCostBySessionId = new Map<string, number>();
    for (const row of messageRows) {
      if (row.sessionId !== activeSessionId) {
        activeSessionId = row.sessionId;
        activeScheduleId = null;
      }
      if (row.role === 'user') {
        activeScheduleId = scheduleOriginFromAgentMeta(row.agentMeta)?.scheduleId ?? null;
        continue;
      }
      if (row.role !== 'assistant') continue;
      const turnCost = turnCostFromAgentMeta(row.agentMeta);
      const cost = turnCost.costMoney?.amount ?? 0;
      const estimatedValue = turnCost.estimatedValueMoney?.amount ?? 0;
      if (cost <= 0 && estimatedValue <= 0) continue;
      if (turnCost.legacyProjectedActualAmount > 0) {
        legacyMessageCostBySessionId.set(
          row.sessionId,
          (legacyMessageCostBySessionId.get(row.sessionId) ?? 0) +
            turnCost.legacyProjectedActualAmount,
        );
      }
      const assistantOrigin = scheduleOriginFromAgentMeta(row.agentMeta);
      const assistantScheduleId = assistantOrigin?.scheduleId;
      const assistantRunId = assistantOrigin?.runId;
      const attributedScheduleId = assistantScheduleId ?? activeScheduleId;
      if (!attributedScheduleId || !linkedScheduleIds.has(attributedScheduleId)) {
        continue;
      }
      if (assistantRunId) {
        messageCostRunIds.add(assistantRunId);
        const runCost = messageCostByRunId.get(assistantRunId) ?? emptyScheduleMoneyValues();
        if (turnCost.costMoney) runCost.costValues.push(turnCost.costMoney);
        if (turnCost.estimatedValueMoney) {
          runCost.estimatedValueValues.push(turnCost.estimatedValueMoney);
        }
        if (turnCost.sdkEstimatedValueMoney) {
          runCost.sdkEstimatedValueValues.push(turnCost.sdkEstimatedValueMoney);
        }
        messageCostByRunId.set(assistantRunId, runCost);
      }
      const entry = bySchedule.get(attributedScheduleId) ?? emptyScheduleTurnCostState();
      entry.sessionIds.add(row.sessionId);
      if (turnCost.costMoney) {
        entry.costValues.push(turnCost.costMoney);
      }
      if (turnCost.estimatedValueMoney) {
        entry.estimatedValueValues.push(turnCost.estimatedValueMoney);
      }
      if (turnCost.sdkEstimatedValueMoney) {
        entry.sdkEstimatedValueValues.push(turnCost.sdkEstimatedValueMoney);
      }
      noteLatestCurrency(entry, turnCost.costMoney, row.createdAt);
      noteLatestCurrency(entry, turnCost.estimatedValueMoney, row.createdAt);
      const sessionCost = entry.sessionCosts.get(row.sessionId) ?? emptyScheduleMoneyValues();
      if (turnCost.costMoney) {
        sessionCost.costValues.push(turnCost.costMoney);
      }
      if (turnCost.estimatedValueMoney) {
        sessionCost.estimatedValueValues.push(turnCost.estimatedValueMoney);
      }
      if (turnCost.sdkEstimatedValueMoney) {
        sessionCost.sdkEstimatedValueValues.push(turnCost.sdkEstimatedValueMoney);
      }
      noteLatestCurrency(sessionCost, turnCost.costMoney, row.createdAt);
      noteLatestCurrency(sessionCost, turnCost.estimatedValueMoney, row.createdAt);
      entry.sessionCosts.set(row.sessionId, sessionCost);
      bySchedule.set(attributedScheduleId, entry);
    }

    // 纯 tool turn 没有 assistant message 可挂账，费用会直接写在 schedule_runs。
    // 正常消息费用已经进入 message ledger；混合 run 则只补 schedule_runs 快照中
    // 尚未被消息账本覆盖的余量，避免漏记 direct segment 或双计。
    const appendRunMoney = (
      entry: ScheduleTurnCostState,
      sessionId: string | undefined,
      costMoney: RegionalMoney | null,
      estimatedValueMoney: RegionalMoney | null,
      sdkEstimatedValueMoney: RegionalMoney | null,
      at: number,
    ): void => {
      if (costMoney && costMoney.amount > 0) entry.costValues.push(costMoney);
      if (estimatedValueMoney && estimatedValueMoney.amount > 0) {
        entry.estimatedValueValues.push(estimatedValueMoney);
      }
      if (sdkEstimatedValueMoney && sdkEstimatedValueMoney.amount > 0) {
        entry.sdkEstimatedValueValues.push(sdkEstimatedValueMoney);
      }
      noteLatestCurrency(entry, costMoney, at);
      noteLatestCurrency(entry, estimatedValueMoney, at);
      if (!sessionId) return;
      entry.sessionIds.add(sessionId);
      const sessionCost = entry.sessionCosts.get(sessionId) ?? emptyScheduleMoneyValues();
      if (costMoney && costMoney.amount > 0) sessionCost.costValues.push(costMoney);
      if (estimatedValueMoney && estimatedValueMoney.amount > 0) {
        sessionCost.estimatedValueValues.push(estimatedValueMoney);
      }
      if (sdkEstimatedValueMoney && sdkEstimatedValueMoney.amount > 0) {
        sessionCost.sdkEstimatedValueValues.push(sdkEstimatedValueMoney);
      }
      noteLatestCurrency(sessionCost, costMoney, at);
      noteLatestCurrency(sessionCost, estimatedValueMoney, at);
      entry.sessionCosts.set(sessionId, sessionCost);
    };
    const remainingMoney = (
      total: RegionalMoney | undefined,
      messageValues: readonly RegionalMoney[],
    ): RegionalMoney | null => {
      if (!total || total.amount <= 0) return null;
      if (messageValues.length === 0) return total;
      const messageTotal = addCompatibleRegionalMoney(messageValues, total.currency);
      if (!messageTotal) return total;
      // 历史脏数据的币种不一致时保留持久化实际金额，不能让整个 dashboard 抛错。
      if (messageTotal.currency !== total.currency) return total;
      const amount = Math.max(0, total.amount - messageTotal.amount);
      return amount > 0 ? { ...total, amount } : null;
    };

    for (const run of runCostRows) {
      if (run.costAttribution === 'unavailable' && run.status !== 'running') {
        // 消息账本已经给出该 run 的费用时，以账本为准；schedule_runs 快照可由
        // listRuns 的 hydrate 路径自愈，不应把任务误标成“部分费用不可用”。
        if (messageCostRunIds.has(run.id)) continue;
        const entry = bySchedule.get(run.scheduleId) ?? emptyScheduleTurnCostState();
        entry.hasUnavailableCost = true;
        appendRunMoney(entry, run.sessionId, null, null, null, run.firedAt);
        bySchedule.set(run.scheduleId, entry);
        continue;
      }
      if (
        run.costAttribution === 'zero' &&
        run.status !== 'running' &&
        !messageCostRunIds.has(run.id)
      ) {
        const entry = bySchedule.get(run.scheduleId) ?? emptyScheduleTurnCostState();
        appendRunMoney(entry, run.sessionId, null, null, null, run.firedAt);
        bySchedule.set(run.scheduleId, entry);
        continue;
      }
      if (run.costAttribution === 'direct' || run.costAttribution === 'mixed') {
        const messageCost = messageCostByRunId.get(run.id);
        const costMoney =
          run.costAttribution === 'direct'
            ? (run.costMoney ?? null)
            : remainingMoney(run.costMoney, messageCost?.costValues ?? []);
        const estimatedValueMoney =
          run.costAttribution === 'direct'
            ? (run.estimatedValueMoney ?? null)
            : remainingMoney(
                run.estimatedValueMoney,
                messageCost?.estimatedValueValues ?? [],
              );
        const sdkEstimatedValueMoney =
          run.costAttribution === 'direct'
            ? (run.sdkEstimatedValueMoney ?? null)
            : remainingMoney(
                run.sdkEstimatedValueMoney,
                messageCost?.sdkEstimatedValueValues ?? [],
              );
        const entry = bySchedule.get(run.scheduleId) ?? emptyScheduleTurnCostState();
        appendRunMoney(
          entry,
          run.sessionId,
          costMoney,
          estimatedValueMoney,
          sdkEstimatedValueMoney,
          run.firedAt,
        );
        bySchedule.set(run.scheduleId, entry);
        continue;
      }
      if (run.costAttribution !== 'exact') continue;
      const messageCost = messageCostByRunId.get(run.id);
      if (messageCost) continue;
      const entry = bySchedule.get(run.scheduleId) ?? emptyScheduleTurnCostState();
      appendRunMoney(
        entry,
        run.sessionId,
        run.costMoney ?? null,
        run.estimatedValueMoney ?? null,
        run.sdkEstimatedValueMoney ?? null,
        run.firedAt,
      );
      bySchedule.set(run.scheduleId, entry);
    }

    for (const session of legacySessions) {
      const scheduleId = legacySessionScheduleIds.get(session.id);
      if (!scheduleId) continue;

      const entry = bySchedule.get(scheduleId) ?? emptyScheduleTurnCostState();
      entry.sessionIds.add(session.id);
      const cost = Number(session.totalCostUsd ?? 0);
      if (Number.isFinite(cost) && cost > 0) {
        const projectedLegacyCost = legacyUsdMoney(cost);
        const alreadyCountedMessageCost = legacyMessageCostBySessionId.get(session.id) ?? 0;
        const legacyCost = Math.max(0, projectedLegacyCost.amount - alreadyCountedMessageCost);
        const legacyMoney: RegionalMoney = {
          ...projectedLegacyCost,
          amount: legacyCost,
        };
        if (legacyCost > 0) {
          entry.costValues.push(legacyMoney);
          noteLatestCurrency(entry, legacyMoney, 0);
        }
        const sessionCost = entry.sessionCosts.get(session.id) ?? emptyScheduleMoneyValues();
        if (legacyCost > 0) {
          sessionCost.costValues.push(legacyMoney);
          noteLatestCurrency(sessionCost, legacyMoney, 0);
        }
        entry.sessionCosts.set(session.id, sessionCost);
      }
      bySchedule.set(scheduleId, entry);
    }

    return [...bySchedule.entries()].map(([scheduleId, summary]) => {
      const totalMoney =
        addCompatibleRegionalMoney(summary.costValues, summary.latestCurrency) ??
        zeroUsageMoney();
      const totalEstimatedValueMoney =
        addCompatibleRegionalMoney(
          summary.estimatedValueValues,
          summary.latestCurrency,
        ) ?? zeroUsageMoney('value-estimate');
      const totalSdkEstimatedValueMoney = addCompatibleRegionalMoney(
        summary.sdkEstimatedValueValues,
        summary.latestCurrency,
      );
      return {
        scheduleId,
        totalMoney,
        totalEstimatedValueMoney,
        ...(totalSdkEstimatedValueMoney && totalSdkEstimatedValueMoney.amount > 0
          ? { totalSdkEstimatedValueMoney }
          : {}),
        ...(totalMoney.currency === 'USD'
          ? {
              totalCostUsd: totalMoney.amount,
              totalEstimatedValueUsd: totalEstimatedValueMoney.amount,
            }
          : {}),
        ...(summary.hasUnavailableCost ? { hasUnavailableCost: true } : {}),
        sessionCount: summary.sessionIds.size,
        sessions: [...summary.sessionCosts.entries()].map(([sessionId, costs]) => {
          const money =
            addCompatibleRegionalMoney(costs.costValues, costs.latestCurrency) ??
            zeroUsageMoney();
          const estimatedMoney =
            addCompatibleRegionalMoney(
              costs.estimatedValueValues,
              costs.latestCurrency,
            ) ?? zeroUsageMoney('value-estimate');
          const sdkEstimatedMoney = addCompatibleRegionalMoney(
            costs.sdkEstimatedValueValues,
            costs.latestCurrency,
          );
          return {
            sessionId,
            totalMoney: money,
            totalEstimatedValueMoney: estimatedMoney,
            ...(sdkEstimatedMoney && sdkEstimatedMoney.amount > 0
              ? { totalSdkEstimatedValueMoney: sdkEstimatedMoney }
              : {}),
            ...(money.currency === 'USD'
              ? {
                  totalCostUsd: money.amount,
                  totalEstimatedValueUsd: estimatedMoney.amount,
                }
              : {}),
          };
        }),
      };
    });
  }

  async deleteRun(id: string): Promise<ScheduleRun | null> {
    const db = this.getDb();
    // 先 select 一次拿到 scheduleId（callers 需要它来定位 'changed' 事件目标 schedule）；
    // 找不到直接返回 null，不抛错（与 update/updateRun 的契约对齐）。
    const [row] = await db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)).limit(1);
    if (!row) return null;
    await db.delete(scheduleRuns).where(eq(scheduleRuns.id, id));
    return scheduleRunToCamel(row);
  }

  async deleteOrphanRuns(): Promise<number> {
    const db = this.getDb();
    // 显式 .run() 才能经 drizzleProxy 拿到 changes(见 claimDueFire 注释)
    const result = await db
      .delete(scheduleRuns)
      .where(sql`${scheduleRuns.scheduleId} NOT IN (SELECT ${schedules.id} FROM ${schedules})`)
      .run();
    const changes = (result as unknown as { changes?: number }).changes;
    return typeof changes === 'number' ? changes : 0;
  }

  /**
   * 是否存在 running 行;传 scheduleId 只查该 schedule 名下(引擎清扫善后的
   * "是否仍有活 run"不变量用,无上限,不受 listRuns 展示条数影响);
   * 不传 = 全局(updater 自动重启的 busy probe 沿用)。
   */
  async hasRunningRuns(scheduleId?: string): Promise<boolean> {
    const db = this.getDb();
    const [row] = await db
      .select({ id: scheduleRuns.id })
      .from(scheduleRuns)
      .where(
        and(
          eq(scheduleRuns.status, 'running'),
          ...(scheduleId !== undefined ? [eq(scheduleRuns.scheduleId, scheduleId)] : []),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async markRunningAsInterrupted(
    staleBefore: number,
    excludeRunIds?: readonly string[],
    opts?: { legacyStaleBefore?: number },
  ): Promise<string[]> {
    const db = this.getDb();
    const now = Date.now();
    // 僵尸判定 = 'running' 且过期:带心跳的行按 heartbeat_at 对 staleBefore;
    // NULL 心跳行(老版本实例写入)按 fired_at 对 legacyStaleBefore(未传则回落
    // staleBefore,即启动清理的兜底语义)。心跳仍新鲜的 running 行属于另一个共库
    // 活实例,绝不能动 —— 曾经的无条件 UPDATE 会把对方 in-flight run 标成
    // interrupted,留下假失败红点与 errorMsg 残留。excludeRunIds(本进程
    // in-flight)无条件排除,自家心跳停摆也不自伤。
    const legacyStaleBefore = opts?.legacyStaleBefore ?? staleBefore;
    const staleRunningCond = () =>
      and(
        eq(scheduleRuns.status, 'running'),
        or(
          and(
            isNotNull(scheduleRuns.heartbeatAt),
            sql`${scheduleRuns.heartbeatAt} < ${staleBefore}`,
          ),
          and(
            isNull(scheduleRuns.heartbeatAt),
            sql`${scheduleRuns.firedAt} < ${legacyStaleBefore}`,
          ),
        ),
        ...(excludeRunIds && excludeRunIds.length > 0
          ? [notInArray(scheduleRuns.id, [...excludeRunIds])]
          : []),
      );
    const staleRows = await db
      .select({ id: scheduleRuns.id, scheduleId: scheduleRuns.scheduleId })
      .from(scheduleRuns)
      .where(staleRunningCond());
    if (staleRows.length === 0) return [];
    // UPDATE 的 WHERE 重查完整僵尸条件而不是只按上面 SELECT 的 id 快照:两步之间
    // owner 实例可能刚好正常收口(status 已翻 success/failed),不能把它改回
    // interrupted。极端竞态下 UPDATE 实际命中可能少于 SELECT,返回的 scheduleIds
    // 至多让调用方多广播一次无害刷新。errorMsg 固定 'app restarted',UI 错误摘要
    // 框直接展示中断原因。
    await db
      .update(scheduleRuns)
      .set({
        status: 'interrupted',
        finishedAt: now,
        errorMsg: 'app restarted',
      })
      .where(
        and(
          inArray(
            scheduleRuns.id,
            staleRows.map((r) => r.id),
          ),
          staleRunningCond(),
        ),
      )
      .run();
    return [...new Set(staleRows.map((r) => r.scheduleId))];
  }

  async touchRunHeartbeats(runIds: readonly string[], heartbeatAt: number): Promise<void> {
    if (runIds.length === 0) return;
    const db = this.getDb();
    // 只动仍是 'running' 的行:run 刚被引擎收口(success/failed/...)的竞态下,
    // 心跳续期不该往终态行上补写。
    await db
      .update(scheduleRuns)
      .set({ heartbeatAt })
      .where(and(inArray(scheduleRuns.id, [...runIds]), eq(scheduleRuns.status, 'running')))
      .run();
  }

  // ---------- 未读 run 统计 / 标记（sidebar badge 用） ----------

  /**
   * 全局未读 run 数：状态为终态（success/failed/aborted/interrupted）且 read_at IS NULL。
   * 'running' 不计入：跑到一半的不算"用户漏看的结果"。
   * 'interrupted' 计入：app 重启时丢的 run 也需要让用户感知，便于决定是否重跑。
   */
  async getUnreadRunCount(): Promise<number> {
    const db = this.getDb();
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(scheduleRuns)
      .where(
        and(
          isNull(scheduleRuns.readAt),
          inArray(scheduleRuns.status, ['success', 'failed', 'aborted', 'interrupted']),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /**
   * 把单条 run 标记为已读。仅终态 run（success/failed/aborted）有效，
   * 'running' 调用 = no-op。返回该 run 的 scheduleId（用于事件广播）；
   * run 不存在 / 状态不是终态 / 已经读过 → 返回 null（调用方据此跳过广播）。
   *
   * 选 per-run 而不是 per-schedule：用户只点击查看了这一条 run，
   * 同 schedule 下其他历史 run 不应被自动消化。
   */
  async markRunRead(runId: string): Promise<string | null> {
    const db = this.getDb();
    const [row] = await db
      .select({
        scheduleId: scheduleRuns.scheduleId,
        status: scheduleRuns.status,
        readAt: scheduleRuns.readAt,
      })
      .from(scheduleRuns)
      .where(eq(scheduleRuns.id, runId))
      .limit(1);
    if (!row) return null;
    if (row.readAt != null) return null;
    if (
      row.status !== 'success' &&
      row.status !== 'failed' &&
      row.status !== 'aborted' &&
      row.status !== 'interrupted'
    ) {
      return null;
    }
    await db.update(scheduleRuns).set({ readAt: Date.now() }).where(eq(scheduleRuns.id, runId));
    return row.scheduleId;
  }

  /**
   * 把指定 schedule 下所有未读的终态 run 一次性标记为已读。
   * 调用方场景：用户主动 pause / delete 一条 automation —— 既然不再关心后续触发,
   * 历史结果的红点也跟着清掉,避免 sidebar badge 永远停在一个非零数。
   * 仍只覆盖终态 run (与 markRunRead 一致),'running' 不动。
   * 返回实际被更新的行数,调用方据此决定是否需要广播 read 事件。
   */
  /**
   * 把所有 schedule 下的未读终态 run 一次性标记为已读。
   * 用户场景：sidebar 右键 "Automations" → "Mark all as read",
   * 一次清掉全部红点(常见于离线一段时间回来攒了一堆通知不想逐条看)。
   * 仍只覆盖终态 run,'running' 不动。
   * 返回实际被更新的行数,调用方据此决定是否广播事件。
   */
  async markAllUnreadRuns(): Promise<number> {
    const db = this.getDb();
    // 显式 .run() 才能经 drizzleProxy 拿到 changes(见 claimDueFire 注释)
    const result = await db
      .update(scheduleRuns)
      .set({ readAt: Date.now() })
      .where(
        and(
          isNull(scheduleRuns.readAt),
          inArray(scheduleRuns.status, ['success', 'failed', 'aborted', 'interrupted']),
        ),
      )
      .run();
    const changes = (result as unknown as { changes?: number }).changes;
    return typeof changes === 'number' ? changes : 0;
  }

  async markAllRunsRead(scheduleId: string): Promise<number> {
    const db = this.getDb();
    // 显式 .run() 才能经 drizzleProxy 拿到 changes(见 claimDueFire 注释)
    const result = await db
      .update(scheduleRuns)
      .set({ readAt: Date.now() })
      .where(
        and(
          eq(scheduleRuns.scheduleId, scheduleId),
          isNull(scheduleRuns.readAt),
          inArray(scheduleRuns.status, ['success', 'failed', 'aborted', 'interrupted']),
        ),
      )
      .run();
    const changes = (result as unknown as { changes?: number }).changes;
    return typeof changes === 'number' ? changes : 0;
  }

  /**
   * Legacy compatibility: older/deleted automation data can leave scheduler-created
   * sessions without schedule_runs rows. The sidebar can still surface them through
   * source/title grouping; the automation detail should not look empty in that case.
   */
  private async listLegacySessionRuns(
    db: SchedulerDrizzleDb,
    scheduleId: string,
    linkedSessionIds: ReadonlySet<string>,
    legacyAliases: ReadonlyMap<string, LegacyScheduleSessionAlias>,
  ): Promise<ScheduleRun[]> {
    if (legacyAliases.size === 0) return [];
    const titles = [
      ...new Set([...legacyAliases.values()].map((alias) => legacyScheduleTitle(alias.name))),
    ];

    const rows = await db
      .select({
        id: sessions.id,
        title: sessions.title,
        workspaceKind: sessions.workspaceKind,
        workingDir: sessions.workingDir,
        userSendAt: sessions.userSendAt,
        createdAt: sessions.createdAt,
        updatedAt: sessions.updatedAt,
      })
      .from(sessions)
      .where(and(legacyTitleWhere(), inArray(sessions.title, titles)));

    return rows
      .filter((row) => {
        if (linkedSessionIds.has(row.id)) return false;
        const name = legacyScheduleNameFromSessionTitle(row.title);
        if (!name) return false;
        return legacyAliases.has(
          legacyScheduleKey({
            name,
            workspaceKind: row.workspaceKind,
            workingDir: row.workingDir,
          }),
        );
      })
      .map((row) => legacyRunFromSession(scheduleId, row));
  }

  private async listLegacyAliasesForSchedule(
    db: SchedulerDrizzleDb,
    schedule: Schedule,
  ): Promise<Map<string, LegacyScheduleSessionAlias>> {
    const [fallbackState] = await db
      .select({ enabled: schedules.legacySessionFallback })
      .from(schedules)
      .where(eq(schedules.id, schedule.id))
      .limit(1);
    if (!fallbackState?.enabled) return new Map();

    const directScheduleIdByLegacyKey = await this.listDirectScheduleIdsByLegacyKey(db);
    const aliases = new Map<string, LegacyScheduleSessionAlias>();
    const addAlias = (alias: LegacyScheduleSessionAlias) => {
      const key = legacyScheduleKey(alias);
      const directScheduleId = directScheduleIdByLegacyKey.get(key);
      if (directScheduleId && directScheduleId !== schedule.id) return;
      aliases.set(key, alias);
    };
    addAlias({
      name: schedule.name,
      workspaceKind: schedule.workspaceKind,
      workingDir: schedule.workingDir,
    });

    const linkedRows = await db
      .select({
        title: sessions.title,
        workspaceKind: sessions.workspaceKind,
        workingDir: sessions.workingDir,
      })
      .from(scheduleRuns)
      .innerJoin(sessions, eq(scheduleRuns.sessionId, sessions.id))
      .where(and(eq(scheduleRuns.scheduleId, schedule.id), legacyTitleWhere()));

    for (const row of linkedRows) {
      const name = legacyScheduleNameFromSessionTitle(row.title);
      if (!name) continue;
      addAlias({
        name,
        workspaceKind: row.workspaceKind,
        workingDir: row.workingDir,
      });
    }
    return aliases;
  }

  private async listSchedulesByLegacyKey(
    db: SchedulerDrizzleDb,
  ): Promise<Map<string, LegacyScheduleLookupEntry>> {
    const directScheduleIdByLegacyKey = await this.listDirectScheduleIdsByLegacyKey(db);
    const scheduleRows = await db
      .select({
        id: schedules.id,
        name: schedules.name,
        legacySessionFallback: schedules.legacySessionFallback,
        status: schedules.status,
        source: schedules.source,
        nextFireAt: schedules.nextFireAt,
        workspaceKind: schedules.workspaceKind,
        workingDir: schedules.workingDir,
        projectConfigId: schedules.projectConfigId,
        updatedAt: schedules.updatedAt,
      })
      .from(schedules)
      .orderBy(desc(schedules.updatedAt));

    const scheduleByLegacyKey = new Map<string, LegacyScheduleLookupEntry>();
    for (const schedule of scheduleRows) {
      const key = legacyScheduleKey({
        name: schedule.name,
        workspaceKind: schedule.workspaceKind,
        workingDir: schedule.workingDir,
      });
      // 只有 migration 显式标记的存量任务允许按名称/目录认领无 runId 的旧会话。
      // 新任务（包括删除后同名重建）只认稳定 scheduleId，不能覆盖实例身份隔离。
      if (!schedule.legacySessionFallback) continue;
      if (directScheduleIdByLegacyKey.get(key) !== schedule.id) continue;
      if (scheduleByLegacyKey.has(key)) continue;
      scheduleByLegacyKey.set(key, {
        id: schedule.id,
        name: schedule.name,
        status: schedule.status,
        source: toScheduleSource(schedule.source),
        nextFireAt: schedule.nextFireAt ?? undefined,
        workspaceKind: schedule.workspaceKind,
        workingDir: schedule.workingDir ?? undefined,
        projectConfigId: schedule.projectConfigId ?? undefined,
      });
    }

    const linkedLegacyRows = await db
      .select({
        id: schedules.id,
        name: schedules.name,
        legacySessionFallback: schedules.legacySessionFallback,
        status: schedules.status,
        source: schedules.source,
        nextFireAt: schedules.nextFireAt,
        workspaceKind: schedules.workspaceKind,
        workingDir: schedules.workingDir,
        projectConfigId: schedules.projectConfigId,
        sessionTitle: sessions.title,
        sessionWorkspaceKind: sessions.workspaceKind,
        sessionWorkingDir: sessions.workingDir,
        firedAt: scheduleRuns.firedAt,
        updatedAt: schedules.updatedAt,
      })
      .from(scheduleRuns)
      .innerJoin(schedules, eq(scheduleRuns.scheduleId, schedules.id))
      .innerJoin(sessions, eq(scheduleRuns.sessionId, sessions.id))
      .where(legacyTitleWhere())
      .orderBy(desc(scheduleRuns.firedAt), desc(schedules.updatedAt));

    const linkedKeys = new Set<string>();
    for (const row of linkedLegacyRows) {
      if (!row.legacySessionFallback) continue;
      const legacyName = legacyScheduleNameFromSessionTitle(row.sessionTitle);
      if (!legacyName) continue;
      const key = legacyScheduleKey({
        name: legacyName,
        workspaceKind: row.sessionWorkspaceKind,
        workingDir: row.sessionWorkingDir,
      });
      if (linkedKeys.has(key)) continue;
      const directScheduleId = directScheduleIdByLegacyKey.get(key);
      if (directScheduleId && directScheduleId !== row.id) continue;
      const existing = scheduleByLegacyKey.get(key);
      if (existing && existing.id !== row.id) continue;
      linkedKeys.add(key);
      scheduleByLegacyKey.set(key, {
        id: row.id,
        name: row.name,
        status: row.status,
        source: toScheduleSource(row.source),
        nextFireAt: row.nextFireAt ?? undefined,
        workspaceKind: row.workspaceKind,
        workingDir: row.workingDir ?? undefined,
        projectConfigId: row.projectConfigId ?? undefined,
      });
    }

    return scheduleByLegacyKey;
  }

  private async listDirectScheduleIdsByLegacyKey(
    db: SchedulerDrizzleDb,
  ): Promise<Map<string, string>> {
    const scheduleRows = await db
      .select({
        id: schedules.id,
        name: schedules.name,
        legacySessionFallback: schedules.legacySessionFallback,
        workspaceKind: schedules.workspaceKind,
        workingDir: schedules.workingDir,
        updatedAt: schedules.updatedAt,
      })
      .from(schedules)
      .orderBy(desc(schedules.updatedAt));

    const directScheduleIdByLegacyKey = new Map<string, string>();
    for (const schedule of scheduleRows) {
      // 非兼容的新任务不能抢走真正存量任务的 legacy key 所有权。
      if (!schedule.legacySessionFallback) continue;
      const key = legacyScheduleKey({
        name: schedule.name,
        workspaceKind: schedule.workspaceKind,
        workingDir: schedule.workingDir,
      });
      if (!directScheduleIdByLegacyKey.has(key)) {
        directScheduleIdByLegacyKey.set(key, schedule.id);
      }
    }
    return directScheduleIdByLegacyKey;
  }
}
