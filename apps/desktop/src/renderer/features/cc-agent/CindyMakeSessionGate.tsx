import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { getSessionFor } from '@/lib/makerTransport';
import { sessionsStore } from '@/lib/sessionsStore';

/** Resolve old links before mounting a chat composer or file browser. */
export function CindyMakeSessionGate({ sessionId, children }: {
  sessionId?: string;
  children: ReactNode;
}) {
  const remoteSource = useSyncExternalStore(remoteProjectsStore.subscribe, () =>
    remoteProjectsStore.getMergedRemoteSessions().find(session => session.id === sessionId)?.source,
  );
  const localSource = useSyncExternalStore(sessionsStore.subscribe, () =>
    sessionId ? sessionsStore.findById(sessionId)?.source : undefined,
  );
  const knownSource = remoteSource ?? localSource;
  const [loaded, setLoaded] = useState<{ id: string; source: string | null } | null>(null);
  useEffect(() => {
    if (CINDY_MAKE_ENABLED || !sessionId || knownSource !== undefined) return;
    let cancelled = false;
    void getSessionFor(sessionId).then(session => {
      if (!cancelled && session?.id === sessionId) {
        setLoaded({ id: session.id, source: session.source ?? null });
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [sessionId, knownSource]);

  const source = knownSource ?? (loaded && loaded.id === sessionId ? loaded.source : undefined);
  if (!CINDY_MAKE_ENABLED && isCindyMakeSource(source)) {
    return <Navigate to="/cc-agent" replace />;
  }
  if (!CINDY_MAKE_ENABLED && sessionId && source === undefined) return null;
  return children;
}
