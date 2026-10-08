import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { toast } from '@/lib/toast';

/** Navigation only: authorization and credentials stay in the computer's own UI. */
export function PluginSetupRemoteDesktopButton({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation();
  const devices = useDeviceLinkDeviceList();
  const name = devices?.find((device) => device.deviceId === deviceId)?.name || deviceId;
  const [opening, setOpening] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  return (
    <Button
      variant="secondary"
      palette="confirmation"
      size="lg"
      compact
      type="button"
      loading={opening}
      disabled={opening}
      onClick={() => {
        setOpening(true);
        void window.electronAPI
          .openRemoteDesktop({ deviceId, name })
          .catch(() => toast.error(t('remoteDesktop.connectionError')))
          .finally(() => {
            if (mounted.current) setOpening(false);
          });
      }}
    >
      {t('remoteDesktop.shortcut.open')}
    </Button>
  );
}
