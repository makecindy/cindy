/**
 * Per-session authentication for Pi requests entering the shared loopback
 * Anthropic compatibility proxy.
 *
 * A business session id is routing metadata, not a credential. Pi receives a
 * separate random token through its child-process environment; only the exact
 * active `(sessionId, token)` pair may select host-managed provider secrets.
 */

import { timingSafeEqual } from 'node:crypto';

const activeTokens = new Map<string, string>();

export function registerPiProxySession(sessionId: string, token: string): () => void {
  if (!sessionId || !token) throw new Error('Pi proxy session registration requires an id and token');
  activeTokens.set(sessionId, token);
  return () => {
    if (activeTokens.get(sessionId) === token) activeTokens.delete(sessionId);
  };
}

export function authenticatePiProxySession(sessionId: string, candidate: string | null): boolean {
  const expected = activeTokens.get(sessionId);
  if (!expected || !candidate) return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.length === candidateBytes.length
    && timingSafeEqual(expectedBytes, candidateBytes);
}

/** Test isolation only. */
export function resetPiProxySessionsForTest(): void {
  activeTokens.clear();
}
