import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { appLabel, platformLabel, relativeTime } from '@/components/settings/deviceLabels';
import { Tooltip } from '@/components/ui/tooltip';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';
import { DeviceCardHeading } from '@/features/remote-connection-v2/DeviceCardHeading';
import { derivePeerNode } from '@/features/remote-connection-v2/topologyModel';
import {
  formatRtt,
  pathLabel,
  peerTransportLabel,
  protocolLabel,
} from '@/features/remote-connection-v2/topologyPresentation';
import { usePeerLinks } from '@/features/remote-connection-v2/usePeerLinks';
import type { DeviceLinkConnectionStatus } from '@/lib/ccAgent.types';
import { deviceDisplayName } from '@/lib/deviceName';
import { RemoteProjectIcon } from './sidebar/RemoteProjectIcon';

const sessionStatusLabels = {
  connected: 'settings.devices.linkStatus.online',
  connecting: 'settings.devices.linkStatus.connecting',
  disconnected: 'settings.devices.linkStatus.stopped',
} as const;

export function SessionDeviceIndicator({
  deviceId,
  fallbackName,
  connectionStatus,
}: {
  deviceId: string;
  fallbackName?: string;
  connectionStatus?: DeviceLinkConnectionStatus;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const devices = useDeviceLinkDeviceList();
  const device = devices?.find((peer) => peer.deviceId === deviceId);
  const snapshot = usePeerLinks(open);
  const unresponsive = useSyncExternalStore(
    unresponsiveDevicesStore.subscribe,
    unresponsiveDevicesStore.getSnapshot,
  );
  const node =
    device && snapshot.takenAt
      ? derivePeerNode(
          device,
          snapshot.links.find((link) => link.deviceId === deviceId),
          snapshot.agentNetRoutes?.find((route) => route.deviceId === deviceId),
          false,
          unresponsive.has(deviceId),
        )
      : null;
  const directoryName = device?.name.trim();
  const name = deviceDisplayName(
    deviceId,
    directoryName && directoryName !== deviceId ? directoryName : fallbackName,
    devices ?? [],
  );
  const hardware = [
    device?.deviceInfo?.modelLabel,
    device?.platform && platformLabel(device.platform),
    device?.appVersion && `${appLabel(device.app, t)} ${device.appVersion}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const live = node?.status === 'direct' || node?.status === 'relay';
  const status = node
    ? live
      ? t('settings.devices.status.online')
      : pathLabel(node, '', t)
    : connectionStatus && t(sessionStatusLabels[connectionStatus]);
  const rows: [string, string | false | null | undefined][] = [
    [t('settings.remoteControl.v2.popover.status'), status],
    [
      t('settings.remoteControl.v2.popover.path'),
      live && t(`settings.remoteControl.v2.group.${node.path}`),
    ],
    [
      t('settings.remoteControl.v2.popover.protocol'),
      live && [protocolLabel(node, t), peerTransportLabel(node, t)].filter(Boolean).join(' · '),
    ],
    [
      t('settings.remoteControl.v2.popover.latency'),
      live && node.rttMs !== null && formatRtt(node.rttMs, t),
    ],
    [
      t('settings.remoteControl.v2.popover.lastSeen'),
      node?.status === 'offline' && node.lastSeenAt && relativeTime(node.lastSeenAt, t),
    ],
  ];

  return (
    <Tooltip.Provider>
      <Tooltip.Root open={open} onOpenChange={setOpen}>
        <Tooltip.Trigger asChild>
          <span
            role="img"
            tabIndex={0}
            aria-label={name}
            style={WINDOW_NO_DRAG_STYLE}
            className="mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-[var(--cmd-palette-item-meta)]"
          >
            <span aria-hidden className="pointer-events-none inline-flex">
              <RemoteProjectIcon kind="device-link" connectionStatus={connectionStatus} />
            </span>
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content
          side="bottom"
          align="start"
          className="w-72 break-normal max-w-[calc(100vw-1rem)] border-[var(--border-default)] bg-[var(--surface)] p-3 text-[var(--text-primary)]"
        >
          <DeviceCardHeading
            name={name}
            sub={hardware}
            platform={device?.platform ?? null}
            isMobile={isMobilePlatform(device?.platform)}
          />
          {rows.some(([, value]) => value) && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-[var(--border-default)] pt-2 text-12">
              {rows.map(
                ([label, value]) =>
                  value && (
                    <div className="contents" key={label}>
                      <dt className="text-[var(--text-secondary)]">{label}</dt>
                      <dd className="break-words text-right tabular-nums">{value}</dd>
                    </div>
                  ),
              )}
            </dl>
          )}
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
