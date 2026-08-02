import { describe, expect, it } from 'vitest';

import { telegramRemoteFailureKey } from '../TelegramRemoteDevices';

const ipcError = (code: string, message = 'internal transport message') =>
  new Error(`[${code}] ${message}`);

describe('TelegramRemoteDevices remote failure i18n', () => {
  it.each([
    ['PRECONDITION_FAILED', 'settings.telegramBot.remoteDevices.state.otherBot'],
    ['DEVICE_LINK_REMOTE_DISABLED', 'settings.telegramBot.remoteDevices.failure.remoteDisabled'],
    ['DEVICE_LINK_ACCESS_REVOKED', 'settings.telegramBot.remoteDevices.failure.accessRevoked'],
    ['DEVICE_LINK_CONTROL_DISABLED', 'settings.telegramBot.remoteDevices.failure.controlDisabled'],
    ['DEVICE_LINK_NOT_CONNECTED', 'settings.telegramBot.remoteDevices.failure.unreachable'],
    ['DEVICE_LINK_DEVICE_OFFLINE', 'settings.telegramBot.remoteDevices.failure.unreachable'],
    ['DEVICE_LINK_TIMEOUT', 'settings.telegramBot.remoteDevices.failure.unreachable'],
    ['DEVICE_LINK_UNAVAILABLE', 'settings.telegramBot.remoteDevices.failure.unreachable'],
    ['DEVICE_LINK_STANDBY', 'settings.telegramBot.remoteDevices.failure.unreachable'],
    ['DEVICE_LINK_VERSION_MISMATCH', 'settings.telegramBot.remoteDevices.state.unsupported'],
  ])('maps %s without exposing its raw message', (code, expectedKey) => {
    expect(telegramRemoteFailureKey(ipcError(code, 'raw English must stay out of the toast'))).toBe(
      expectedKey,
    );
  });

  it('uses a localized fallback for unknown IPC codes and non-IPC errors', () => {
    const fallback = 'settings.telegramBot.remoteDevices.failure.unknown';
    expect(telegramRemoteFailureKey(ipcError('INTERNAL', 'raw internal failure'))).toBe(fallback);
    expect(telegramRemoteFailureKey(new Error('raw unstructured failure'))).toBe(fallback);
  });
});
