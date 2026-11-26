/**
 * The official CLI answered an account request but could not reach its account service (DNS,
 * proxy, TLS or a stalled request). The login on disk may be fine (2026-11-18: a router returned
 * a wrong address for chatgpt.com, so reads timed out and the account looked signed out).
 * Callers report it as a connection problem, never as a sign-out. Carries no CLI text.
 */
export class AccountServiceUnreachableError extends Error {
  override name = 'AccountServiceUnreachableError';
}

export function isAccountServiceUnreachable(error: unknown): error is AccountServiceUnreachableError {
  return error instanceof AccountServiceUnreachableError;
}

/** Admission failed before a local Codex engine was started. */
export class CodexAccountReadDeferred extends Error {
  constructor(readonly retryAt: number) {
    super('[CODEX_ACCOUNT_SERVICE_UNREACHABLE] The Codex account service is temporarily unreachable');
  }
}
