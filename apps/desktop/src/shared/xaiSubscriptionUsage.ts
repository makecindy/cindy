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
 */

/** 分产品周用量(页面「Grok Build 2%」)。 */
export interface XaiProductUsage {
  /** 上游 product id,如 GrokBuild。 */
  product: string;
  /** 0-100 已用百分比。 */
  usagePercent: number;
}

export interface XaiSubscriptionUsageSnapshot {
  /** 套餐展示名,如 SuperGrok Heavy。 */
  planLabel?: string | null;
  /** 0-100 本周已用百分比(页面「2% 已使用」)。 */
  creditUsagePercent?: number | null;
  /** Unix epoch 秒;周窗口重置时刻。 */
  resetsAt?: number | null;
  /** 分产品已用百分比。 */
  productUsage?: XaiProductUsage[];
  /**
   * 额外使用点数余额。单位按 grok.com 页面为美元;0 / 缺失不要当「免费额度」展示。
   */
  prepaidBalance?: number | null;
  source?: 'cli-billing' | string | null;
  updatedAt?: number | null;
  /**
   * 稳定账号指纹(OIDC sub 的不可逆哈希)。换 SuperGrok 号时用来丢掉旧快照。
   * 不是 access token 哈希 —— token 刷新会轮换。
   */
  accountFingerprint?: string | null;
}

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

/**
 * 解析 billing?format=credits 的 config。
 * 至少要有 creditUsagePercent 或重置时间,否则返回 null。
 */
export function parseXaiBillingCreditsConfig(data: unknown): {
  creditUsagePercent: number | null;
  resetsAt: number | null;
  productUsage: XaiProductUsage[];
  prepaidBalance: number | null;
} | null {
  if (!isPlainObject(data)) return null;
  const config = isPlainObject(data.config) ? data.config : data;
  const creditUsagePercent = toFiniteNumber(config.creditUsagePercent);
  const period = isPlainObject(config.currentPeriod) ? config.currentPeriod : null;
  const resetsAt =
    toXaiUsageEpochSeconds(period?.end)
    ?? toXaiUsageEpochSeconds(config.billingPeriodEnd);
  const prepaidBalance = toFiniteNumber(unwrapVal(config.prepaidBalance));
  if (creditUsagePercent === null && resetsAt === null) return null;
  return {
    creditUsagePercent: creditUsagePercent === null ? null : clampPercent(creditUsagePercent),
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

/** 超过这个时间没刷新到新快照,就不再当「当前额度」展示。 */
export const XAI_USAGE_STALE_MS = 30 * 60 * 1000;

/**
 * 周窗口数字是否还能当当前额度:过了 TTL,或已经过了 resetsAt 却还没新快照,
 * 都不当当前值(避免无限显示旧百分比 / 卡在「重置中」)。套餐名仍可单独展示。
 */
export function isXaiWeeklyUsageCurrent(
  snapshot: XaiSubscriptionUsageSnapshot | null | undefined,
  nowMs: number,
): boolean {
  if (!snapshot) return false;
  if (
    typeof snapshot.creditUsagePercent !== 'number'
    || !Number.isFinite(snapshot.creditUsagePercent)
  ) {
    return false;
  }
  if (typeof snapshot.updatedAt !== 'number' || !Number.isFinite(snapshot.updatedAt) || snapshot.updatedAt <= 0) {
    return false;
  }
  if (nowMs - snapshot.updatedAt > XAI_USAGE_STALE_MS) return false;
  if (typeof snapshot.resetsAt === 'number' && Number.isFinite(snapshot.resetsAt) && snapshot.resetsAt > 0) {
    if (nowMs >= snapshot.resetsAt * 1000) return false;
  }
  return true;
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
