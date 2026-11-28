import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { useLocation, useParams } from 'react-router-dom';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { confirmSessionOrigin } from '@/features/device-link/confirmSessionOrigin';
import { SessionEntryError, sessionEntryFailure } from './SessionEntryError';

/** Restore a route's host before any nested metadata read or composer mounts. */
export function SessionRouteOriginGate({ sessionId, ownsWindowRoute, children }: {
  sessionId?: string;
  ownsWindowRoute: boolean;
  children: ReactNode;
}) {
  const { sessionId: routeSessionId } = useParams<{ sessionId: string }>();
  const { search } = useLocation();
  // An embedded task must never inherit the host of the surrounding route.
  const deviceId = ownsWindowRoute && sessionId === routeSessionId
    ? new URLSearchParams(search).get('device') : null;
  // Transport is still keyed by session id. If that id has a remote origin,
  // refuse to mount a local editor rather than send its reads or writes there.
  const localConflict = useSyncExternalStore(remoteProjectsStore.subscribe,
    () => deviceId === 'local' && !!getStickySessionDeviceId(sessionId));
  const key = deviceId && deviceId !== 'local' && sessionId ? JSON.stringify([sessionId, deviceId]) : null;
  const [registered, setRegistered] = useState<{ key: string; failure?: ReturnType<typeof sessionEntryFailure> } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!key || !sessionId || !deviceId) return;
    let disposed = false;
    const owner = getDataOwnerGeneration();
    const valid = () => !disposed && isDataOwnerGenerationCurrent(owner);
    void confirmSessionOrigin(sessionId, deviceId, valid).then(() => {
      if (valid()) setRegistered({ key });
    }).catch(error => { if (valid()) setRegistered({ key, failure: sessionEntryFailure(error) }); });
    return () => { disposed = true; };
  }, [key, sessionId, deviceId, retry]);

  if (localConflict) return <SessionEntryError reason="denied" />;
  if (key && registered?.key !== key) return null;
  if (key && registered?.failure) return <SessionEntryError reason={registered.failure} onRetry={() => setRetry(value => value + 1)} />;
  return children;
}
