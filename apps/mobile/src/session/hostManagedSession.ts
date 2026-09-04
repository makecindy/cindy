import type { RemoteSession } from '@/session/types';

/**
 * A Bot owns and may replace its canonical Session. Mobile may operate the
 * conversation, but Session-container and runtime policy stay with the host.
 */
export function isHostManagedSession(
  session: Pick<RemoteSession, 'source'> | null | undefined,
): boolean {
  return session?.source === 'bot';
}
