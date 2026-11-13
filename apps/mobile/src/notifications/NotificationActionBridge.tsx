import { useEffect } from 'react';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { setNotificationActionTransport, type NotificationActionTransport } from './notificationActionRunner';

/**
 * Offers the signed-in device-link transport to notification buttons (renders nothing).
 * A button press is handled outside this tree and waits here for the connection layer.
 */
export function NotificationActionBridge() {
  const { invoke, holdBackgroundConnection } = useDeviceLink();
  useEffect(() => {
    const transport: NotificationActionTransport = {
      makerFor: (deviceId, preSend) => createMobileMakerTransport({
        deviceId,
        // Preserve the deadline through async message expansion, connection
        // recovery and invoke queue admission, right up to the actual send.
        invoke: (target, channel, args) => invoke(target, channel, args, { preSend }),
      }),
      holdConnection: () => holdBackgroundConnection?.() ?? (() => {}),
    };
    setNotificationActionTransport(transport);
    return () => setNotificationActionTransport(null);
  }, [invoke, holdBackgroundConnection]);
  return null;
}
