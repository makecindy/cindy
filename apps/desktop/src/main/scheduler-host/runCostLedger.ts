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
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { normalizeRegionalMoney, regionalizeLegacyUsd } from '../../shared/regionalMoney.js';

interface RunCostEntry {
  runId: string;
  costAmount: number;
  estimatedValueAmount: number;
  currency: 'CNY' | 'USD';
  approximate: boolean;
}

const MIN_RECORDED_COST_USD = 1e-10;

export interface ScheduleRunCostDelta {
  runId: string;
  costAmountDelta: number;
  estimatedValueAmountDelta: number;
  currency: 'CNY' | 'USD';
  approximate: boolean;
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

  const money =
    normalizeRegionalMoney(meta.turnCost) ??
    (finitePositive(meta.turnCostUsd) > 0
      ? regionalizeLegacyUsd(finitePositive(meta.turnCostUsd), CURRENT_CINDY_REGION)
      : undefined);
  if (!money || money.amount <= 0) return null;
  const isEstimate = meta.turnCostIsEstimate === true || money.kind === 'value-estimate';
  return {
    runId,
    costAmount: isEstimate ? 0 : money.amount,
    estimatedValueAmount: isEstimate ? money.amount : 0,
    currency: money.currency,
    // cost_is_approximate 只描述真实费用；订阅价值本身始终由
    // estimatedValueMoney 标成 value-estimate，不能污染真实费用。
    approximate: !isEstimate && money.approximate,
  };
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
      costAmountDelta: 0,
      estimatedValueAmountDelta: 0,
      currency: entry.currency,
      approximate: false,
    };
    if (current.currency !== entry.currency) {
      throw new Error('schedule run cost currency mismatch');
    }
    current.costAmountDelta += direction * entry.costAmount;
    current.estimatedValueAmountDelta += direction * entry.estimatedValueAmount;
    // 这里是消息快照替换，不是新费用累加。只让 next 决定新的近似状态，
    // 避免 approximate 消息被精确金额替换后永久保持 true。
    if (direction === 1) current.approximate = entry.approximate;
    changes.set(entry.runId, current);
  };
  apply(runCostEntry(previous), -1);
  apply(runCostEntry(next), 1);
  return [...changes.values()].filter(
    (change) =>
      Math.abs(change.costAmountDelta) >= MIN_RECORDED_COST_USD ||
      Math.abs(change.estimatedValueAmountDelta) >= MIN_RECORDED_COST_USD,
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
        costAmount: sql<number>`CASE
          WHEN ${scheduleRuns.costAttribution} = 'direct'
            THEN ${scheduleRuns.costAmount}
          ELSE MAX(0, ${scheduleRuns.costAmount} + ${change.costAmountDelta})
        END`,
        estimatedValueAmount: sql<number>`CASE
          WHEN ${scheduleRuns.costAttribution} = 'direct'
            THEN ${scheduleRuns.estimatedValueAmount}
          ELSE MAX(0, ${scheduleRuns.estimatedValueAmount} + ${change.estimatedValueAmountDelta})
        END`,
        costCurrency: change.currency,
        costIsApproximate: sql`CASE
          WHEN ${scheduleRuns.costAttribution} IN ('direct', 'mixed')
            THEN ${scheduleRuns.costIsApproximate} OR ${change.approximate ? 1 : 0}
          ELSE ${change.approximate ? 1 : 0}
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
  money: import('../../shared/regionalMoney.js').RegionalMoney;
}): Promise<string | null> {
  const { runId } = args;
  const money = normalizeRegionalMoney(args.money);
  if (!runId || !money) return null;
  const amount = finitePositive(money.amount);
  // Match the message ledger's delta threshold; a tiny positive residue must
  // not create a direct-only run segment or a misleading changed broadcast.
  if (money.amount > 0 && amount === 0) return null;
  const isEstimate = money.kind === 'value-estimate';

  const db = getDbClient().drizzle;
  const [run] = await db
    .select({
      scheduleId: scheduleRuns.scheduleId,
      costCurrency: scheduleRuns.costCurrency,
    })
    .from(scheduleRuns)
    .where(eq(scheduleRuns.id, runId))
    .limit(1);
  if (!run) return null;
  if (run.costCurrency && run.costCurrency !== money.currency) {
    throw new Error('schedule run cost currency mismatch');
  }

  const result = await db
    .update(scheduleRuns)
    .set({
      costAmount: sql<number>`MAX(0, ${scheduleRuns.costAmount} + ${isEstimate ? 0 : amount})`,
      estimatedValueAmount: sql<number>`MAX(0, ${scheduleRuns.estimatedValueAmount} + ${isEstimate ? amount : 0})`,
      costCurrency: money.currency,
      costIsApproximate: sql`${scheduleRuns.costIsApproximate} OR ${
        !isEstimate && money.approximate ? 1 : 0
      }`,
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
