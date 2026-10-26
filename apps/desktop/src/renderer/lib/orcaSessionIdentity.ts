import type { OrcaRole, Session } from '@/lib/ccAgent.types';
import { getSessionFor, orcaWorkflowsFor } from '@/lib/makerTransport';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { botRouteForOwnedSession, readLoadedBotProfiles } from '@/features/bots/botSessionOwners';

export function isOrcaLeadSession(session: { orcaRole?: OrcaRole | null }): boolean {
  return session.orcaRole === 'lead';
}

export function isOrcaWorkerSession(session: { orcaRole?: OrcaRole | null }): boolean {
  return session.orcaRole === 'worker';
}

export function formatOrcaLeadTitle(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  return t || 'Orca Session';
}

export function formatOrcaWorkerTitle(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  return t ? `Orca Worker: ${t}` : 'Orca Worker: Ready';
}

/** Extract the session that owns the canonical `/cc-agent/:sessionId` route. */
export function getSessionRouteOwnerId(route: string): string | null {
  const match = /^\/cc-agent\/([^/?#]+)(?:[?#]|$)/.exec(route);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * The companion entry for its main chat, or the ordinary page for other tasks, read from
 * the in-memory profile projection only: no IPC and no module load on a click. A
 * background task stays on its ordinary `/cc-agent/:id` route; an unloaded projection
 * falls back to the ordinary route too (the notification entry reloads it first).
 */
function loadedBotChatRoute(sessionId: string): string | null {
  const profiles = readLoadedBotProfiles();
  if (!profiles) return null;
  const route = botRouteForOwnedSession(profiles, sessionId)?.route;
  return route && !route.startsWith('/cc-agent/') ? route : null;
}

/**
 * Resolve the canonical chat route for a session before navigating from generic
 * entry points such as notifications, deep links, and sidebar clicks. Orca lead
 * sessions now use the plain Lead route; worker sessions route to their Lead
 * with a worker query hint so the right-sidebar collaboration tab can focus it.
 */
export async function resolveSessionRoute(
  sessionId: string,
  session?: Pick<Session, 'orcaRole'> & Partial<Pick<Session, 'source'>> | null,
  options?: { remote?: boolean },
): Promise<string> {
  const targetSession = session ?? (await getSessionFor(sessionId).catch(() => null));
  if (!CINDY_MAKE_ENABLED && isCindyMakeSource(targetSession?.source)) return '/cc-agent';

  if (targetSession && isOrcaLeadSession(targetSession)) {
    return `/cc-agent/${sessionId}`;
  }

  if (targetSession && isOrcaWorkerSession(targetSession)) {
    const workflow = await orcaWorkflowsFor(sessionId)
      .getByWorkerSession(sessionId)
      .catch(() => null);
    return workflow ? `/cc-agent/${workflow.leadSessionId}?worker=${sessionId}` : '/cc-agent';
  }

  // Notifications, task cards and the main sidebar agree on one page per task.
  const botRoute = options?.remote ? null : loadedBotChatRoute(sessionId);
  if (botRoute) return botRoute;

  return `/cc-agent/${sessionId}`;
}

/** Open the exact task with the ordinary UI, without resolving its parent or companion. */
export function standardSessionRoute(sessionId: string, deviceId?: string | null): string {
  return `/cc-agent/${encodeURIComponent(sessionId)}${deviceId ? `?device=${encodeURIComponent(deviceId)}` : ''}`;
}
