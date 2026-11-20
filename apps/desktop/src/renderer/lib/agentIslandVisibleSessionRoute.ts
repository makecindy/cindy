import { companionChatTarget } from '@/features/bots/companionChatTarget';
import { matchPath } from 'react-router-dom';

const NON_SESSION_CC_AGENT_SEGMENTS = new Set([
  'boot',
  'files',
  'new',
  'new-dialogue',
  'scheduled',
]);

/**
 * Maps the current renderer route to the session that is actually visible in this window.
 */
export function resolveAgentIslandVisibleSessionIdFromPath(
  pathname: string,
): string | null {
  const sessionMatch = matchPath('/cc-agent/:sessionId', pathname);
  const sessionId = sessionMatch?.params.sessionId;
  if (!sessionId || NON_SESSION_CC_AGENT_SEGMENTS.has(sessionId)) return null;
  return sessionId;
}

export function isAgentIslandVisibleSessionOwnedByBotRoute(pathname: string): boolean {
  const sessionMatch = matchPath('/bots/:botId/session/:sessionId', pathname) ??
    matchPath('/bots/:botId/history/:sessionId', pathname) ??
    matchPath('/bots/remote/:deviceId/:botId/session/:sessionId', pathname) ??
    matchPath('/bots/remote/:deviceId/:botId', pathname);
  // The matching view must validate ownership before reporting a visible session.
  return Boolean(sessionMatch);
}

export function resolveAgentIslandVisibleSessionsFromPath(
  pathname: string,
  splitSessionIds: readonly string[],
): string | string[] | null {
  const sessionId = resolveAgentIslandVisibleSessionIdFromPath(pathname);
  // Companion routes now keep the same split tree mounted. This list already
  // excludes companion paths, so report even a single ordinary task beside one.
  if (companionChatTarget(pathname) && splitSessionIds.length > 0) {
    return [...new Set(splitSessionIds)];
  }
  // Other feature pages retain the saved tree without showing it.
  if (sessionId && splitSessionIds.length >= 2) {
    return [...new Set([sessionId, ...splitSessionIds])];
  }
  return sessionId;
}

export function resolveAgentIslandVisibleSessionIdForWorkdirBrowseRail({
  sessionId,
  railCollapsed,
  isOrcaLead,
}: {
  sessionId: string | null | undefined;
  railCollapsed: boolean;
  isOrcaLead: boolean;
}): string | null {
  if (railCollapsed || isOrcaLead) return null;
  const normalizedSessionId = sessionId?.trim();
  return normalizedSessionId || null;
}

export function isAgentIslandVisibleSessionOwnedByWorkdirBrowseRoute(pathname: string): boolean {
  const filesMatch = matchPath('/cc-agent/files/:sessionId', pathname);
  return Boolean(filesMatch?.params.sessionId);
}
