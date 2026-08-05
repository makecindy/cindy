/**
 * Safely invalidates Codex's frozen MCP spawn configuration.
 *
 * The shared app-server must stop before its HTTP bridge is closed. If Codex
 * still has a busy turn, restartCodex rejects and the existing bridge remains
 * intact; callers can then report that the persisted setting is deferred.
 */
export async function refreshCodexMcpEnvironment(deps: {
  restartCodex: () => Promise<void>;
  shutdownCodexEnvironment: () => Promise<void>;
  logger?: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<{ codexMcpRefreshed: boolean }> {
  try {
    await deps.restartCodex();
  } catch (err) {
    deps.logger?.warn('Codex MCP refresh deferred because the shared host could not restart', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { codexMcpRefreshed: false };
  }

  try {
    await deps.shutdownCodexEnvironment();
  } catch (err) {
    deps.logger?.warn('Codex MCP refresh deferred because the old bridge could not shut down', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { codexMcpRefreshed: false };
  }

  return { codexMcpRefreshed: true };
}
