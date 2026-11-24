import { messageCostDatabase } from '../usage/turnUsageAdmission.js';
/**
 * scheduler run 费用账本。
 *
 * assistant message 的 agent_meta 是单段费用与 runId 的持久化来源；schedule_runs
 * 保存其聚合快照，供 Run History 直接读取。更新按“补丁前后差值”执行，同一消息
 * 重放不会重复累计，估算值改为真实费用时也能从两栏之间正确搬移。
 */
import { supplementalConversationEstimates } from '@cindy/maker-shared/usage-cost-details';
import { eq, sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { scheduleRuns } from '../localDb/schema';
import { createLogger } from '../logger';
import { legacyUsdMoney, normalizeRegionalMoney, type RegionalMoney } from '../../shared/regionalMoney.js';

const log = createLogger('runCostLedger');

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

function runCostEntries(meta: Record<string, unknown>): RunCostEntry[] {
  const origin = meta.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return [];
  const parsedOrigin = origin as Record<string, unknown>;
  if (parsedOrigin.kind !== 'scheduler') return [];
  const runId = parsedOrigin.runId;
  if (typeof runId !== 'string' || runId.length === 0) return [];

  const money =
    normalizeRegionalMoney(meta.turnCost) ??
    (finitePositive(meta.turnCostUsd) > 0
      ? legacyUsdMoney(finitePositive(meta.turnCostUsd))
      : undefined);
  const amounts = [
    ...(money && money.amount > 0 ? [{
      ...money, kind: meta.turnCostIsEstimate === true ? 'value-estimate' as const : money.kind,
    }] : []),
    ...supplementalConversationEstimates(meta),
  ];
  return amounts.map(value => ({
    runId,
    costAmount: value.kind === 'actual-cost' ? value.amount : 0,
    estimatedValueAmount: value.kind === 'value-estimate' ? value.amount : 0,
    currency: value.currency,
    approximate: value.kind === 'actual-cost' && value.approximate,
  }));
}

/** 计算消息元数据变化对 run 聚合的幂等差值，最多影响旧/新两个 run。 */
export function computeScheduleRunCostDeltas(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): ScheduleRunCostDelta[] {
  // 按 (runId, 币种) 分桶:同一 run 的消息在补丁前后换币种(device-link 旧对端 /
  // 历史数据重写)时,旧币种减、新币种加各成一条 delta,由 SQL 侧的 CASE 币种
  // 守卫逐条裁决——绝不 throw,抛异常会让整个差值应用被跳过。
  const changes = new Map<string, ScheduleRunCostDelta>();
  const apply = (entry: RunCostEntry, direction: 1 | -1) => {
    const key = `${entry.runId}\u0000${entry.currency}`;
    const current = changes.get(key) ?? {
      runId: entry.runId,
      costAmountDelta: 0,
      estimatedValueAmountDelta: 0,
      currency: entry.currency,
      approximate: false,
    };
    current.costAmountDelta += direction * entry.costAmount;
    current.estimatedValueAmountDelta += direction * entry.estimatedValueAmount;
    // 这里是消息快照替换，不是新费用累加。只让 next 决定新的近似状态，
    // 避免 approximate 消息被精确金额替换后永久保持 true。
    if (direction === 1) current.approximate ||= entry.approximate;
    changes.set(key, current);
  };
  for (const entry of runCostEntries(previous)) apply(entry, -1);
  for (const entry of runCostEntries(next)) apply(entry, 1);
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
  const db = (messageCostDatabase.getStore() ?? getDbClient()).drizzle;
  for (const change of changes) {
    // Compare the stored currency inside the update so each estimate lands in its own bucket.
    const sameCurrency = sql`(${scheduleRuns.costCurrency} IS NULL OR ${scheduleRuns.costCurrency} = ${change.currency})`;
    await db
      .update(scheduleRuns)
      .set({
        // A direct-only snapshot is an independent ledger. Once it exists,
        // keep the message ledger in agent_meta and let read paths add it;
        // otherwise a successful message update would make a later read
        // unable to tell whether the snapshot already contains that segment.
        costAmount: sql<number>`CASE
          WHEN NOT ${sameCurrency} THEN ${scheduleRuns.costAmount}
          WHEN ${scheduleRuns.costAttribution} = 'direct'
            THEN ${scheduleRuns.costAmount}
          ELSE MAX(0, ${scheduleRuns.costAmount} + ${change.costAmountDelta})
        END`,
        otherEstimatedValueAmount: sql<number>`CASE
          WHEN ${sameCurrency} OR ${scheduleRuns.costAttribution} = 'direct'
            THEN ${scheduleRuns.otherEstimatedValueAmount}
          ELSE MAX(0, ${scheduleRuns.otherEstimatedValueAmount} + ${change.estimatedValueAmountDelta}) END`,
        estimatedValueAmount: sql<number>`CASE
          WHEN NOT ${sameCurrency} THEN ${scheduleRuns.estimatedValueAmount}
          WHEN ${scheduleRuns.costAttribution} = 'direct'
            THEN ${scheduleRuns.estimatedValueAmount}
          ELSE MAX(0, ${scheduleRuns.estimatedValueAmount} + ${change.estimatedValueAmountDelta})
        END`,
        costCurrency: sql`CASE
          WHEN NOT ${sameCurrency} THEN ${scheduleRuns.costCurrency}
          ELSE ${change.currency}
        END`,
        costIsApproximate: sql`CASE
          WHEN NOT ${sameCurrency} THEN ${scheduleRuns.costIsApproximate}
          WHEN ${scheduleRuns.costAttribution} IN ('direct', 'mixed')
            THEN ${scheduleRuns.costIsApproximate} OR ${change.approximate ? 1 : 0}
          ELSE ${change.approximate ? 1 : 0}
        END`,
        costAttribution: sql<string>`CASE
          WHEN NOT ${sameCurrency} THEN ${scheduleRuns.costAttribution}
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
  money: RegionalMoney;
  estimatedAmounts?: readonly RegionalMoney[];
}): Promise<string | null> {
  const { runId } = args;
  const money = normalizeRegionalMoney(args.money);
  if (!runId || !money) return null;
  const amount = finitePositive(money.amount);
  // Match the message ledger's delta threshold; a tiny positive residue must
  // not create a direct-only run segment or a misleading changed broadcast.
  if (money.amount > 0 && amount === 0) return null;
  const isEstimate = money.kind === 'value-estimate';
  const estimates = supplementalConversationEstimates({
    turnCost: money, turnUsageDetails: { estimatedAmounts: args.estimatedAmounts },
  });
  const sameEstimate = (isEstimate ? amount : 0) + estimates.filter(value => value.currency === money.currency)
    .reduce((sum, value) => sum + value.amount, 0);
  const otherEstimate = estimates.filter(value => value.currency !== money.currency)
    .reduce((sum, value) => sum + value.amount, 0);

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
  if (!isEstimate && run.costCurrency && run.costCurrency !== money.currency) {
    // 观察到冲突只 warn 留痕;强制语义靠下方 UPDATE 内的 CASE 守卫(先查
    // 再写有 TOCTOU 窗口),冲突段原子地弃掉,不 throw 打断调度记账管道。
    log.warn(
      `schedule run ${runId} currency conflict: keeping ${run.costCurrency}, dropping ${money.currency} segment`,
    );
  }
  const sameCurrency = sql`(${scheduleRuns.costCurrency} IS NULL OR ${scheduleRuns.costCurrency} = ${money.currency})`;

  const result = await db
    .update(scheduleRuns)
    .set({
      costAmount: sql<number>`CASE WHEN ${sameCurrency} THEN MAX(0, ${scheduleRuns.costAmount} + ${isEstimate ? 0 : amount}) ELSE ${scheduleRuns.costAmount} END`,
      estimatedValueAmount: sql<number>`${scheduleRuns.estimatedValueAmount} + CASE WHEN ${sameCurrency} THEN ${sameEstimate} ELSE ${otherEstimate} END`,
      otherEstimatedValueAmount: sql<number>`${scheduleRuns.otherEstimatedValueAmount} + CASE WHEN ${sameCurrency} THEN ${otherEstimate} ELSE ${sameEstimate} END`,
      costCurrency: sql`CASE WHEN ${sameCurrency} THEN ${money.currency} ELSE ${scheduleRuns.costCurrency} END`,
      costIsApproximate: sql`CASE WHEN ${sameCurrency} THEN (${scheduleRuns.costIsApproximate} OR ${
        !isEstimate && money.approximate ? 1 : 0
      }) ELSE ${scheduleRuns.costIsApproximate} END`,
      // A confirmed zero-cost segment must not downgrade a run that already
      // contains an exact segment; otherwise later summary reads lose the
      // accumulated direct cost.
      costAttribution:
        isEstimate || amount > 0
          ? sql<string>`CASE
              WHEN NOT ${sameCurrency} AND ${sameEstimate + otherEstimate} = 0 THEN ${scheduleRuns.costAttribution}
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
