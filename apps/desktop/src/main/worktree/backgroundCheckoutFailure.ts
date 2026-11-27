const MAX_RETAINED_CHECKOUT_FAILURES = 200;
const backgroundCheckoutFailures = new Map<string, Error>();

export function recordBackgroundCheckoutFailure(sessionId: string, err: unknown): void {
  const failure = err instanceof Error ? err : new Error(String(err));
  backgroundCheckoutFailures.delete(sessionId);
  backgroundCheckoutFailures.set(sessionId, failure);
  while (backgroundCheckoutFailures.size > MAX_RETAINED_CHECKOUT_FAILURES) {
    const oldestKey = backgroundCheckoutFailures.keys().next().value;
    if (oldestKey === undefined) break;
    backgroundCheckoutFailures.delete(oldestKey);
  }
}

export function getBackgroundCheckoutFailure(sessionId: string): Error | undefined {
  return backgroundCheckoutFailures.get(sessionId);
}

export function clearBackgroundCheckoutFailure(sessionId: string): void {
  backgroundCheckoutFailures.delete(sessionId);
}

/** Test-only helper to simulate a process restart that drops in-memory failure entries. */
export function _clearAllBackgroundCheckoutFailuresForTests(): void {
  backgroundCheckoutFailures.clear();
}
