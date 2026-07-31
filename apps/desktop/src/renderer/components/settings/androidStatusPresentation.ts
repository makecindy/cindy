/**
 * Presentation helpers for the Android automation Settings card.
 *
 * Kept pure so edge-case status wording can be tested without rendering the
 * full settings section.
 */

import type { TFunction } from 'i18next';
import { extractIpcError } from '@/utils/ipcError';

export type AndroidConnectionGuideKind = 'connect' | 'unauthorized' | 'offline';

export function androidStatusFallback(err: unknown): AndroidStatusSummary {
  const ipcError = extractIpcError(err);
  return {
    adb_available: false,
    adb_path: null,
    version: null,
    devices: [],
    default_device_serial: null,
    issue: 'ANDROID_DRIVER_ERROR',
    error: ipcError?.message ?? (err instanceof Error ? err.message : String(err)),
  };
}

export function androidDeviceLabel(device: AndroidConnectedDevice | undefined): string {
  if (!device) return '';
  return device.model ? `${device.model} (${device.device_serial})` : device.device_serial;
}

export function describeAndroidStatus(status: AndroidStatusSummary, t: TFunction): string {
  const readyDevices = status.devices.filter((device) => device.state === 'device');
  if (status.issue === 'ADB_NOT_FOUND') {
    return t('settings.computerUse.android.status.adbNotFound');
  }
  if (!status.adb_available && status.issue === 'ANDROID_DRIVER_ERROR') {
    return t('settings.computerUse.android.status.failed', {
      message: status.error ?? status.issue,
    });
  }
  if (!status.adb_available) {
    return status.issue
      ? t('settings.computerUse.android.status.unknownIssue', {
          issue: status.issue,
        })
      : t('settings.computerUse.android.status.adbNotFound');
  }
  if (!status.issue) {
    const defaultDevice = (
      status.default_device_serial
        ? status.devices.find((device) => device.device_serial === status.default_device_serial)
        : undefined
    ) ?? readyDevices[0];
    if (!defaultDevice) {
      return t('settings.computerUse.android.status.noDevice');
    }
    return t('settings.computerUse.android.status.ready', {
      count: readyDevices.length,
      device: androidDeviceLabel(defaultDevice),
    });
  }
  if (status.issue === 'NO_DEVICE') {
    const configuredDevice = status.configured_default_device_serial?.trim();
    if (configuredDevice) {
      return t('settings.computerUse.android.status.defaultUnavailable', {
        device: configuredDevice,
      });
    }
    return t('settings.computerUse.android.status.noDevice');
  }
  if (status.issue === 'MULTIPLE_DEVICES') {
    return t('settings.computerUse.android.status.multipleDevices', {
      count: readyDevices.length,
    });
  }
  if (status.issue === 'DEVICE_UNAUTHORIZED') {
    return t('settings.computerUse.android.status.unauthorized');
  }
  if (status.issue === 'DEVICE_OFFLINE') {
    return t('settings.computerUse.android.status.offline');
  }
  if (status.issue === 'ANDROID_DRIVER_ERROR') {
    return t('settings.computerUse.android.status.failed', {
      message: status.error ?? status.issue,
    });
  }
  return t('settings.computerUse.android.status.unknownIssue', {
    issue: status.issue,
  });
}

/**
 * Return the actionable connection guide for a device state.
 *
 * When a configured default is present, its concrete unauthorized/offline
 * state takes priority even if another device is ready. A stale configured
 * default can also force the aggregate issue to NO_DEVICE, so when no device is
 * ready we inspect the listed device states before falling back to that issue.
 */
export function getAndroidConnectionGuideKind(
  status: AndroidStatusSummary | null,
): AndroidConnectionGuideKind | null {
  if (!status?.adb_available) return null;

  const configuredDefault = status.configured_default_device_serial?.trim();
  const configuredDevice = configuredDefault
    ? status.devices.find((device) => device.device_serial === configuredDefault)
    : undefined;
  if (configuredDevice?.state === 'unauthorized') return 'unauthorized';
  if (configuredDevice?.state === 'offline') return 'offline';

  const hasReadyDevice = status.devices.some((device) => device.state === 'device');
  if (hasReadyDevice) return null;

  if (status.devices.some((device) => device.state === 'unauthorized')) return 'unauthorized';
  if (status.devices.some((device) => device.state === 'offline')) return 'offline';
  if (status.issue === 'DEVICE_UNAUTHORIZED') return 'unauthorized';
  if (status.issue === 'DEVICE_OFFLINE') return 'offline';
  if (status.issue === 'NO_DEVICE' || !status.issue) return 'connect';
  return null;
}

export function describeAndroidDeviceStatus(
  status: AndroidStatusSummary | null,
  t: TFunction,
): string {
  if (!status) return t('settings.computerUse.android.status.checking');
  if (status.issue) return describeAndroidStatus(status, t);

  const readyDevices = status.devices.filter((device) => device.state === 'device');
  if (status.adb_available && readyDevices.length > 0) {
    return t('settings.computerUse.android.device.connected', {
      count: readyDevices.length,
    });
  }
  return describeAndroidStatus(status, t);
}
