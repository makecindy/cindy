import type { AccountRateLimitsResponse } from '../../../types/account-rate-limits.js';
import { Method } from './protocol.js';

// Bound native pending requests as well as the renderer wait, so retrying a
// stalled quota read releases the host operation instead of leaking leases.
export const CODEX_ACCOUNT_RATE_LIMITS_TIMEOUT_MS = 15_000;

/** Only the read-only account RPC may be retried after native OAuth renewal. */
export async function readAccountRateLimitsWithRefresh(
  request: <T>(method: string, params?: unknown, options?: { timeoutMs: number }) => Promise<T>,
): Promise<AccountRateLimitsResponse> {
  try {
    return await request<AccountRateLimitsResponse>(Method.AccountRateLimitsRead, undefined, { timeoutMs: CODEX_ACCOUNT_RATE_LIMITS_TIMEOUT_MS });
  } catch (error) {
    // Correlated app-server error, not stderr, model text, or an arbitrary 401.
    if (!(error instanceof Error)
      || !error.message.includes(`${Method.AccountRateLimitsRead} error`)
      || !/\b401\b/.test(error.message)
      || !/\btoken_expired\b/.test(error.message)
      || /token_revoked|token_invalidated|refresh_token_reused/.test(error.message)) throw error;
  }
  await request('account/read', { refreshToken: true }, { timeoutMs: 8_000 });
  return request<AccountRateLimitsResponse>(Method.AccountRateLimitsRead, undefined, { timeoutMs: CODEX_ACCOUNT_RATE_LIMITS_TIMEOUT_MS });
}
