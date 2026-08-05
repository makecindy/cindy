import type { OrcaRole, Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import { orcaWorkflowsFor } from '@/lib/makerTransport';

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
 * Resolve the canonical chat route for a session before navigating from generic
 * entry points such as notifications, deep links, and sidebar clicks. Orca lead
 * sessions now use the plain Lead route; worker sessions route to their Lead
 * with a worker query hint so the right-sidebar collaboration tab can focus it.
 */
export async function resolveSessionRoute(
  sessionId: string,
  session?: Pick<Session, 'orcaRole'> | null,
): Promise<string> {
  const targetSession = session ?? (await sessionService.get(sessionId).catch(() => null));

  if (targetSession && isOrcaLeadSession(targetSession)) {
    return `/cc-agent/${sessionId}`;
  }

  if (targetSession && isOrcaWorkerSession(targetSession)) {
    const workflow = await orcaWorkflowsFor(sessionId)
      .getByWorkerSession(sessionId)
      .catch(() => null);
    return workflow ? `/cc-agent/${workflow.leadSessionId}?worker=${sessionId}` : '/cc-agent';
  }

  return `/cc-agent/${sessionId}`;
}
