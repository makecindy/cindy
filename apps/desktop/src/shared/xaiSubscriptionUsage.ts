/**
 * xaiSubscriptionUsage — SuperGrok 账号周用量的共享类型与纯解析。
 *
 * 数据来自 grok-cli 代理未文档化接口(与 grok.com Settings → Usage 对过字段):
 *   - GET cli-chat-proxy.grok.com/v1/settings → subscription_tier_display
 *   - GET cli-chat-proxy.grok.com/v1/billing?format=credits → 周已用百分比 /
 *     重置时间 / 分产品
 *
 * 这是账号级「每周包含限额」,不是单次任务配额,也不是 api.x.ai 的 RPM/TPM 限流。
 * 解析必须 fail-safe:字段缺失 / 形状不符就跳过,绝不从 token 数反推百分比。
 * 例外:仅当 currentPeriod.type 明确是 USAGE_PERIOD_TYPE_WEEKLY、窗口尚未结束、
 * 且响应里根本没有 creditUsagePercent 键时,按 proto3 默认值当成 0%。
 * 字段在但解不出数、只有未来 billingPeriodEnd、或非周窗口,都不能推断 0%。
 */

import {
  isXaiWeeklyUsageCurrent,
  type XaiProductUsage,
  type XaiSubscriptionUsageSnapshot,
} from '@cindy/maker-shared/subscription-usage';

// 快照契约与新鲜度判定在 maker-shared,mobile 任务菜单复用同一份口径。
export type { XaiProductUsage, XaiSubscriptionUsageSnapshot } from '@cindy/maker-shared/subscription-usage';
export { isXaiWeeklyUsageCurrent, XAI_USAGE_STALE_MS } from '@cindy/maker-shared/subscription-usage';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(v: number): number {
  return Math.min(100, Math.max(0, v));
}

function toOptionalString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** ISO8601 / epoch 秒 → epoch 秒;解析不了 → null。 */
export function toXaiUsageEpochSeconds(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === 'string' && v.length > 0) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return null;
}

function unwrapVal(v: unknown): unknown {
  if (isPlainObject(v) && 'val' in v) return v.val;
  return v;
}

/** settings JSON → 套餐名。没有 subscription_tier_display 则 null。 */
export function parseXaiSettingsPlanLabel(data: unknown): string | null {
  if (!isPlainObject(data)) return null;
  return toOptionalString(data.subscription_tier_display);
}

function parseProductUsage(raw: unknown): XaiProductUsage[] {
  if (!Array.isArray(raw)) return [];
  const out: XaiProductUsage[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const product = toOptionalString(entry.product);
    const usagePercent = toFiniteNumber(entry.usagePercent);
    if (!product || usagePercent === null) continue;
    out.push({ product, usagePercent: clampPercent(usagePercent) });
  }
  return out;
}

const XAI_WEEKLY_PERIOD_TYPE = 'USAGE_PERIOD_TYPE_WEEKLY';

/** 只有上游标明的周窗口才能用来推断省略的 creditUsagePercent。 */
export function isXaiWeeklyUsagePeriod(period: unknown): period is Record<string, unknown> {
  if (!isPlainObject(period)) return false;
  const type = toOptionalString(period.type);
  return type === XAI_WEEKLY_PERIOD_TYPE;
}

/**
 * 未结束的周窗口里,省略的 creditUsagePercent 就是 0%。
 * weeklyResetsAt 必须来自 USAGE_PERIOD_TYPE_WEEKLY 的 currentPeriod.end;
 * fieldOmitted 必须是键不存在。字段在但解不出、月度 billingPeriodEnd、
 * 非周窗口、已过期窗口都保持 null,让 fetch 保缓存。
 */
export function inferXaiWeeklyUsagePercent(
  creditUsagePercent: number | null,
  weeklyResetsAt: number | null,
  nowMs: number,
  fieldOmitted = false,
): number | null {
  if (creditUsagePercent !== null) return clampPercent(creditUsagePercent);
  if (!fieldOmitted) return null;
  if (
    typeof weeklyResetsAt === 'number'
    && Number.isFinite(weeklyResetsAt)
    && weeklyResetsAt > 0
    && nowMs < weeklyResetsAt * 1000
  ) {
    return 0;
  }
  return null;
}

/**
 * 解析 billing?format=credits 的 config。
 * 至少要有 creditUsagePercent 或重置时间,否则返回 null。
 */
export function parseXaiBillingCreditsConfig(
  data: unknown,
  nowMs: number = Date.now(),
): {
  creditUsagePercent: number | null;
  resetsAt: number | null;
  productUsage: XaiProductUsage[];
  prepaidBalance: number | null;
} | null {
  if (!isPlainObject(data)) return null;
  const config = isPlainObject(data.config) ? data.config : data;
  const percentOmitted = !Object.prototype.hasOwnProperty.call(config, 'creditUsagePercent');
  const creditUsagePercent = toFiniteNumber(config.creditUsagePercent);
  const period = isPlainObject(config.currentPeriod) ? config.currentPeriod : null;
  const weeklyResetsAt = isXaiWeeklyUsagePeriod(period)
    ? toXaiUsageEpochSeconds(period.end)
    : null;
  const resetsAt =
    weeklyResetsAt
    ?? toXaiUsageEpochSeconds(period?.end)
    ?? toXaiUsageEpochSeconds(config.billingPeriodEnd);
  const prepaidBalance = toFiniteNumber(unwrapVal(config.prepaidBalance));
  if (creditUsagePercent === null && resetsAt === null) return null;
  return {
    creditUsagePercent: inferXaiWeeklyUsagePercent(
      creditUsagePercent,
      weeklyResetsAt,
      nowMs,
      percentOmitted,
    ),
    resetsAt,
    productUsage: parseProductUsage(config.productUsage),
    prepaidBalance,
  };
}

export function buildXaiSubscriptionUsageSnapshot(input: {
  planLabel?: string | null;
  credits?: ReturnType<typeof parseXaiBillingCreditsConfig>;
  accountFingerprint?: string | null;
  now: number;
}): XaiSubscriptionUsageSnapshot | null {
  const planLabel = toOptionalString(input.planLabel);
  const credits = input.credits;
  if (!planLabel && !credits) return null;
  return {
    planLabel,
    creditUsagePercent: credits?.creditUsagePercent ?? null,
    resetsAt: credits?.resetsAt ?? null,
    productUsage: credits?.productUsage ?? [],
    prepaidBalance: credits?.prepaidBalance ?? null,
    source: 'cli-billing',
    updatedAt: input.now,
    accountFingerprint: toOptionalString(input.accountFingerprint),
  };
}

/** GrokBuild → Grok Build;已有空格的原样返回。 */
export function formatXaiProductLabel(product: string): string {
  const trimmed = product.trim();
  if (!trimmed) return trimmed;
  if (/\s/.test(trimmed)) return trimmed;
  return trimmed.replace(/([a-z])([A-Z])/g, '$1 $2');
}

const WINDOW_ALERT_UTILIZATION_PERCENT = 90;

/** chip 警示:周已用 ≥90%。 */
export function isXaiSubscriptionAlerting(
  snapshot: XaiSubscriptionUsageSnapshot | null,
  nowMs: number = Date.now(),
): boolean {
  if (!isXaiWeeklyUsageCurrent(snapshot, nowMs)) return false;
  const used = snapshot?.creditUsagePercent;
  return typeof used === 'number' && Number.isFinite(used) && clampPercent(used) >= WINDOW_ALERT_UTILIZATION_PERCENT;
}
