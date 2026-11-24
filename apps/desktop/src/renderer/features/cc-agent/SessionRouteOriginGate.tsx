import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { getDataOwnerGeneration, subscribeDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { resolveSessionNavigationRoute, restoreSessionNavigationOrigin } from '@/lib/sessionNavigationTarget';
import { standardSessionRoute } from '@/lib/orcaSessionIdentity';
import { SessionEntryError, sessionEntryFailure } from './SessionEntryError';

/** Restore a route's host before any nested metadata read or composer mounts. */
export function SessionRouteOriginGate({ sessionId, ownsWindowRoute, localSession, children }: {
  sessionId?: string;
  ownsWindowRoute: boolean;
  localSession?: boolean;
  children: ReactNode;
}) {
  const { sessionId: routeSessionId } = useParams<{ sessionId: string }>();
  const { search, state } = useLocation();
  const navigate = useNavigate();
  // An embedded task must never inherit the host of the surrounding route.
  const routeDevice = ownsWindowRoute && sessionId === routeSessionId
    ? new URLSearchParams(search).get('device') : null;
  const owner = useSyncExternalStore(subscribeDataOwnerGeneration, getDataOwnerGeneration);
  const embeddedLocalConflict = useSyncExternalStore(remoteProjectsStore.subscribe,
    () => Boolean(localSession && getStickySessionDeviceId(sessionId)));
  const deviceId = routeDevice ?? (embeddedLocalConflict ? 'local' : null);
  const key = deviceId && sessionId
    ? JSON.stringify([owner.dataOwnerId, owner.generation, sessionId, deviceId]) : null;
  const [registered, setRegistered] = useState<{ key: string; failure?: ReturnType<typeof sessionEntryFailure> } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!key || !sessionId || !deviceId) return;
    let disposed = false;
    const isCurrent = () => !disposed && owner === getDataOwnerGeneration();
    const target = { sessionId, deviceHint: deviceId, isCurrent };
    void (async () => {
      if (!routeDevice) {
        if (await restoreSessionNavigationOrigin(target) && isCurrent()) setRegistered({ key });
        return;
      }
      const route = await resolveSessionNavigationRoute(target, { exactTask: true });
      if (!route || !isCurrent()) return;
      if (route === '/cc-agent') throw new Error('The task route is unavailable');
      if (route === standardSessionRoute(sessionId)) {
        setRegistered({ key });
        return;
      }
      const leadRoute = new URL(route, 'https://cindy.invalid');
      const params = new URLSearchParams(search);
      for (const [name, value] of leadRoute.searchParams) params.set(name, value);
      navigate(`${leadRoute.pathname}?${params}`, { replace: true, state });
    })().catch((error) => { if (isCurrent()) setRegistered({ key, failure: sessionEntryFailure(error) }); });
    return () => { disposed = true; };
  }, [key, sessionId, deviceId, owner, retry, routeDevice, navigate, search, state]);

  if (key && registered?.key !== key) return null;
  if (key && registered?.failure) return <SessionEntryError reason={registered.failure} onRetry={() => setRetry(value => value + 1)} />;
  return children;
}
