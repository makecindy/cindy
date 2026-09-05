import { selectCodexUsageForModel } from "@cindy/maker-shared/codex-usage-buckets";
import type { MobileMakerTransport } from "@/device-link/mobileMakerTransport";
import type { RemoteSession } from "./types";
import {
  canUseLocalCodexRateLimitControl,
  shouldFallbackToLegacyCodexUsage,
} from "./sessionControls";

type Reader = Pick<
  MobileMakerTransport,
  "getCodexRateLimits" | "getAccountUsage"
>;
/** Mobile presentation only; this shape is never sent through device-link. */
export interface SessionMenuAccountUsage {
  source: "chatgpt" | "claude" | "xai" | "gateway" | "api" | "unavailable";
  plan: string | null;
  updatedAt: number | null;
  windows: Array<{
    id: string;
    minutes: number | null;
    modelLabel?: string;
    remainingPercent: number;
    resetsAt: number | null;
  }>;
  amounts: Array<{
    id: "balance" | "cycle" | "today";
    amount: number;
    currency: "CNY" | "USD";
    limit?: number;
  }>;
  /** The account read cannot prove this task's frozen auth route. */
  accountOnly?: boolean;
}
const empty = (
  source: SessionMenuAccountUsage["source"],
): SessionMenuAccountUsage => ({
  source,
  plan: null,
  updatedAt: null,
  windows: [],
  amounts: [],
});
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

/** Reuse the existing remote Codex read, including its account-change fallback guard. */
export async function readSessionMenuAccountUsage(
  session: RemoteSession,
  reader: Reader,
): Promise<SessionMenuAccountUsage> {
  if (session.remoteHostId?.trim()) return empty("unavailable");
  const provider = session.providerId?.trim() || null;
  const model = session.model.trim();
  if (canUseLocalCodexRateLimitControl(session))
    return readCodexAccount(session, reader);
  if (
    session.agentKind !== "codex" &&
    (provider === null || provider === "openai") &&
    model.startsWith("chatgpt/")
  ) {
    const payload = record(await reader.getAccountUsage("codex"));
    // The ChatGPT bridge uses the web slot, not the CLI's app-server bucket.
    const web =
      payload.webSnapshot ?? (payload.source === "openai-web" ? payload : null);
    return projectCodexAccount(
      web,
      session.model,
      undefined,
      null,
      null,
      false,
    );
  }
  const gateway =
    provider === "xd" ||
    (provider === null &&
      ((session.agentKind === "codex" && model.startsWith("codex/")) ||
        (session.agentKind === "pi" &&
          !model.startsWith("xai/") &&
          !model.startsWith("chatgpt/"))));
  if (gateway) {
    const payload = record(await reader.getAccountUsage("claude-code"));
    const result = empty("gateway");
    result.updatedAt = finite(payload.fetchedAt) ? payload.fetchedAt : null;
    const currency = payload.currency;
    // Preserve the host's currency; an old/malformed payload is not evidence of USD.
    if (currency !== "CNY" && currency !== "USD") return result;
    if (
      finite(payload.spend) &&
      payload.spend >= 0 &&
      finite(payload.maxBudget) &&
      payload.maxBudget > 0
    ) {
      result.amounts.push({
        id: "cycle",
        amount: payload.spend,
        limit: payload.maxBudget,
        currency,
      });
    }
    if (finite(payload.todaySpend) && payload.todaySpend >= 0) {
      result.amounts.push({
        id: "today",
        amount: payload.todaySpend,
        currency,
      });
    }
    return result;
  }
  // Claude/xAI subscription and personal balance reads are not exposed by existing remote APIs.
  return empty(
    provider && !["anthropic", "xai", "openai"].includes(provider)
      ? "api"
      : "unavailable",
  );
}

async function readCodexAccount(
  session: RemoteSession,
  reader: Reader,
): Promise<SessionMenuAccountUsage> {
  let raw: unknown;
  let byLimitId: unknown;
  let observedAt: number | null = null;
  let plan: string | null = null;
  try {
    const result = await reader.getCodexRateLimits();
    raw = result.rateLimits;
    byLimitId = result.rateLimitsByLimitId;
    plan = result.account.planType;
    observedAt = Date.now();
  } catch (error) {
    if (!shouldFallbackToLegacyCodexUsage(error)) throw error;
    raw = await reader.getAccountUsage("codex");
  }
  return projectCodexAccount(
    raw,
    session.model,
    byLimitId,
    observedAt,
    plan,
    true,
  );
}

function projectCodexAccount(
  raw: unknown,
  modelId: string,
  byLimitId: unknown,
  observedAt: number | null,
  plan: string | null,
  accountOnly: boolean,
): SessionMenuAccountUsage {
  const payload = record(raw);
  const now = Date.now();
  const selected = record(
    selectCodexUsageForModel({
      fallback: raw,
      byLimitId,
      appServerBuckets: payload.appServerBuckets,
      modelId,
      nowMs: now,
    }),
  );
  const updatedAt = selected.updatedAt ?? payload.updatedAt;
  const windows: SessionMenuAccountUsage["windows"] = [];
  for (const id of ["primary", "secondary"] as const) {
    const window = record(selected[id]);
    const used = window.usedPercent;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    const resetsAt =
      typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
        ? window.resetsAt
        : null;
    if (resetsAt !== null && resetsAt * 1000 <= now) continue;
    windows.push({
      id,
      minutes:
        typeof window.windowMinutes === "number" &&
        Number.isFinite(window.windowMinutes)
          ? window.windowMinutes
          : null,
      remainingPercent: Math.max(0, Math.min(100, 100 - used)),
      resetsAt,
    });
  }
  return {
    source: "chatgpt",
    accountOnly,
    plan: typeof selected.planType === "string" ? selected.planType : plan,
    updatedAt:
      typeof updatedAt === "number" && Number.isFinite(updatedAt)
        ? updatedAt
        : observedAt,
    windows,
    amounts: [],
  };
}
