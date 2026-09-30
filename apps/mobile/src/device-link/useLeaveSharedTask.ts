import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { parseSharedTaskPeer } from '@cindy/device-link';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useSharedTaskConfirmation } from '@/session/useSharedTaskConfirmation';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { useDeviceLink } from './DeviceLinkContext';
import { useSharedTaskApi } from './useSharedTaskApi';
import { sharedTaskErrorKey } from './sharedTaskCompatibility';
import { markDeviceAccessRevoked } from './accessRevoked';
import { revokedDevicesStore } from './revokedDevicesStore';

/** Exit directly from task details; cancelling never navigates or reloads the task. */
export function useLeaveSharedTask({ deviceId, enabled, onLeft, onError }: {
  deviceId?: string; enabled: boolean; onLeft(): void; onError(message: string): void;
}) {
  const { t } = useTranslation();
  const api = useSharedTaskApi();
  const confirmation = useSharedTaskConfirmation();
  const { closeLink } = useDeviceLink();
  const pending = useRef<object | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    pending.current = null; setBusy(false);
    return () => { pending.current = null; };
  }, [deviceId, enabled]);
  useFocusEffect(useCallback(() => {
    setBusy(false);
    return () => { pending.current = null; };
  }, []));
  const leave = async () => {
    const peer = deviceId ? parseSharedTaskPeer(deviceId) : null;
    if (!enabled || !deviceId || peer?.role !== 'host' || pending.current || revokedDevicesStore.has(deviceId)) return;
    const owner = getMobileAuthOwner();
    const request = {};
    pending.current = request;
    const current = () => pending.current === request && isMobileAuthOwnerCurrent(owner);
    try {
      const accepted = await confirmation.confirm({
        title: t('sharedTask.leaveTitle'), message: t('sharedTask.leaveBody'),
        cancelLabel: t('sharedTask.leaveKeep'), confirmLabel: t('sharedTask.leave'),
        destructive: true, cancelable: true,
      });
      if (!accepted || !current() || revokedDevicesStore.has(deviceId)) return;
      setBusy(true);
      await api.leave(peer.sharedTaskId);
      if (!current()) return;
      markDeviceAccessRevoked(deviceId);
      closeLink(deviceId);
      remoteSessionStore.removeDevice(deviceId);
      onLeft();
    } catch (error) {
      if (current()) onError(t(sharedTaskErrorKey(error)));
    } finally {
      if (pending.current === request) { pending.current = null; setBusy(false); }
    }
  };
  return { leave, busy, dialog: confirmation.dialog };
}
