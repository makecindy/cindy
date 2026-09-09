/** Owner-bound checks shared by asynchronous Ghost delivery paths. */

export interface GhostOwnerScope {
  /** Capture the owner before the first asynchronous operation. */
  capture(): unknown;
  /** Check the captured in-process owner and generation. */
  isCurrent(scope: unknown): boolean;
  /** Check that the captured process-local owner boundary is still settled. */
  isStable(scope: unknown): boolean;
  /** Stop stale runtime work and discard owner-bound buffered work. */
  onInvalidated?(ghostId: string): void;
}

export function isGhostOwnerScopeUsable(
  scope: GhostOwnerScope | undefined,
  captured: unknown,
): boolean {
  if (!scope) return true;
  try {
    return scope.isCurrent(captured) && scope.isStable(captured);
  } catch {
    return false;
  }
}
