import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { getSessionFor } from '@/lib/makerTransport';
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
  const key = deviceId && sessionId ? JSON.stringify([sessionId, deviceId]) : null;
  const [registered, setRegistered] = useState<{ key: string; failure?: ReturnType<typeof sessionEntryFailure> } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!key || !sessionId || !deviceId) return;
    let disposed = false;
    const owner = getDataOwnerGeneration();
    const valid = () => !disposed && isDataOwnerGenerationCurrent(owner);
    const existing = remoteProjectsStore.getSessionDeviceId(sessionId);
    if (existing && existing !== deviceId) {
      setRegistered({ key, failure: 'denied' });
      return;
    }
    // This is only a routing hint. The existing Main invoke boundary still
    // authorizes the device and session; a URL cannot grant remote access.
    remoteProjectsStore.pinSessionOrigin(deviceId, sessionId);
    void (async () => {
      if (!remoteProjectsStore.getDeviceSessions(deviceId).some(row => row.id === sessionId)) {
        // Hidden branches never arrive in the ordinary task listing. Recover
        // their metadata explicitly when the asynchronous disk cache is empty.
        const current = remoteProjectsStore.captureSessionRead(deviceId, sessionId);
        const value = await getSessionFor(sessionId);
        if (!valid()) return;
        if (!value || value.id !== sessionId) { setRegistered({ key, failure: 'missing' }); return; }
        if (current()) {
          remoteProjectsStore.mergeDeviceSessions(deviceId, remoteProjectsStore.getDeviceName(deviceId) ?? '',
            [current.mergeActivity(value)]);
        } else if (!remoteProjectsStore.getDeviceSessions(deviceId).some(row => row.id === sessionId)) {
          throw new Error('Remote task read invalidated');
        }
      }
      if (valid()) setRegistered({ key });
    })().catch(error => { if (valid()) setRegistered({ key, failure: sessionEntryFailure(error) }); });
    return () => { disposed = true; };
  }, [key, sessionId, deviceId, retry]);

  if (key && registered?.key !== key) return null;
  if (key && registered?.failure) return <SessionEntryError reason={registered.failure} onRetry={() => setRetry(value => value + 1)} />;
  return children;
}
