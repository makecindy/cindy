/**
 * scheduler run 费用账本。
 *
 * assistant message 的 agent_meta 是单段费用与 runId 的持久化来源；schedule_runs
 * 保存其聚合快照，供 Run History 直接读取。更新按“补丁前后差值”执行，同一消息
 * 重放不会重复累计，估算值改为真实费用时也能从两栏之间正确搬移。
 */
import { eq, sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { scheduleRuns } from '../localDb/schema';

interface RunCostEntry {
  runId: string;
  costUsd: number;
  estimatedValueUsd: number;
}

const MIN_RECORDED_COST_USD = 1e-10;

export interface ScheduleRunCostDelta {
  runId: string;
  costUsdDelta: number;
  estimatedValueUsdDelta: number;
}

function finitePositive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_RECORDED_COST_USD
    ? value
    : 0;
}

function runCostEntry(meta: Record<string, unknown>): RunCostEntry | null {
  const origin = meta.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return null;
  const parsedOrigin = origin as Record<string, unknown>;
  if (parsedOrigin.kind !== 'scheduler') return null;
  const runId = parsedOrigin.runId;
  if (typeof runId !== 'string' || runId.length === 0) return null;

  const amount = finitePositive(meta.turnCostUsd);
  return meta.turnCostIsEstimate === true
    ? { runId, costUsd: 0, estimatedValueUsd: amount }
    : { runId, costUsd: amount, estimatedValueUsd: 0 };
}

/** 计算消息元数据变化对 run 聚合的幂等差值，最多影响旧/新两个 run。 */
export function computeScheduleRunCostDeltas(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): ScheduleRunCostDelta[] {
  const changes = new Map<string, ScheduleRunCostDelta>();
  const apply = (entry: RunCostEntry | null, direction: 1 | -1) => {
    if (!entry) return;
    const current = changes.get(entry.runId) ?? {
      runId: entry.runId,
      costUsdDelta: 0,
      estimatedValueUsdDelta: 0,
    };
    current.costUsdDelta += direction * entry.costUsd;
    current.estimatedValueUsdDelta += direction * entry.estimatedValueUsd;
    changes.set(entry.runId, current);
  };
  apply(runCostEntry(previous), -1);
  apply(runCostEntry(next), 1);
  return [...changes.values()].filter(
    (change) =>
      Math.abs(change.costUsdDelta) >= MIN_RECORDED_COST_USD ||
      Math.abs(change.estimatedValueUsdDelta) >= MIN_RECORDED_COST_USD,
  );
}

/** 将一条 message agent_meta 补丁产生的差值写入 schedule_runs 聚合快照。 */
export async function applyScheduleRunCostMetaChange(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Promise<void> {
  const changes = computeScheduleRunCostDeltas(previous, next);
  if (changes.length === 0) return;
  const db = getDbClient().drizzle;
  for (const change of changes) {
    await db
      .update(scheduleRuns)
      .set({
        // A direct-only snapshot is an independent ledger. Once it exists,
        // keep the message ledger in agent_meta and let read paths add it;
        // otherwise a successful message update would make a later read
        // unable to tell whether the snapshot already contains that segment.
        costUsd: sql<number>`CASE
          WHEN ${scheduleRuns.costAttribution} = 'direct'
            THEN ${scheduleRuns.costUsd}
          ELSE MAX(0, ${scheduleRuns.costUsd} + ${change.costUsdDelta})
        END`,
        estimatedValueUsd: sql<number>`CASE
          WHEN ${scheduleRuns.costAttribution} = 'direct'
            THEN ${scheduleRuns.estimatedValueUsd}
          ELSE MAX(0, ${scheduleRuns.estimatedValueUsd} + ${change.estimatedValueUsdDelta})
        END`,
        costAttribution: sql<string>`CASE
          WHEN ${scheduleRuns.costAttribution} IN ('direct', 'mixed')
            THEN ${scheduleRuns.costAttribution}
          ELSE 'exact'
        END`,
      })
      .where(eq(scheduleRuns.id, change.runId));
  }
}

/**
 * 没有可挂费用的 assistant message 时，按 scheduler runId 直接写聚合快照。
 *
 * 这是 Codex 纯 tool turn 等场景的兜底；正常有消息时仍以 agent_meta 账本为主。
 * 直接路径将每个无法挂载消息的 turn 分段累加到 run 快照。
 * 返回 scheduleId 供调用方广播 changed，run 已被删除时返回 null。
 */
export async function recordScheduleRunCostDirect(args: {
  runId: string;
  costUsd: number;
  isEstimate: boolean;
}): Promise<string | null> {
  const { runId, costUsd, isEstimate } = args;
  if (!runId || typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) {
    return null;
  }
  const amount = finitePositive(costUsd);
  // Match the message ledger's delta threshold; a tiny positive residue must
  // not create a direct-only run segment or a misleading changed broadcast.
  if (costUsd > 0 && amount === 0) return null;

  const db = getDbClient().drizzle;
  const [run] = await db
    .select({ scheduleId: scheduleRuns.scheduleId })
    .from(scheduleRuns)
    .where(eq(scheduleRuns.id, runId))
    .limit(1);
  if (!run) return null;

  const result = await db
    .update(scheduleRuns)
    .set({
      costUsd: sql<number>`MAX(0, ${scheduleRuns.costUsd} + ${isEstimate ? 0 : amount})`,
      estimatedValueUsd: sql<number>`MAX(0, ${scheduleRuns.estimatedValueUsd} + ${isEstimate ? amount : 0})`,
      // A confirmed zero-cost segment must not downgrade a run that already
      // contains an exact segment; otherwise later summary reads lose the
      // accumulated direct cost.
      costAttribution:
        isEstimate || amount > 0
          ? sql<string>`CASE
              WHEN ${scheduleRuns.costAttribution} = 'mixed' THEN 'mixed'
              WHEN ${scheduleRuns.costAttribution} = 'exact' THEN 'mixed'
              ELSE 'direct'
            END`
          : sql<string>`CASE
              WHEN ${scheduleRuns.costAttribution} IN ('exact', 'direct', 'mixed')
                THEN ${scheduleRuns.costAttribution}
              ELSE 'zero'
            END`,
    })
    .where(eq(scheduleRuns.id, runId))
    .run();
  const changes = (result as unknown as { changes?: number }).changes;
  if (typeof changes !== 'number' || changes === 0) return null;
  return run.scheduleId;
}
