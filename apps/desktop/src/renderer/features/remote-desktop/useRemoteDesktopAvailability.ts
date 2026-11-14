import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { REMOTE_DESKTOP_CHANNEL, type RemoteDesktopCapabilities } from '@cindy/device-link';
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import { extractIpcError } from '@/utils/ipcError';
import {
  useDeviceLinkDeviceList,
  useDeviceLinkDeviceListRequestState,
} from '@/features/device-link/useDeviceLinkDeviceList';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';
import { isTransientRemoteError } from '@/features/device-link/refreshRemoteSessions';

const CHECK_INTERRUPTED = 'remoteDesktop.shortcut.checkInterrupted';
const OFFLINE = 'remoteDesktop.shortcut.offline';
const DISABLED = 'remoteDesktop.disabled';
// Probe outcomes that may change without a presence edge: repeat them when the
// shortcut is revealed instead of keeping a stale failure.
const RETRYABLE_PROBE_REASONS = new Set([
  CHECK_INTERRUPTED,
  OFFLINE,
  DISABLED,
  'remoteDesktop.shortcut.screenRecordingRequired',
  'remoteDesktop.shortcut.noDisplay',
]);

export function remoteDesktopUnavailableReason(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'remoteDesktop.shortcut.checkFailed';
  const caps = value as Partial<RemoteDesktopCapabilities>;
  if (caps.version !== 1) return 'remoteDesktop.upgrade';
  if (typeof caps.enabled !== 'boolean') return 'remoteDesktop.shortcut.checkFailed';
  if (!caps.enabled) return DISABLED;
  if (caps.permissions?.screenRecording === 'missing')
    return 'remoteDesktop.shortcut.screenRecordingRequired';
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
  if (code.includes('DESKTOP_DISABLED') || code.includes('DESKTOP_UNAVAILABLE')) return DISABLED;
  if (code.includes('PEER_OFFLINE') || code.includes('DEVICE_OFFLINE')) return OFFLINE;
  // A link that is reconnecting, congested or behind an open circuit says
  // nothing about the remote desktop itself; the user can check again.
  if (
    isTransientRemoteError(code) ||
    code.includes('DEVICE_UNRESPONSIVE') ||
    code.includes('DEVICE_LINK_BUSY')
  )
    return CHECK_INTERRUPTED;
  return 'remoteDesktop.shortcut.checkFailed';
}

interface ProbeResult {
  scope: string;
  checking: boolean;
  reason: string | null;
  failures: number;
  retryAt: number;
}

// Shared by the sidebar and task shortcut, including their unmounted intervals.
// This is a renderer read-cache, never an authorization or transport decision.
const probes = new Map<string, ProbeResult>();
const probeListeners = new Set<() => void>();
let lifecycleApi: typeof window.electronAPI.deviceLink | null = null;
let stopLifecycle: (() => void) | null = null;

function notifyProbes(): void {
  probeListeners.forEach((listener) => listener());
}

export function clearRemoteDesktopAvailability(): void {
  probes.clear();
  notifyProbes();
}

function subscribeProbes(listener: () => void): () => void {
  const api = window.electronAPI.deviceLink;
  if (lifecycleApi !== api) {
    stopLifecycle?.();
    lifecycleApi = api;
    probes.clear();
    // Keep these listeners across component remounts so a logout or offline
    // transition cannot leave a previous connection's cached capability behind.
    const status = api.onStatusChanged(({ status }) => {
      if (status === 'stopped' || status === 'connecting') clearRemoteDesktopAvailability();
    });
    const presence = api.onPresenceChanged(({ deviceId, online }) => {
      if (!online && probes.delete(deviceId)) notifyProbes();
    });
    stopLifecycle = () => {
      status();
      presence();
    };
  }
  probeListeners.add(listener);
  return () => {
    probeListeners.delete(listener);
  };
}

