import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { getSessionFor } from '@/lib/makerTransport';

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
  const [registered, setRegistered] = useState<{ key: string; unavailable: boolean } | null>(null);
  useEffect(() => {
    if (!key || !sessionId || !deviceId) return;
    let disposed = false;
    const owner = getDataOwnerGeneration();
    const valid = () => !disposed && isDataOwnerGenerationCurrent(owner);
    const existing = remoteProjectsStore.getSessionDeviceId(sessionId);
    if (existing && existing !== deviceId) {
      setRegistered({ key, unavailable: true });
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
        if (!value || value.id !== sessionId) throw new Error('Remote task not found');
        if (current()) {
          remoteProjectsStore.mergeDeviceSessions(deviceId, remoteProjectsStore.getDeviceName(deviceId) ?? '',
            [current.mergeActivity(value)]);
        } else if (!remoteProjectsStore.getDeviceSessions(deviceId).some(row => row.id === sessionId)) {
          throw new Error('Remote task read invalidated');
        }
      }
      if (valid()) setRegistered({ key, unavailable: false });
    })().catch(() => { if (valid()) setRegistered({ key, unavailable: true }); });
    return () => { disposed = true; };
  }, [key, sessionId, deviceId]);

  if (key && registered?.key !== key) return null;
  if (key && registered?.unavailable) return <Navigate to="/cc-agent" replace />;
  return children;
}
