import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperHistoryDeps } from './_history_types.js';

export type HistoryScopeResult =
  | { ok: true; sessionIds: string[] | null; deniedSessionIds: string[] }
  | { ok: false; errorCode: string; message: string };

export async function resolveHistoryScope(
  history: XdtHelperHistoryDeps,
  getSessionContext: (() => LiziMcpSessionContext | undefined) | undefined,
  requestedSessionIds: string[] | null,
): Promise<HistoryScopeResult> {
  if (!history.resolveSessionScope) {
    return { ok: true, sessionIds: requestedSessionIds, deniedSessionIds: [] };
  }
  const context = getSessionContext?.();
  const resolved = await history.resolveSessionScope({
    callerSessionId: context?.sessionId,
    callerMemoryScopeKey: context?.memoryScopeKey,
  });
  if (!resolved.ok) return resolved;
  if (resolved.sessionIds === null) {
    return { ok: true, sessionIds: requestedSessionIds, deniedSessionIds: [] };
  }
  const allowed = new Set(resolved.sessionIds);
  const uniqueRequested = requestedSessionIds === null
    ? null
    : [...new Set(requestedSessionIds)];
  return {
    ok: true,
    sessionIds:
      uniqueRequested === null
        ? [...allowed]
        : uniqueRequested.filter((sessionId) => allowed.has(sessionId)),
    deniedSessionIds: uniqueRequested === null
      ? []
      : uniqueRequested.filter((sessionId) => !allowed.has(sessionId)),
  };
}
