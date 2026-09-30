import { getModel, type ProviderView } from "@cindy/model-providers/registry";
import type { AgentKind } from "@cindy/model-providers/types";
import { matchCodexBucketForModel } from "@cindy/maker-shared/codex-usage-buckets";
import type { MobileCodexRateLimitsResult } from "@cindy/maker-shared/device-link-contract";
import type { MobileModelPricingMap } from "@/device-link/mobileMakerTransport";

/** Desktop priceTierOf: standard USD output price; discounts do not change the tier. */
export function mobileCostMarks(
  provider: ProviderView | undefined,
  model: string,
  agent: AgentKind,
  prices?: MobileModelPricingMap | null,
): string | null {
  if (!provider || provider.access?.kind === "subscription") return null;
  const output =
    provider.id === "xd"
      ? prices?.[model]?.outputUsdPerMtok
      : getModel(provider, model, agent)?.cost?.output;
  if (typeof output !== "number" || !Number.isFinite(output) || output <= 0)
    return null;
  return "$".repeat(output <= 3 ? 1 : output <= 15 ? 2 : 3);
}
export type QuotaSource = "codex" | "claude" | "xai";
export function mobileQuotaSource(p: ProviderView): QuotaSource | null {
  if (
    !p.connected ||
    p.suspended ||
    p.openAiAccount?.reconnectRequired ||
    p.auth?.method !== "oauth" ||
    (p.access && p.access.kind !== "subscription")
  )
    return null;
  if (p.id === "openai" || p.auth.native === "codex") return "codex";
  if (p.auth.native === "claude") return "claude";
  if (p.auth.native === "xai") return "xai";
  if (p.source !== "builtin") return null;
  return p.id === "anthropic" ? "claude" : p.id === "xai" ? "xai" : null;
}
export interface MobileWeeklyQuota {
  remaining: number;
  resetsAt: number | null;
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export function mobileWeeklyQuota(
  source: QuotaSource,
  raw: unknown,
  now: number,
  modelId?: string,
): MobileWeeklyQuota | null {
  const data = object(raw);
  let used: unknown;
  let resets: unknown;
  if (source === "codex") {
    const snapshot = data as unknown as MobileCodexRateLimitsResult;
    if (!snapshot.rateLimits) return null;
    const bucket = matchCodexBucketForModel(
      snapshot.rateLimitsByLimitId ?? {
      [snapshot.rateLimits.limitId ?? "codex"]: snapshot.rateLimits,
      },
      modelId,
      now,
    );
    const window = [bucket?.primary, bucket?.secondary].find(
      (w) => w?.windowMinutes === 10080,
    );
    used = window?.usedPercent;
    resets = window?.resetsAt;
  } else if (source === "claude") {
    const window = object(data.sevenDay);
    used = window.utilization;
    resets = window.resetsAt;
  } else {
    if (
      typeof data.updatedAt !== "number" ||
      !Number.isFinite(data.updatedAt) ||
      data.updatedAt <= 0 ||
      now - data.updatedAt > 30 * 60 * 1000
    )
      return null;
    used = data.creditUsagePercent;
    resets = data.resetsAt;
  }
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  const resetsAt =
    typeof resets === "number" && Number.isFinite(resets) && resets > 0
      ? resets
      : null;
  if (resetsAt !== null && resetsAt * 1000 <= now) return null;
  return {
    remaining: Math.round(Math.max(0, Math.min(100, 100 - used))),
    resetsAt,
  };
}
/** Match Desktop compactQuotaCountdown: one unit, rounded up; expired stays unknown. */
export type QuotaTimeUnit = 'day' | 'hour' | 'minute' | 'second';
export function quotaCountdown(reset: number, now: number, unitLabel: (unit: QuotaTimeUnit) => string = unit => ({day:'d',hour:'h',minute:'m',second:'s'})[unit]): string | null {
  if (!Number.isFinite(reset) || reset <= 0) return null;
  const remaining = reset * 1000 - now;
  if (remaining <= 0) return null;
  if (remaining >= 86400000) return `${Math.ceil(remaining / 86400000)}${unitLabel("day")}`;
  if (remaining >= 3600000) return `${Math.ceil(remaining / 3600000)}${unitLabel("hour")}`;
  if (remaining >= 60000) return `${Math.ceil(remaining / 60000)}${unitLabel("minute")}`;
  return `${Math.max(1, Math.ceil(remaining / 1000))}${unitLabel("second")}`;
}

/** The host's connection name and public identity, never the controller's account. */
export function mobileProviderAccountTitle(provider: ProviderView): string {
  const name = provider.name || provider.id;
  const identity = provider.openAiAccount?.identity?.trim() || provider.subscriptionAccount?.identity?.trim();
  if (!identity || name === identity) return name;
  const base = name.replace(/ \(\d+\)$/, '');
  if (base.endsWith(` · ${identity}`)) return name;
  const separator = base.indexOf(' · ');
  if (separator >= 0 && base.length === 50 && `${base.slice(0, separator)} · ${identity}`.slice(0, 50) === base) return name;
  return `${name} · ${identity}`;
}
