import { useSyncExternalStore } from 'react';

const revoked = new Set<string>();
const revocationTokens = new Map<string, object>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = new Set(revoked);
  for (const listener of listeners) listener();
}

/**
 * Controller-side mirror of targets that revoked this phone's access. The
 * host remains authoritative; a later successful open/subscribe/invoke clears
 * the marker.
 */
export const revokedDevicesStore = {
  markRevoked(deviceId: string): void {
    if (deviceId) revocationTokens.set(deviceId, {});
    if (!deviceId || revoked.has(deviceId)) return;
    revoked.add(deviceId);
    emit();
  },

  clearRevoked(deviceId: string): void {
    revocationTokens.delete(deviceId);
    if (!revoked.delete(deviceId)) return;
    emit();
  },

  clearAll(): void {
    revocationTokens.clear();
    if (revoked.size === 0) return;
    revoked.clear();
    emit();
  },

  has(deviceId: string): boolean {
    return revoked.has(deviceId);
  },

  getRevocationToken(deviceId: string): object | undefined {
    return revocationTokens.get(deviceId);
  },

  getSnapshot(): ReadonlySet<string> {
    return snapshot;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useRevokedDevices(): ReadonlySet<string> {
  return useSyncExternalStore(revokedDevicesStore.subscribe, revokedDevicesStore.getSnapshot);
}
