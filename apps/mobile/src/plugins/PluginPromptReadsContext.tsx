import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { createPluginPromptReads } from './pluginPromptReads';

const Context = createContext<ReturnType<typeof createPluginPromptReads> | null>(null);
export const usePluginPromptReads = () => useContext(Context);

/** One read owner across retained screens; never owns approval operations or starts polling. */
export function PluginPromptReadsProvider({ children }: { children: ReactNode }) {
  const { accountGeneration } = useAuth();
  const { invoke, connectionEpoch, presenceVersion, status, onRemoteResourceChanged, getSubscriptionIdentity } = useDeviceLink();
  const revoked = useRevokedDevices();
  const subscriptions = useRef(getSubscriptionIdentity); subscriptions.current = getSubscriptionIdentity;
  const current = useRef<ReturnType<typeof createPluginPromptReads> | null>(null);
  const online = useRef(status === 'online'); online.current = status === 'online';
  const reads = useMemo(() => {
    const next = createPluginPromptReads(invoke, () => current.current === next && online.current,
      deviceId => subscriptions.current?.(deviceId, ['sessions']) ?? null);
    return next;
  }, [invoke, accountGeneration]);
  current.current = reads;
  useLayoutEffect(() => reads.invalidate(), [reads, connectionEpoch, presenceVersion, status, revoked]);
  useEffect(() => {
    const app = AppState.addEventListener('change', state => { if (state === 'active') reads.invalidate(); });
    const off = onRemoteResourceChanged((deviceId, payload) => {
      if (payload.collectionId === 'plugins') reads.invalidate(deviceId, payload);
    });
    return () => { app.remove(); off(); reads.invalidate(); };
  }, [reads, onRemoteResourceChanged]);
  return <Context.Provider value={reads}>{children}</Context.Provider>;
}
