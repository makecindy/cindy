/**
 * Per-session authentication for Pi requests entering the shared loopback
 * Anthropic compatibility proxy.
 *
 * A business session id is routing metadata, not a credential. Pi receives a
 * separate random token through its child-process environment; only the exact
 * active `(sessionId, token)` pair may select host-managed provider secrets.
 */

import { timingSafeEqual } from 'node:crypto';

interface PiProxySessionRegistration {
  token: string;
}

const activeRegistrations = new Map<string, PiProxySessionRegistration>();

export function registerPiProxySession(sessionId: string, token: string): () => void {
  if (!sessionId || !token) throw new Error('Pi proxy session registration requires an id and token');
  const registration = { token };
  activeRegistrations.set(sessionId, registration);
  return () => {
    if (activeRegistrations.get(sessionId) === registration) {
      activeRegistrations.delete(sessionId);
    }
  };
}

export function authenticatePiProxySession(sessionId: string, candidate: string | null): boolean {
  const expected = activeRegistrations.get(sessionId)?.token;
  if (!expected || !candidate) return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.length === candidateBytes.length
    && timingSafeEqual(expectedBytes, candidateBytes);
}

/** Test isolation only. */
export function resetPiProxySessionsForTest(): void {
  activeRegistrations.clear();
}
