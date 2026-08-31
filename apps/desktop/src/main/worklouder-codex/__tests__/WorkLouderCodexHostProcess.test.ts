import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyConnectionError,
  isOptionalDeviceStatusError,
  postDeviceStatus,
} from '../workLouderCodexHostProcess.js';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('Work Louder connection error classification', () => {
  it('keeps macOS authorization failures on the permission circuit breaker path', () => {
    setPlatform('darwin');

    expect(classifyConnectionError('HID access denied by Input Monitoring')).toBe(
      'permission-required',
    );
    expect(classifyConnectionError('operation not allowed')).toBe('permission-required');
  });

  it('keeps Windows access denied on the bounded connection retry path', () => {
    setPlatform('win32');

    expect(classifyConnectionError('HID access denied')).toBe('connection-failed');
    expect(classifyConnectionError('permission denied while opening HID handle')).toBe(
      'connection-failed',
    );
  });

  it('does not treat permission-looking errors as permanent outside macOS', () => {
    setPlatform('linux');

    expect(classifyConnectionError('not permitted')).toBe('connection-failed');
  });
});

describe('Work Louder device status', () => {
  it('recognizes explicit unsupported status RPC errors as optional telemetry', () => {
    expect(isOptionalDeviceStatusError(new Error('status RPC unsupported'))).toBe(true);
    expect(isOptionalDeviceStatusError({ code: 'ERR_METHOD_NOT_FOUND' })).toBe(true);
  });

  it('keeps rejected hardware status probes fatal so unplugged handles are recycled', () => {
    expect(isOptionalDeviceStatusError(new Error('device disconnected'))).toBe(false);
    expect(isOptionalDeviceStatusError(new Error('HID request failed'))).toBe(false);
  });

  it('keeps the HID connection usable when optional status telemetry fails', async () => {
    const getDeviceStatus = vi.fn().mockRejectedValue(new Error('status RPC unsupported'));

    await expect(
      postDeviceStatus(
        {
          sendLightingConfig: vi.fn(),
          sendThreadsLighting: vi.fn(),
          getDeviceStatus,
        },
        'codex-micro',
        true,
      ),
    ).resolves.toBeUndefined();
    expect(getDeviceStatus).toHaveBeenCalledOnce();
  });

  it('rejects a status probe that fails without an unsupported-RPC signal', async () => {
    const getDeviceStatus = vi.fn().mockRejectedValue(new Error('device disconnected'));

    await expect(
      postDeviceStatus(
        {
          sendLightingConfig: vi.fn(),
          sendThreadsLighting: vi.fn(),
          getDeviceStatus,
        },
        'codex-micro',
        true,
      ),
    ).rejects.toThrow('device disconnected');
  });
});
