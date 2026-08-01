import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import {
  androidStatusFallback,
  describeAndroidDeviceStatus,
  describeAndroidStatus,
  getAndroidConnectionGuideKind,
} from '../androidStatusPresentation';

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key) as TFunction;

describe('android status presentation', () => {
  it('decodes IPC error messages before rendering fallback status', () => {
    expect(androidStatusFallback(new Error('[INTERNAL] backend crashed'))).toMatchObject({
      adb_available: false,
      issue: 'ANDROID_DRIVER_ERROR',
      error: 'backend crashed',
    });
  });

  it('reports unexpected adb-unavailable issues as unknown issues', () => {
    expect(
      describeAndroidStatus(
        {
          adb_available: false,
          adb_path: null,
          version: null,
          devices: [],
          default_device_serial: null,
          issue: 'NO_DEVICE',
        },
        t,
      ),
    ).toBe('settings.computerUse.android.status.unknownIssue:{"issue":"NO_DEVICE"}');
  });

  it('falls back to the first ready device when the default serial is stale', () => {
    expect(
      describeAndroidStatus(
        {
          adb_available: true,
          adb_path: '/sdk/platform-tools/adb',
          version: 'Android Debug Bridge version 1.0.41',
          devices: [
            { device_serial: 'offline-1', state: 'offline' },
            { device_serial: 'ready-1', state: 'device', model: 'Pixel 8' },
            { device_serial: 'ready-2', state: 'device' },
          ],
          default_device_serial: 'missing',
          issue: null,
        },
        t,
      ),
    ).toBe(
      'settings.computerUse.android.status.ready:{"count":2,"device":"Pixel 8 (ready-1)"}',
    );
  });

  it('names a configured stale default device when status reports NO_DEVICE', () => {
    expect(
      describeAndroidStatus(
        {
          adb_available: true,
          adb_path: '/sdk/platform-tools/adb',
          version: 'Android Debug Bridge version 1.0.41',
          devices: [{ device_serial: 'ready-1', state: 'device', model: 'Pixel 8' }],
          default_device_serial: 'missing',
          configured_default_device_serial: 'missing',
          issue: 'NO_DEVICE',
        },
        t,
      ),
    ).toBe(
      'settings.computerUse.android.status.defaultUnavailable:{"device":"missing"}',
    );
  });

  it('surfaces multiple-device issues before connected counts', () => {
    expect(
      describeAndroidDeviceStatus(
        {
          adb_available: true,
          adb_path: '/sdk/platform-tools/adb',
          version: 'Android Debug Bridge version 1.0.41',
          devices: [
            { device_serial: 'ready-1', state: 'device', model: 'Pixel 8' },
            { device_serial: 'ready-2', state: 'device', model: 'Pixel 9' },
          ],
          default_device_serial: 'ready-1',
          issue: 'MULTIPLE_DEVICES',
        },
        t,
      ),
    ).toBe(
      'settings.computerUse.android.status.multipleDevices:{"count":2}',
    );
  });

  it('surfaces stale default issues before connected counts', () => {
    expect(
      describeAndroidDeviceStatus(
        {
          adb_available: true,
          adb_path: '/sdk/platform-tools/adb',
          version: 'Android Debug Bridge version 1.0.41',
          devices: [{ device_serial: 'ready-1', state: 'device', model: 'Pixel 8' }],
          default_device_serial: 'missing',
          configured_default_device_serial: 'missing',
          issue: 'NO_DEVICE',
        },
        t,
      ),
    ).toBe(
      'settings.computerUse.android.status.defaultUnavailable:{"device":"missing"}',
    );
  });

  it.each([
    ['NO_DEVICE', 'connect'],
    ['DEVICE_UNAUTHORIZED', 'unauthorized'],
    ['DEVICE_OFFLINE', 'offline'],
  ] as const)('maps %s to its actionable connection guide', (issue, guide) => {
    expect(
      getAndroidConnectionGuideKind({
        adb_available: true,
        adb_path: '/sdk/platform-tools/adb',
        version: 'Android Debug Bridge version 1.0.41',
        devices: [],
        default_device_serial: null,
        issue,
      }),
    ).toBe(guide);
  });

  it('does not show a reconnect guide when a ready device is available', () => {
    expect(
      getAndroidConnectionGuideKind({
        adb_available: true,
        adb_path: '/sdk/platform-tools/adb',
        version: 'Android Debug Bridge version 1.0.41',
        devices: [{ device_serial: 'ready-1', state: 'device' }],
        default_device_serial: 'missing',
        configured_default_device_serial: 'missing',
        issue: 'NO_DEVICE',
      }),
    ).toBeNull();
  });

  it.each([
    ['unauthorized', 'unauthorized'],
    ['offline', 'offline'],
  ] as const)(
    'prefers a listed %s device when a stale configured default reports NO_DEVICE',
    (state, guide) => {
      expect(
        getAndroidConnectionGuideKind({
          adb_available: true,
          adb_path: '/sdk/platform-tools/adb',
          version: 'Android Debug Bridge version 1.0.41',
          devices: [{ device_serial: 'connected-1', state }],
          default_device_serial: 'missing',
          configured_default_device_serial: 'missing',
          issue: 'NO_DEVICE',
        }),
      ).toBe(guide);
    },
  );

  it.each([
    ['unauthorized', 'unauthorized'],
    ['offline', 'offline'],
  ] as const)(
    'keeps the configured default %s guide when another device is ready',
    (state, guide) => {
      expect(
        getAndroidConnectionGuideKind({
          adb_available: true,
          adb_path: '/sdk/platform-tools/adb',
          version: 'Android Debug Bridge version 1.0.41',
          devices: [
            { device_serial: 'selected-1', state },
            { device_serial: 'ready-1', state: 'device' },
          ],
          default_device_serial: 'selected-1',
          configured_default_device_serial: 'selected-1',
          issue: state === 'unauthorized' ? 'DEVICE_UNAUTHORIZED' : 'DEVICE_OFFLINE',
        }),
      ).toBe(guide);
    },
  );

  it('does not show a connection guide while ADB is unavailable', () => {
    expect(
      getAndroidConnectionGuideKind({
        adb_available: false,
        adb_path: null,
        version: null,
        devices: [],
        default_device_serial: null,
        issue: 'ADB_NOT_FOUND',
      }),
    ).toBeNull();
  });
});
