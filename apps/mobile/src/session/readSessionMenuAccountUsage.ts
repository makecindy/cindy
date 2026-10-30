import { selectCodexUsageForModel } from "@cindy/maker-shared/codex-usage-buckets";
import { isCodexGatewayWireModel } from "@cindy/model-providers/classification";
import { formatRemoteError } from "@cindy/maker-shared/device-link-contract";
import {
  isXaiWeeklyUsageCurrent,
  matchScopedWindowForModel,
  type ClaudeScopedUsageWindow,
  type XaiSubscriptionUsageSnapshot,
} from "@cindy/maker-shared/subscription-usage";
import {
  NATIVE_SUBSCRIPTION_DEFAULT_PROVIDER_IDS,
  type NativeSubscriptionAuth,
} from "@cindy/model-providers/types";
import type { MobileMakerTransport } from "@/device-link/mobileMakerTransport";
import type { RemoteSession } from "./types";
import {
  canUseLocalCodexRateLimitControl,
  type OpenAiAccountProvider,
  shouldFallbackToLegacyCodexUsage,
} from "./sessionControls";

type Reader = Pick<
  MobileMakerTransport,
  | "getCodexRateLimits"
  | "getAccountUsage"
  | "getSubscriptionUsage"
  | "getClaudeSessionRoute"
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
  /** ChatGPT's own credits (not money): the reported balance and/or the account's credit state. */
  credits?: {
    balance: number | null;
    status: "unlimited" | "depleted" | "available" | null;
  };
}
/** Display source of each subscription family; keyed so a new family cannot be skipped. */
export const SUBSCRIPTION_USAGE_SOURCES = {
  codex: "chatgpt",
  claude: "claude",
  xai: "xai",
} as const satisfies Record<NativeSubscriptionAuth, SessionMenuAccountUsage["source"]>;
export function isSubscriptionUsageSource(
  source: SessionMenuAccountUsage["source"] | undefined,
): boolean {
  return (Object.values(SUBSCRIPTION_USAGE_SOURCES) as string[]).includes(
    source ?? "",
  );
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
/** An account this device cannot read (e.g. a provider shared by another account). */
export function unavailableSessionMenuAccountUsage(): SessionMenuAccountUsage {
  return empty("unavailable");
}
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

type ClaudeSessionRoute = "gateway" | "subscription" | null;

/** The subscription family behind a provider selection, or null for Gateway / API routes. */
function accountFamily(
  providerId: string | null,
  accountProvider?: OpenAiAccountProvider,
): NativeSubscriptionAuth | null {
  if (!providerId) return null;
  for (const [family, id] of Object.entries(
    NATIVE_SUBSCRIPTION_DEFAULT_PROVIDER_IDS,
  ))
    if (id === providerId) return family as NativeSubscriptionAuth;
  if (accountProvider?.id !== providerId || accountProvider.auth?.method !== "oauth")
    return null;
  return accountProvider.auth.native ?? null;
}

/**
 * The subscription this task consumes, mirroring the desktop device-link chip.
 * Model bridge prefixes decide the consumed account; an unselected Claude Code route
 * is only attributed when the host has observed it (claudeRoute), never from login state.
 */
export function sessionSubscriptionFamily(
  session: Pick<
    RemoteSession,
    "agentKind" | "model" | "providerId" | "remoteHostId"
  >,
  accountProvider?: OpenAiAccountProvider,
  claudeRoute: ClaudeSessionRoute = null,
): NativeSubscriptionAuth | null {
  if (session.remoteHostId?.trim()) return null;
  if (canUseLocalCodexRateLimitControl(session, accountProvider)) return "codex";
  const provider = session.providerId?.trim() || null;
  const family = accountFamily(provider, accountProvider);
  const model = session.model.trim();
  // The host routes these prefixes to the subscription bridge on their own; with no
  // selected provider they consume the family's default account.
  if (model.startsWith("chatgpt/"))
    return session.agentKind !== "codex" && (family === "codex" || provider === null)
      ? "codex"
      : null;
  if (model.startsWith("xai/"))
    return family === "xai" || provider === null ? "xai" : null;
  // Pi catalog ids lack the xai/ prefix, so the selected account decides.
  if (family === "xai" || family === "claude") return family;
  return provider === null &&
    session.agentKind === "cc" &&
    claudeRoute === "subscription"
    ? "claude"
    : null;
}

type FamilyReader = (
  session: RemoteSession,
  reader: Reader,
) => Promise<SessionMenuAccountUsage>;
/** One reader per subscription family. Adding a family without a reader fails type checking. */
const SUBSCRIPTION_READERS: Record<NativeSubscriptionAuth, FamilyReader> = {
  codex: (session, reader) =>
    session.agentKind === "codex"
      ? readCodexAccount(session, reader)
      : readChatgptBridgeAccount(session, reader),
  claude: readClaudeAccount,
  xai: readXaiAccount,
};

function isChannelNotAllowedError(error: unknown): boolean {
  return formatRemoteError(error).includes("CHANNEL_NOT_ALLOWED");
}

/** The host's observed billing route for a default-route Claude Code task. */
async function readDefaultClaudeRoute(
  session: RemoteSession,
  reader: Reader,
): Promise<ClaudeSessionRoute> {
  const model = session.model.trim();
  if (
    session.agentKind !== "cc" ||
    session.providerId?.trim() ||
    model.startsWith("chatgpt/") ||
    model.startsWith("xai/")
  )
    return null;
  // Only an older host without the channel means "route unknown". Transient failures
  // must reject so the menu keeps the previous quota and marks it stale.
  const route = await reader.getClaudeSessionRoute(session.id).catch((error) => {
    if (isChannelNotAllowedError(error)) return null;
    throw error;
  });
  return route === "gateway" || route === "subscription" ? route : null;
}

/** Read the account quota behind this task's route; never another route's account. */
export async function readSessionMenuAccountUsage(
  session: RemoteSession,
  reader: Reader,
  accountProvider?: OpenAiAccountProvider,
): Promise<SessionMenuAccountUsage> {
  if (session.remoteHostId?.trim()) return empty("unavailable");
  // The host projects runtime-effective selection onto providerId. Missing
  // selection alone proves neither a Gateway nor a subscription route.
  const provider = session.providerId?.trim() || null;
  const model = session.model.trim();
  const claudeRoute = await readDefaultClaudeRoute(session, reader);
  const family = sessionSubscriptionFamily(session, accountProvider, claudeRoute);
  if (family) return SUBSCRIPTION_READERS[family](session, reader);
  const gateway =
    provider === "xd" ||
    (provider === null &&
      ((session.agentKind === "codex" && isCodexGatewayWireModel(model)) ||
        claudeRoute === "gateway"));
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
  return empty(
    provider && !accountFamily(provider, accountProvider) ? "api" : "unavailable",
  );
}

/** Independent accounts are read by their own id; the family default reads without one. */
function accountScope(session: RemoteSession): string | undefined {
  return session.providerId?.trim() || undefined;
}

async function readChatgptBridgeAccount(
  session: RemoteSession,
  reader: Reader,
): Promise<SessionMenuAccountUsage> {
  const payload = record(await (session.providerId && session.providerId !== 'openai' ? reader.getAccountUsage("codex", session.providerId) : reader.getAccountUsage("codex")));
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

async function readClaudeAccount(
  session: RemoteSession,
  reader: Reader,
): Promise<SessionMenuAccountUsage> {
  const snapshot = record(
    await reader.getSubscriptionUsage("claude", accountScope(session)),
  );
  const result = empty("claude");
  result.plan =
    typeof snapshot.subscriptionType === "string" &&
    snapshot.subscriptionType.trim()
      ? snapshot.subscriptionType.trim()
      : null;
  result.updatedAt = finite(snapshot.updatedAt) ? snapshot.updatedAt : null;
  const now = Date.now();
  const add = (
    id: string,
    minutes: number,
    raw: unknown,
    modelLabel?: string,
  ) => {
    const window = record(raw);
    if (!finite(window.utilization)) return;
    const resetsAt = finite(window.resetsAt) ? window.resetsAt : null;
    if (resetsAt !== null && resetsAt * 1000 <= now) return;
    result.windows.push({
      id,
      ...(modelLabel ? { modelLabel } : {}),
      minutes,
      remainingPercent: clampPercent(100 - window.utilization),
      resetsAt,
    });
  };
  // Overall and model-specific limits both constrain the task; show each that applies.
  add("five-hour", 300, snapshot.fiveHour);
  add("seven-day", 10080, snapshot.sevenDay);
  const scoped = (Array.isArray(snapshot.scoped) ? snapshot.scoped : []).filter(
    (window): window is ClaudeScopedUsageWindow =>
      typeof record(window).modelDisplayName === "string",
  );
  const modelWindow = matchScopedWindowForModel(scoped, session.model);
  if (modelWindow)
    add("model:seven-day", 10080, modelWindow, modelWindow.modelDisplayName);
  return result;
}

async function readXaiAccount(
  session: RemoteSession,
  reader: Reader,
): Promise<SessionMenuAccountUsage> {
  const snapshot = record(
    await reader.getSubscriptionUsage("xai", accountScope(session)),
  );
  const result = empty("xai");
  result.plan =
    typeof snapshot.planLabel === "string" && snapshot.planLabel.trim()
      ? snapshot.planLabel.trim()
      : null;
  result.updatedAt = finite(snapshot.updatedAt) ? snapshot.updatedAt : null;
  const current = isXaiWeeklyUsageCurrent(
    snapshot as XaiSubscriptionUsageSnapshot,
    Date.now(),
  );
  if (current && finite(snapshot.creditUsagePercent)) {
    result.windows.push({
      id: "week",
      minutes: 10080,
      remainingPercent: clampPercent(100 - snapshot.creditUsagePercent),
      resetsAt: finite(snapshot.resetsAt) ? snapshot.resetsAt : null,
    });
  }
  // A zero balance is not a free allowance; only show purchased credits, and only
  // while the snapshot is current (the desktop card hides both together).
  if (current && finite(snapshot.prepaidBalance) && snapshot.prepaidBalance > 0)
    result.amounts.push({
      id: "balance",
      amount: snapshot.prepaidBalance,
      currency: "USD",
    });
  return result;
}

async function readCodexAccount(
  session: RemoteSession,
  reader: Reader,
): Promise<SessionMenuAccountUsage> {
  let raw: unknown;
  let byLimitId: unknown;
  let observedAt: number | null = null;
  let plan: string | null = null;
  let creditSources: unknown[] = [];
  const readAccountUsage = () =>
    session.providerId && session.providerId !== 'openai'
      ? reader.getAccountUsage("codex", session.providerId)
      : reader.getAccountUsage("codex");
  try {
    const result = await (session.providerId && session.providerId !== 'openai' ? reader.getCodexRateLimits(session.providerId) : reader.getCodexRateLimits());
    raw = result.rateLimits;
    byLimitId = result.rateLimitsByLimitId;
    plan = result.account.planType;
    observedAt = Date.now();
    // The control read omits credits; the desktop card reads them from the account
    // snapshot this read just recorded. Every host has that channel, so a failure is
    // transient and fails the read: the menu keeps the previous values marked stale.
    const usage = record(await readAccountUsage());
    creditSources = [usage, ...Object.values(record(usage.appServerBuckets))];
  } catch (error) {
    if ((session.providerId && session.providerId !== 'openai') || !shouldFallbackToLegacyCodexUsage(error)) throw error;
    raw = await readAccountUsage();
  }
  return projectCodexAccount(
    raw,
    session.model,
    byLimitId,
    observedAt,
    plan,
    true,
    creditSources,
  );
}

function projectCodexAccount(
  raw: unknown,
  modelId: string,
  byLimitId: unknown,
  observedAt: number | null,
  plan: string | null,
  accountOnly: boolean,
  creditSources: unknown[] = [],
): SessionMenuAccountUsage {
  const payload = record(raw);
  const now = Date.now();
  const input = {
    fallback: raw,
    byLimitId,
    appServerBuckets: payload.appServerBuckets,
    nowMs: now,
  };
  // Generic and model-specific limits both apply. Reuse the shared selector's
  // source precedence, generic aliases and stale-bucket rules for both reads.
  const generic = selectCodexUsageForModel(input);
  const selected = selectCodexUsageForModel({ ...input, modelId });
  const selectedPlan = record(selected).planType;
  const snapshots = [...new Set([generic, selected])]
    .filter(Boolean)
    .map(record);
  const timestamps = snapshots
    .map((snapshot) => snapshot.updatedAt ?? payload.updatedAt ?? observedAt)
    .filter(finite);
  const windows: SessionMenuAccountUsage["windows"] = [];
  for (const snapshot of snapshots) {
    const modelLabel =
      snapshot !== generic
        ? typeof snapshot.limitName === "string"
          ? snapshot.limitName
          : modelId
        : undefined;
    for (const id of ["primary", "secondary"] as const) {
      const window = record(snapshot[id]);
      const used = window.usedPercent;
      if (typeof used !== "number" || !Number.isFinite(used)) continue;
      const resetsAt =
        typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
          ? window.resetsAt
          : null;
      if (resetsAt !== null && resetsAt * 1000 <= now) continue;
      windows.push({
        id: modelLabel ? `model:${id}` : id,
        ...(modelLabel ? { modelLabel } : {}),
        minutes:
          typeof window.windowMinutes === "number" &&
          Number.isFinite(window.windowMinutes)
            ? window.windowMinutes
            : null,
        remainingPercent: Math.max(0, Math.min(100, 100 - used)),
        resetsAt,
      });
    }
  }
  const credits = projectCodexCredits([
    ...snapshots,
    payload,
    ...creditSources.map(record),
  ]);
  return {
    source: "chatgpt",
    accountOnly,
    plan: typeof selectedPlan === "string" ? selectedPlan : plan,
    updatedAt: timestamps.length > 0 ? Math.min(...timestamps) : observedAt,
    windows,
    amounts: [],
    ...(credits ? { credits } : {}),
  };
}

/** Credits are account-wide; same facts and precedence as the desktop ChatGPT card. */
function projectCodexCredits(
  snapshots: Array<Record<string, unknown>>,
): SessionMenuAccountUsage["credits"] | null {
  const credits = snapshots
    .map((snapshot) => record(snapshot.credits))
    .find(
      (value) =>
        typeof value.hasCredits === "boolean" ||
        typeof value.unlimited === "boolean",
    );
  if (!credits) return null;
  const raw =
    typeof credits.balance === "string"
      ? credits.balance.trim().replace(/,/g, "")
      : "";
  const balance = raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
  // A reported balance and an exhausted state are both facts; keep both.
  const status =
    credits.unlimited === true
      ? "unlimited"
      : credits.hasCredits === false
        ? "depleted"
        : credits.hasCredits === true && balance === null
          ? "available"
          : null;
  return balance === null && status === null ? null : { balance, status };
}
