/**
 * A long-lived Claude token carries no identity: the service refuses profile reads for it. What
 * both credentials do report is when the account's quota windows reset. The token's tasks report
 * those times, and the ordinary login kept beside the token reports them for the account the user
 * signed in as. Windows that reset at the same moment are taken as the same account; windows that
 * differ mean the token was authorized for some other account.
 *
 * An inference, not proof: reset times are rounded, so two accounts can coincide.
 */
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage.js';

export interface ClaudeQuotaWindowResets {
  /** Epoch seconds. */
  fiveHour?: number | null;
  sevenDay?: number | null;
}

/** The service rounds reset times; both readings of one window agree to well within this. */
const SAME_WINDOW_TOLERANCE_SECONDS = 120;

export function claudeQuotaWindowResets(
  usage: Pick<ClaudeSubscriptionUsageSnapshot, 'fiveHour' | 'sevenDay'> | null | undefined,
): ClaudeQuotaWindowResets | undefined {
  const fiveHour = usage?.fiveHour?.resetsAt ?? null;
  const sevenDay = usage?.sevenDay?.resetsAt ?? null;
  return fiveHour === null && sevenDay === null ? undefined : { fiveHour, sevenDay };
}

/**
 * Compare the windows both sides know and that are still running. A window that already reset on
 * either side says nothing: the other reading may simply be newer.
 */
export function compareClaudeQuotaWindows(
  token: ClaudeQuotaWindowResets | undefined,
  storedLogin: ClaudeQuotaWindowResets | undefined,
  nowMs: number,
): 'same' | 'different' | 'unknown' {
  if (!token || !storedLogin) return 'unknown';
  const nowSeconds = nowMs / 1000;
  let compared = 0;
  for (const window of ['fiveHour', 'sevenDay'] as const) {
    const a = token[window];
    const b = storedLogin[window];
    if (typeof a !== 'number' || typeof b !== 'number' || a <= nowSeconds || b <= nowSeconds) continue;
    if (Math.abs(a - b) > SAME_WINDOW_TOLERANCE_SECONDS) return 'different';
    compared += 1;
  }
  return compared > 0 ? 'same' : 'unknown';
}
