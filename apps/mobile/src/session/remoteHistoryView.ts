import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { isHistoryViewUnavailable } from '@cindy/maker-shared/message-window';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { getRemoteHistoryView, mountRemoteHistoryView } from './remoteHistoryViews';
export { findRemoteHistoryView } from './remoteHistoryViews';

export function useRemoteHistoryView(deviceId: string | null | undefined, sessionId: string, maker: MobileMakerTransport, isActive: () => boolean, networkAvailable = true) {
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  const entry = useMemo(() => getRemoteHistoryView(deviceId ?? '', sessionId, maker), [deviceId, sessionId, maker]);
  const view = entry.view;
  const snapshot = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot);
  const [cacheCheckedEntry, setCacheCheckedEntry] = useState<typeof entry | null>(null);
  useEffect(() => { view.setNetworkAvailable(networkAvailable); }, [view, networkAvailable]);
  useEffect(() => {
    if (!deviceId) return;
    let active = true;
    const cleanup = mountRemoteHistoryView(entry, maker, activeRef.current(), () => {
      if (active) setCacheCheckedEntry(entry);
    });
    return () => { active = false; cleanup(); };
  }, [deviceId, entry, maker]);
  const cacheRestoring = !!deviceId
    && !snapshot.ready
    && !isHistoryViewUnavailable(snapshot.error)
    && cacheCheckedEntry !== entry;
  return { view, snapshot, cacheRestoring };
}
