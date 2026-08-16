import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperHistoryDeps } from './_history_types.js';

export type HistoryScopeResult =
  | { ok: true; sessionIds: string[] | null }
  | { ok: false; errorCode: string; message: string };

export async function resolveHistoryScope(
  history: XdtHelperHistoryDeps,
  getSessionContext: (() => LiziMcpSessionContext | undefined) | undefined,
  requestedSessionIds: string[] | null,
): Promise<HistoryScopeResult> {
  if (!history.resolveSessionScope) return { ok: true, sessionIds: requestedSessionIds };
  const context = getSessionContext?.();
  const resolved = await history.resolveSessionScope({
    callerSessionId: context?.sessionId,
    callerMemoryScopeKey: context?.memoryScopeKey,
  });
  if (!resolved.ok) return resolved;
  if (resolved.sessionIds === null) return { ok: true, sessionIds: requestedSessionIds };
  const allowed = new Set(resolved.sessionIds);
  return {
    ok: true,
    sessionIds:
      requestedSessionIds === null
        ? [...allowed]
        : [...new Set(requestedSessionIds)].filter((sessionId) => allowed.has(sessionId)),
  };
}
