import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { parseSharedTaskPeer } from '@cindy/device-link';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useAuth } from '@/auth/AuthContext';
import { markDeviceAccessRevoked } from './accessRevoked';
import { useDeviceLink } from './DeviceLinkContext';
import { useSharedTaskApi } from './useSharedTaskApi';
import { revokedDevicesStore } from './revokedDevicesStore';
import { watchSharedTaskAccess } from './sharedTaskAccessWatch';

/** Only the foreground guest task reconciles membership; other peers are untouched. */
export function useSharedTaskAccess(deviceId: string | undefined, sessionId: string, appActive: boolean) {
  const api = useSharedTaskApi();
  const { accountGeneration } = useAuth();
  const { status, sharedTaskAvailable, closeLink } = useDeviceLink();
  useFocusEffect(useCallback(() => {
    const peer = deviceId ? parseSharedTaskPeer(deviceId) : null;
    if (!appActive || status !== 'online' || sharedTaskAvailable !== true
        || !deviceId || peer?.role !== 'host' || revokedDevicesStore.has(deviceId)) return;
    const owner = getMobileAuthOwner();
    return watchSharedTaskAccess({
      sharedTaskId: peer.sharedTaskId, sessionId,
      read: () => api.get(peer.sharedTaskId),
      isCurrent: () => isMobileAuthOwnerCurrent(owner),
      onRevoked: () => {
        markDeviceAccessRevoked(deviceId);
        closeLink(deviceId);
      },
    });
  }, [accountGeneration, api, appActive, closeLink, deviceId, sessionId, sharedTaskAvailable, status]));
}
