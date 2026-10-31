import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Check, ChevronDown, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc';

export function eligiblePluginDevices(
  devices: readonly DeviceLinkDeviceView[],
  revoked: ReadonlySet<string>,
) {
  return devices.filter(
    (d) =>
      !d.isSelf &&
      d.controlEnabled &&
      d.remoteControlEnabled &&
      !revoked.has(d.deviceId) &&
      d.platform !== 'ios' &&
      d.platform !== 'android',
  );
}
/** Presence is independent of where the page-heading picker is mounted. */
export function usePluginDeviceDirectory(selected: { deviceId: string; name: string } | null) {
  const devices = useDeviceLinkDeviceList();
  const revoked = useSyncExternalStore(
    revokedDevicesStore.subscribe,
    revokedDevicesStore.getSnapshot,
  );
  const [relayOnline, setRelayOnline] = useState(false);
  useEffect(() => {
    let disposed = false,
      revision = 0;
    const off = window.electronAPI.deviceLink.onStatusChanged((state) => {
      revision++;
      setRelayOnline(state.status === 'online');
    });
    const start = revision;
    void window.electronAPI.deviceLink
      .getState()
      .then((state) => {
        if (!disposed && revision === start) setRelayOnline(state.linkStatus === 'online');
      })
      .catch(() => {});
    return () => {
      disposed = true;
      off();
    };
  }, []);
  const candidates = eligiblePluginDevices(devices ?? [], revoked);
  const target = candidates.find((d) => d.deviceId === selected?.deviceId);
  const online = !!target?.online && relayOnline;
  return { candidates, target, online: !selected || online, relayOnline };
}

export type CatalogDeviceControl = {
  selected: { deviceId: string; name: string } | null;
  onSelect(device: { deviceId: string; name: string } | null): void;
  directory: ReturnType<typeof usePluginDeviceDirectory>;
};

/** One host menu owns its optional project submenu. Presence never rewrites the selection. */
export function PluginDevicePicker({
  selected,
  onSelect,
  directory: { candidates, target, online, relayOnline },
  projectMenu,
  projectLabel,
  disabled,
}: CatalogDeviceControl & { projectMenu?: ReactNode; projectLabel?: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const computerName = selected
    ? (target?.name ?? selected.name)
    : t('settings.ghosts.remote.thisComputer');
  const label = projectMenu
    ? `${computerName} / ${projectLabel ?? t('settings.ghosts.scopePicker.globalScope')}`
    : computerName;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          disabled={disabled}
          variant="secondary"
          size="lg"
          compact
          pressFeedback={false}
          className="min-w-[200px] max-w-[280px] justify-start [&>svg]:shrink-0"
          aria-label={t('settings.ghosts.remote.device')}
          title={label}
        >
          <Monitor size={14} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          {selected && !online ? (
            <span className="text-[var(--text-tertiary)]">
              {t('settings.ghosts.remote.offline')}
            </span>
          ) : null}
          <ChevronDown size={13} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[var(--radix-dropdown-menu-trigger-width)] max-w-[calc(100vw-32px)]"
      >
        <DropdownMenuLabel>{t('settings.ghosts.scopePicker.computers')}</DropdownMenuLabel>
        <DropdownMenuItem className="gap-2" onSelect={() => onSelect(null)}>
          <Monitor size={14} />
          <span className="flex-1">{t('settings.ghosts.remote.thisComputer')}</span>
          {!selected ? <Check size={14} /> : null}
        </DropdownMenuItem>
        {candidates.map((device) => (
          <DropdownMenuItem
            key={device.deviceId}
            className="gap-2"
            title={device.name}
            onSelect={() => onSelect({ deviceId: device.deviceId, name: device.name })}
          >
            <Monitor size={14} />
            <span className="min-w-0 flex-1 truncate">{device.name}</span>
            {!device.online || !relayOnline ? (
              <span className="text-12 text-[var(--text-tertiary)]">
                {t('settings.ghosts.remote.offline')}
              </span>
            ) : null}
            {selected?.deviceId === device.deviceId ? <Check size={14} /> : null}
          </DropdownMenuItem>
        ))}
        {projectMenu ? (
          <>
            <DropdownMenuSeparator />
            {projectMenu}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
