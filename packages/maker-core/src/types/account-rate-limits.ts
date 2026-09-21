/** A rolling account quota window reported by an agent runtime. */
export interface AccountRateLimitWindow {
  /** Percentage consumed, in the inclusive range 0-100. */
  usedPercent: number;
  /** Normalized window duration used by Cindy presentation layers. */
  windowMinutes?: number | null;
  /** Raw Codex app-server field (0.144.x wire shape). */
  windowDurationMins?: number | null;
  /** Unix epoch seconds when this window resets. */
  resetsAt?: number | null;
}

/** Optional prepaid-credit balance attached to an account quota snapshot. */
export interface AccountCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string | null;
}

/** One provider-defined account quota bucket. */
export interface AccountRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  /**
   * Model this bucket serves as a fallback for, e.g. `gpt-5.6-luna` on the
   * `base_model_inference` reserve. Only the reserve buckets carry it; it is the
   * only reliable way to bind a reserve to a model, since its `limitName`
   * (`gpt-reserve`) never matches a model id. Requires codex >= 0.154.
   */
  normalModelSlug?: string | null;
  primary?: AccountRateLimitWindow | null;
  secondary?: AccountRateLimitWindow | null;
  credits?: AccountCreditsSnapshot | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

/** Normalize Codex 0.144 wire duration without reallocating already-normalized snapshots. */
export function normalizeAccountRateLimitSnapshot(
  snapshot: AccountRateLimitSnapshot,
): AccountRateLimitSnapshot {
  const primary = normalizeAccountRateLimitWindow(snapshot.primary);
  const secondary = normalizeAccountRateLimitWindow(snapshot.secondary);
  if (primary === snapshot.primary && secondary === snapshot.secondary) return snapshot;
  return { ...snapshot, primary, secondary };
}

function normalizeAccountRateLimitWindow(
  window: AccountRateLimitWindow | null | undefined,
): AccountRateLimitWindow | null | undefined {
  if (!window || window.windowMinutes != null || window.windowDurationMins == null) return window;
  return { ...window, windowMinutes: window.windowDurationMins };
}

/** Lifecycle state of one banked Codex rate-limit reset credit. */
export type AccountRateLimitResetCreditStatus =
  | 'available'
  | 'redeeming'
  | 'redeemed'
  | 'unknown';

/** Provider-defined kind of reset performed by a banked credit. */
export type AccountRateLimitResetType = 'codexRateLimits' | 'unknown';

/** One banked reset credit returned by the Codex app-server. */
export interface AccountRateLimitResetCredit {
  /** Opaque backend identifier. */
  id: string;
  resetType: AccountRateLimitResetType;
  status: AccountRateLimitResetCreditStatus;
  /** Unix epoch seconds when the credit was granted. */
  grantedAt: number;
  /** Unix epoch seconds when the credit expires, or null when it does not expire. */
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}

/** Count plus optional detail rows for currently available reset credits. */
export interface AccountRateLimitResetCreditsSummary {
  /** app-server schema is u64; JSON transports the small real-world value as a number. */
  availableCount: number | bigint;
  /** null means only the count is known; an empty array means details were fetched. */
  credits: AccountRateLimitResetCredit[] | null;
}

/** Complete account quota snapshot returned by the agent runtime. */
export interface AccountRateLimitsResponse {
  rateLimits: AccountRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, AccountRateLimitSnapshot> | null;
  rateLimitResetCredits: AccountRateLimitResetCreditsSummary | null;
  /**
   * False once the main quota is spent. A reserve bucket may still serve the
   * turn, so this must not be treated as "the account is blocked". Absent on
   * runtimes older than codex 0.154.
   */
  ordinaryUsageAllowed?: boolean | null;
}

/** One logical reset attempt; callers must reuse the key when retrying. */
export interface ConsumeAccountRateLimitResetCreditParams {
  idempotencyKey: string;
  /** Omit to let the backend choose an available credit. */
  creditId?: string | null;
}

/** Terminal outcome of a Codex banked reset request. */
export type ConsumeAccountRateLimitResetCreditOutcome =
  | 'reset'
  | 'nothingToReset'
  | 'noCredit'
  | 'alreadyRedeemed';

/** Response returned after attempting to consume one reset credit. */
export interface ConsumeAccountRateLimitResetCreditResponse {
  outcome: ConsumeAccountRateLimitResetCreditOutcome;
}
