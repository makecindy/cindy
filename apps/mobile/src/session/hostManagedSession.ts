import { useState } from 'react';
import type { RemoteSession } from '@/session/types';

/**
 * A Bot owns and may replace its canonical Session. Mobile may operate the
 * conversation and its permissions; identity, model and Session lifecycle stay with the host.
 */
export function isHostManagedSession(
  session: Pick<RemoteSession, 'source'> | null | undefined,
): boolean {
  return session?.source === 'bot';
}

/** Keep presentation stable while the same task's remote snapshot is unavailable. */
export function useHostManagedSession(
  scope: string,
  session: Pick<RemoteSession, 'source'> | null | undefined,
): boolean {
  const [observed, setObserved] = useState<{ scope: string; managed: boolean | null }>(
    () => ({ scope, managed: session ? isHostManagedSession(session) : null }),
  );
  const previous = observed.scope === scope ? observed.managed : null;
  // A Bot's ownership cannot turn into an ordinary task during a runtime refresh.
  const managed = previous === true ? true : session ? isHostManagedSession(session) : previous;
  if (observed.scope !== scope || observed.managed !== managed) {
    setObserved({ scope, managed });
  }
  // Before the first authoritative snapshot, do not flash task-only controls.
  return managed !== false;
}
