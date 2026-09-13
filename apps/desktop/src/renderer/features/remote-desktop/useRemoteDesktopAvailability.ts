import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { REMOTE_DESKTOP_CHANNEL, type RemoteDesktopCapabilities } from '@cindy/device-link';
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import { extractIpcError } from '@/utils/ipcError';
import {
  useDeviceLinkDeviceList,
  useDeviceLinkDeviceListRequestState,
} from '@/features/device-link/useDeviceLinkDeviceList';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';

export function remoteDesktopUnavailableReason(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'remoteDesktop.shortcut.checkFailed';
  const caps = value as Partial<RemoteDesktopCapabilities>;
  if (caps.version !== 1) return 'remoteDesktop.upgrade';
  if (typeof caps.enabled !== 'boolean') return 'remoteDesktop.shortcut.checkFailed';
  if (!caps.enabled) return 'remoteDesktop.disabled';
  if (caps.permissions?.screenRecording === 'missing') return 'remoteDesktop.permissionHint';
  if (
    !Array.isArray(caps.displays) ||
    !caps.displays.some(
      (display) =>
        display &&
        typeof display.id === 'string' &&
        display.id.length > 0 &&
        Number.isFinite(display.width) &&
        display.width > 0 &&
        Number.isFinite(display.height) &&
        display.height > 0,
    )
  )
    return 'remoteDesktop.shortcut.noDisplay';
  return null;
}

export function remoteDesktopAvailabilityError(error: unknown): string {
  const parsed = extractIpcError(error);
  const code = parsed
    ? parsed.code + ' ' + parsed.message
    : error instanceof Error
      ? error.message
      : '';
  if (code.includes('ACCESS_REVOKED')) return 'remoteDesktop.accessRevoked';
  if (code.includes('CONTROL_DISABLED')) return 'remoteDesktop.shortcut.controlDisabled';
  if (code.includes('REMOTE_DISABLED')) return 'remoteDesktop.remoteDisabled';
  if (code.includes('CHANNEL_NOT_ALLOWED')) return 'remoteDesktop.upgrade';
  if (code.includes('DESKTOP_DISABLED')) return 'remoteDesktop.disabled';
  if (code.includes('PEER_OFFLINE')) return 'remoteDesktop.shortcut.offline';
  return 'remoteDesktop.shortcut.checkFailed';
}

export function useRemoteDesktopAvailability(deviceId: string, active: boolean) {
  const devices = useDeviceLinkDeviceList();
  const { status: directoryStatus } = useDeviceLinkDeviceListRequestState();
  const revoked = useSyncExternalStore(
    revokedDevicesStore.subscribe,
    revokedDevicesStore.getSnapshot,
  );
  const device = devices?.find((entry) => entry.deviceId === deviceId);
  const denied = revoked.has(deviceId);
  const blockedReason = denied
    ? 'remoteDesktop.accessRevoked'
    : !device
      ? directoryStatus === 'loading'
        ? null
        : 'remoteDesktop.shortcut.checkFailed'
      : device.isSelf || isMobilePlatform(device.platform)
        ? 'remoteDesktop.shortcut.unsupported'
        : !device.online
          ? 'remoteDesktop.shortcut.offline'
          : !device.controlEnabled
            ? 'remoteDesktop.shortcut.controlDisabled'
            : !device.remoteControlEnabled
              ? 'remoteDesktop.remoteDisabled'
              : null;
  const scope = useMemo(
    () => ({ deviceId, device, active, denied, directoryStatus }),
    [deviceId, device, active, denied, directoryStatus],
  );
  const [checked, setChecked] = useState<{ scope: typeof scope; reason: string | null } | null>(
    null,
  );

  useEffect(() => {
    if (!scope.active || !scope.device || blockedReason) return;
    let current = true;
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(() =>
          window.electronAPI.deviceLink.invoke(scope.deviceId, REMOTE_DESKTOP_CHANNEL, [
            { op: 'capabilities' },
          ]),
        )
        .then((value) => {
          if (current) setChecked({ scope, reason: remoteDesktopUnavailableReason(value) });
        })
        .catch((error: unknown) => {
          if (current) setChecked({ scope, reason: remoteDesktopAvailabilityError(error) });
        });
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [scope, blockedReason]);

  const reason = blockedReason ?? (checked?.scope === scope ? checked.reason : null);
  return {
    checking: !reason && checked?.scope !== scope,
    available: !blockedReason && checked?.scope === scope && checked.reason === null,
    reason,
    markUnavailable: (error: unknown) => {
      setChecked({ scope, reason: remoteDesktopAvailabilityError(error) });
    },
  };
}
