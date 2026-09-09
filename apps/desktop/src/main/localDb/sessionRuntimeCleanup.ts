type SessionRuntimeCleanup = (sessionId: string) => void;

let sessionRuntimeCleanup: SessionRuntimeCleanup | null = null;

/** Composition-root injection for Host-owned runtime routing state. */
export function setSessionRuntimeCleanup(cleanup: SessionRuntimeCleanup | null): void {
  sessionRuntimeCleanup = cleanup;
}

/**
 * Runtime model/provider/axis overrides survive ordinary process release, but
 * not task archive/delete boundaries. Call this while holding the task route
 * lock that commits the terminal status so a queued mutation cannot recreate
 * state between the DB write and cleanup.
 */
export function cleanupSessionRuntimeForTerminalStatus(sessionId: string, status: unknown): void {
  if (status !== 'deleted' && status !== 'archived') return;
  sessionRuntimeCleanup?.(sessionId);
}
