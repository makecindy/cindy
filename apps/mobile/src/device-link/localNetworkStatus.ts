import { useSyncExternalStore } from 'react';

export type LocalNetworkStatus = 'unknown' | 'available' | 'unavailable';
export type NetworkState = { type?: string; isConnected?: boolean; isInternetReachable?: boolean };

let snapshot: { status: LocalNetworkStatus; connectedType?: string } = { status: 'unknown' };
const listeners = new Set<() => void>();

/** Native network evidence only; a failed computer request cannot change this. */
export const localNetworkStore = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  update(network?: NetworkState) {
    // UNKNOWN may be a native lookup failure, including spurious false flags.
    const status: LocalNetworkStatus = !network?.type || network.type === 'UNKNOWN'
      ? 'unknown'
      : network.type === 'NONE' || network.isConnected === false || network.isInternetReachable === false
        ? 'unavailable'
        : network.isConnected === true ? 'available' : 'unknown';
    // A connected WIFI → CELLULAR transition interrupts old requests even when
    // both paths are available. Repeated capability hints keep the same snapshot.
    const connectedType = network?.isConnected === true && network.type !== 'UNKNOWN' && network.type !== 'NONE'
      ? network.type : undefined;
    if (status === snapshot.status && connectedType === snapshot.connectedType) return;
    snapshot = { status, connectedType };
    for (const listener of listeners) listener();
  },
};

export function useLocalNetworkStatus(): LocalNetworkStatus {
  return useSyncExternalStore(localNetworkStore.subscribe, localNetworkStore.getSnapshot).status;
}
