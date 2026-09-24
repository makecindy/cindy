import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderView } from '@cindy/model-providers';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

const EMPTY: ProviderView[] = [];
export function useSshCodexProviders(hostId?: string | null) {
  const owner = getDataOwnerGeneration();
  const key = JSON.stringify([hostId, owner.dataOwnerId, owner.generation]);
  const sequence = useRef(0);
  const [state, setState] = useState<{ key: string; providers: ProviderView[]; status: 'loading' | 'error' | 'ready' }>({
    key: '', providers: EMPTY, status: 'loading',
  });
  const refresh = useCallback(async () => {
    if (!hostId) return false;
    const request = ++sequence.current;
    const requestOwner = getDataOwnerGeneration();
    setState({ key, providers: EMPTY, status: 'loading' });
    return window.electronAPI.remoteSsh.listCodexModels(hostId).then((providers) => {
      if (sequence.current === request && isDataOwnerGenerationCurrent(requestOwner)) {
        setState({ key, providers, status: 'ready' });
      }
      return true;
    }).catch(() => {
      if (sequence.current === request && isDataOwnerGenerationCurrent(requestOwner)) {
        setState({ key, providers: EMPTY, status: 'error' });
      }
      return false;
    });
  }, [hostId, key]);
  useEffect(() => {
    if (!hostId) return;
    const initialRefresh = refresh();
    const initialRequest = sequence.current;
    let disposed = false;
    // The push subscription does not replay the current connection state.
    // The first ready may finish a connection already in progress on mount.
    let wasReady: boolean | null = null;
    const stop = window.electronAPI.remoteSsh.onStatusChanged((snapshot) => {
      if (snapshot.config.id !== hostId) return;
      if (snapshot.status === 'ready') {
        if (wasReady === null) {
          void initialRefresh.then((success) => {
            if (!success && !disposed && wasReady && sequence.current === initialRequest) void refresh();
          });
        } else if (!wasReady) void refresh();
        wasReady = true;
      }
      else {
        wasReady = false;
        ++sequence.current;
        setState({ key, providers: EMPTY, status: 'error' });
      }
    });
    return () => { disposed = true; ++sequence.current; stop(); };
  }, [hostId, key, refresh]);
  const retry = useCallback(() => { void refresh(); }, [refresh]);
  return {
    providers: state.key === key ? state.providers : EMPTY,
    status: state.key === key ? state.status : 'loading' as const,
    refresh: retry,
  };
}
