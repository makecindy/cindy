import type { DeviceLinkConnectionStatus, Session } from '@/lib/ccAgent.types';

interface DeviceLinkWriteState {
  deviceLinkDeviceId?: string | null;
  deviceLinkConnectionStatus?: DeviceLinkConnectionStatus | null;
}

/**
 * Device-link entities stay selectable while cached offline or still unverified
 * (`connecting`: cold-start cache seed / relay reconnect), but writes must wait for a
 * confirmed connection.
 */
export function isDeviceLinkWriteBlocked(
  target: DeviceLinkWriteState | null | undefined,
): boolean {
  const status = target?.deviceLinkConnectionStatus;
  return Boolean(
    target?.deviceLinkDeviceId &&
      (status === 'disconnected' || status === 'connecting'),
  );
}

/** Device-link sessions stay selectable while cached offline, but writes must wait for reconnection. */
export function isRemoteSessionWriteBlocked(
  session: Pick<Session, 'deviceLinkDeviceId' | 'deviceLinkConnectionStatus'> | null | undefined,
): boolean {
  return isDeviceLinkWriteBlocked(session);
}