function saveProbeFailure(deviceId: string, scope: string, reason: string): void {
  const previous = probes.get(deviceId);
  const failures = previous?.scope === scope ? previous.failures + 1 : 1;
  probes.set(deviceId, {
    scope,
    checking: false,
    reason,
    failures,
    retryAt:
      Date.now() +
      (reason === DISABLED ? 30_000 : Math.min(2_000 * 2 ** Math.min(failures - 1, 7), 120_000)),
  });
  notifyProbes();
}

function probeDesktop(deviceId: string, scope: string, retry = false): void {
  const previous = probes.get(deviceId);
  if (previous?.scope === scope) {
    if (
      previous.checking ||
      !retry ||
      !RETRYABLE_PROBE_REASONS.has(previous.reason ?? '') ||
      Date.now() < previous.retryAt
    )
      return;
  }
  const pending: ProbeResult = {
    scope,
    checking: true,
    reason: null,
    failures: previous?.scope === scope ? previous.failures : 0,
    retryAt: 0,
  };
  probes.set(deviceId, pending);
  notifyProbes();
  void Promise.resolve()
    .then(() =>
      probes.get(deviceId) === pending
        ? window.electronAPI.deviceLink.invoke(deviceId, REMOTE_DESKTOP_CHANNEL, [
            { op: 'capabilities' },
          ])
        : undefined,
    )
    .then((value) => {
      if (probes.get(deviceId) !== pending) return;
      const reason = remoteDesktopUnavailableReason(value);
      if (reason && RETRYABLE_PROBE_REASONS.has(reason)) {
        saveProbeFailure(deviceId, scope, reason);
        return;
      }
      probes.set(deviceId, {
        ...pending,
        checking: false,
        reason,
        failures: 0,
        retryAt: 0,
      });
      notifyProbes();
    })
    .catch((error: unknown) => {
      if (probes.get(deviceId) === pending)
        saveProbeFailure(deviceId, scope, remoteDesktopAvailabilityError(error));
    });
}

export function useRemoteDesktopAvailability(deviceId: string) {
  const devices = useDeviceLinkDeviceList();
  const { status: directoryStatus } = useDeviceLinkDeviceListRequestState();
  const revoked = useSyncExternalStore(
    revokedDevicesStore.subscribe,
    revokedDevicesStore.getSnapshot,
  );
  const unresponsive = useSyncExternalStore(
    unresponsiveDevicesStore.subscribe,
    unresponsiveDevicesStore.getSnapshot,
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
              : unresponsive.has(deviceId)
                ? 'remoteDesktop.shortcut.unresponsive'
                : null;
  const present = !!device;
  const scope = JSON.stringify([
    deviceId,
    present,
    blockedReason,
    device?.appVersion,
    device?.platform,
  ]);
  const checked = useSyncExternalStore(
    subscribeProbes,
    useCallback(() => {
      const value = probes.get(deviceId);
      return value?.scope === scope ? value : undefined;
    }, [deviceId, scope]),
  );
  const retry = useCallback(() => {
    if (present && !blockedReason) probeDesktop(deviceId, scope, true);
  }, [deviceId, scope, present, blockedReason]);

  useEffect(() => {
    if (!present || blockedReason) {
      if (probes.delete(deviceId)) notifyProbes();
      return;
    }
    // Remounts reuse both settled failures and an in-flight read. Transient
    // failures are only retried on user interaction, with per-device backoff.
    probeDesktop(deviceId, scope);
  }, [deviceId, scope, present, blockedReason, checked]);

  const reason = blockedReason ?? checked?.reason ?? null;
  return {
    checking: !reason && (!checked || checked.checking),
    available: !blockedReason && !!checked && !checked.checking && checked.reason === null,
    reason,
    retryable:
      !blockedReason &&
      !!checked &&
      !checked.checking &&
      RETRYABLE_PROBE_REASONS.has(checked.reason ?? ''),
    retry,
    markUnavailable: (error: unknown) => {
      if (!checked || probes.get(deviceId) !== checked) return;
      saveProbeFailure(deviceId, scope, remoteDesktopAvailabilityError(error));
    },
  };
}
