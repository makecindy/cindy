/** Indexed native history belongs to Codex. The host can rebuild from Cindy's transcript. */
export class CodexHistoryRecoveryRequiredError extends Error {
  readonly code = 'CODEX_HISTORY_RECOVERY_REQUIRED';

  constructor() {
    super(
      'Codex native history requires a Cindy context handoff instead of in-place rewriting',
    );
    this.name = 'CodexHistoryRecoveryRequiredError';
  }
}

/** Explicit native handoff requests and broken history qualify; raw auth, transport and cancellation do not. */
export function isCodexHistoryRecoveryRequired(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && error.code === 'CODEX_HISTORY_RECOVERY_REQUIRED')
    return true;
  return (
    error instanceof Error &&
    (/thread history projection[^\n]*expected ordinal \d+, got \d+/i.test(
      error.message,
    ) ||
      /^Codex rollout not found for thread \S+$/.test(error.message) ||
      /(?:^|: )no rollout found for thread id [\w-]+(?:$|["}])/i.test(
        error.message,
      ))
  );
}
