import { describe, expect, it } from 'vitest';
import { DeviceLinkError } from '@cindy/device-link';
import { isTransientDeviceExportStatusError } from '../device-export-status-error.js';

describe('device export status error classification', () => {
  it.each([
    new DeviceLinkError('NOT_CONNECTED', 'not connected to relay'),
    new DeviceLinkError('LINK_NOT_OPEN', 'link is reopening'),
    new DeviceLinkError('INVOKE_TIMEOUT', 'status response timed out'),
    new DeviceLinkError('DEVICE_OFFLINE', 'target is offline'),
    new DeviceLinkError('BACKPRESSURE', 'reliable buffer is full'),
    new Error('connection lost while polling'),
  ])('retries transient transport failure %#', (error) => {
    expect(isTransientDeviceExportStatusError(error)).toBe(true);
  });

  it('does not retry permanent remote failures', () => {
    expect(isTransientDeviceExportStatusError(
      new DeviceLinkError('REMOTE_DISABLED', 'remote control is disabled'),
    )).toBe(false);
  });
});
