/**
 * Safely invalidates Codex's frozen MCP spawn configuration.
 *
 * The shared app-server must stop before its HTTP bridge is closed. If Codex
 * still has a busy turn, restartCodex rejects and the existing bridge remains
 * intact; callers can then report that the persisted setting is deferred.
 */
export async function refreshCodexMcpEnvironment(deps: {
  /** Hold all local host startup reservations through the supplied refresh. */
  restartCodex: (refreshEnvironment: () => Promise<void>) => Promise<void>;
  shutdownCodexEnvironment: () => Promise<void>;
  /** Schedule the same refresh for the next idle boundary when the host is busy. */
  onDeferred?: () => void;
  logger?: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<{ codexMcpRefreshed: boolean }> {
  let refreshingBridge = false;
  try {
    await deps.restartCodex(async () => {
      refreshingBridge = true;
      await deps.shutdownCodexEnvironment();
    });
  } catch (err) {
    deps.logger?.warn(refreshingBridge
      ? 'Codex MCP refresh deferred because the old bridge could not shut down'
      : 'Codex MCP refresh deferred because the shared host could not restart', {
      error: err instanceof Error ? err.message : String(err),
    });
    deps.onDeferred?.();
    return { codexMcpRefreshed: false };
  }

  return { codexMcpRefreshed: true };
}
