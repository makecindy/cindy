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

export interface ScheduleRunCostDelta {
  runId: string;
  costAmountDelta: number;
  estimatedValueAmountDelta: number;
  currency: 'CNY' | 'USD';
  approximate: boolean;
}

function finitePositive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
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
    current.approximate ||= entry.approximate;
    changes.set(entry.runId, current);
  };
  apply(runCostEntry(previous), -1);
  apply(runCostEntry(next), 1);
  return [...changes.values()].filter(
    (change) =>
      Math.abs(change.costAmountDelta) >= 1e-10 ||
      Math.abs(change.estimatedValueAmountDelta) >= 1e-10,
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
        costAmount: sql<number>`MAX(0, ${scheduleRuns.costAmount} + ${change.costAmountDelta})`,
        estimatedValueAmount: sql<number>`MAX(0, ${scheduleRuns.estimatedValueAmount} + ${change.estimatedValueAmountDelta})`,
        costCurrency: change.currency,
        costIsApproximate: sql`${scheduleRuns.costIsApproximate} OR ${change.approximate ? 1 : 0}`,
        costAttribution: 'exact',
      })
      .where(eq(scheduleRuns.id, change.runId));
  }
}
