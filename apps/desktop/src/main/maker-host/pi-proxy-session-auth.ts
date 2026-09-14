/**
 * Per-session authentication for Pi requests entering the shared loopback
 * Anthropic compatibility proxy.
 *
 * A business session id is routing metadata, not a credential. Pi receives a
 * separate random token through its child-process environment; only the exact
 * active `(sessionId, token)` pair may select host-managed provider secrets.
 */

import { timingSafeEqual } from 'node:crypto';

interface ActivePiProxySession {
  token: string;
  resolveProviderId: () => string | null;
  scope: 'session' | 'subagent-route';
}

const activeSessions = new Map<string, Map<string, ActivePiProxySession>>();

function findPiProxySession(
  sessionId: string,
  candidate: string | null,
): ActivePiProxySession | null {
  if (!candidate) return null;
  const registrations = activeSessions.get(sessionId);
  if (!registrations) return null;
  const candidateBytes = Buffer.from(candidate);
  for (const registration of registrations.values()) {
    const expectedBytes = Buffer.from(registration.token);
    if (
      expectedBytes.length === candidateBytes.length
      && timingSafeEqual(expectedBytes, candidateBytes)
    ) return registration;
  }
  return null;
}

export function registerPiProxySession(
  sessionId: string,
  token: string,
  resolveProviderId: () => string | null = () => null,
  options: { scope?: 'session' | 'subagent-route' } = {},
): () => void {
  if (!sessionId || !token)
    throw new Error('Pi proxy session registration requires an id and token');
  const registration = {
    token,
    resolveProviderId,
    scope: options.scope === 'subagent-route' ? 'subagent-route' as const : 'session' as const,
  };
  const registrations = activeSessions.get(sessionId) ?? new Map();
  registrations.set(token, registration);
  activeSessions.set(sessionId, registrations);
  return () => {
    const current = activeSessions.get(sessionId);
    if (current?.get(token) !== registration) return;
    current.delete(token);
    if (current.size === 0) activeSessions.delete(sessionId);
  };
}

export function authenticatePiProxySession(sessionId: string, candidate: string | null): boolean {
  return findPiProxySession(sessionId, candidate) !== null;
}

/**
 * Host-resolved provider bound to the authenticated Pi process. Callers must
 * authenticate the same session immediately before reading this value.
 */
export function getPiProxySessionProvider(
  sessionId: string,
  candidate: string | null,
): string | null {
  return findPiProxySession(sessionId, candidate)?.resolveProviderId() ?? null;
}

export function isPiProxySubagentRoute(
  sessionId: string,
  candidate: string | null,
): boolean {
  return findPiProxySession(sessionId, candidate)?.scope === 'subagent-route';
}

/** Test isolation only. */
export function resetPiProxySessionsForTest(): void {
  activeSessions.clear();
}
