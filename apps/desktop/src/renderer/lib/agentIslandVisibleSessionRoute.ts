import { matchPath } from 'react-router-dom';
import type { BotProfile } from '@/features/bots/botStore';

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

export function resolveAgentIslandVisibleBotSessionIdFromPath(pathname: string, botProfiles: readonly BotProfile[]): string | null {
  const m = matchPath('/bots/:botId/(session|history)/:sessionId', pathname);
  if (m?.params.sessionId) return m.params.sessionId;
  const b = matchPath('/bots/:botId', pathname);
  return botProfiles.find(p => p.id === b?.params.botId)?.sessions.find(x => x.role === 'canonical')?.id ?? null;
}

/**
 * 通知/deep link 的目标路由还没渲染时，直接从完整 route target 解析首个可见
 * session payload。Orca worker query 表示 Lead 与 Worker 会同时可见。
 */
export function resolveAgentIslandVisibleSessionFromRouteTarget(
  target: string,
): string | string[] | null {
  const url = new URL(target, 'https://xdt-maker.invalid');
  const leadSessionId = resolveAgentIslandVisibleSessionIdFromPath(url.pathname);
  if (!leadSessionId) return null;
  const workerSessionId = url.searchParams.get('worker')?.trim();
  if (!workerSessionId || workerSessionId === 'new' || workerSessionId === leadSessionId) {
    return leadSessionId;
  }
  return [leadSessionId, workerSessionId];
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
