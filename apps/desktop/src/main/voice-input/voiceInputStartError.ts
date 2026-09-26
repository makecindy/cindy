/** Classify structured session-allocation errors without exposing upstream text. */
export function isVoiceInputStartRateLimited(error: unknown): boolean {
  // FallbackAsrProvider retains each original ServerApiError in .errors.
  // Mixed failures must keep the generic message: waiting may not fix them.
  const failures: unknown[] = error instanceof AggregateError ? error.errors : [error];
  return failures.length > 0 && failures.every((failure) => (
    failure instanceof Error
    && 'code' in failure && failure.code === 'RATE_LIMITED'
    && 'statusCode' in failure && failure.statusCode === 429
  ));
}
