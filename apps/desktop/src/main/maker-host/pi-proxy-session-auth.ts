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
}

const activeSessions = new Map<string, ActivePiProxySession>();

export function registerPiProxySession(
  sessionId: string,
  token: string,
  resolveProviderId: () => string | null = () => null,
): () => void {
  if (!sessionId || !token)
    throw new Error('Pi proxy session registration requires an id and token');
  const registration = { token, resolveProviderId };
  activeSessions.set(sessionId, registration);
  return () => {
    if (activeSessions.get(sessionId) === registration) {
      activeSessions.delete(sessionId);
    }
  };
}

export function authenticatePiProxySession(sessionId: string, candidate: string | null): boolean {
  const expected = activeSessions.get(sessionId)?.token;
  if (!expected || !candidate) return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return (
    expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes)
  );
}

/**
 * Host-resolved provider bound to the authenticated Pi process. Callers must
 * authenticate the same session immediately before reading this value.
 */
export function getPiProxySessionProvider(sessionId: string): string | null {
  return activeSessions.get(sessionId)?.resolveProviderId() ?? null;
}

/** Test isolation only. */
export function resetPiProxySessionsForTest(): void {
  activeSessions.clear();
}
