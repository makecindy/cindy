import { describe, expect, it, vi } from 'vitest';
import { DL_HISTORY_QUERY_CHANNEL, DeviceLinkError } from '@cindy/device-link';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';
import { createHistoryRemoteDeps } from '../historyDevices.js';

function device(id: string, changes: Partial<DeviceLinkDeviceView> = {}): DeviceLinkDeviceView {
  return {
    deviceId: id,
    name: id,
    platform: 'darwin',
    appVersion: null,
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: false,
    ...changes,
  };
}
function setup(devices: DeviceLinkDeviceView[] = []) {
  const invoke = vi.fn(async () => ({
    ok: true as const,
    result: { ok: true, sessions: [], hasMore: false, nextCursor: null },
  }));
  let owner = 1;
  const captureAccess = () => {
    const captured = owner;
    return () => {
      if (captured !== owner) throw new Error('Owner changed');
    };
  };
  const listDevices = vi.fn(async () => ({ devices }));
  return {
    invoke,
    listDevices,
    changeOwner: () => owner++,
    remote: createHistoryRemoteDeps({ invoke, listDevices, captureAccess }),
  };
}
describe('desktop history discovery/transport', () => {
  it('includes local and candidate desktops with explicit disabled/offline reasons, excluding phones', async () => {
    const s = setup([
      device('self', { isSelf: true }),
      device('mac'),
      device('phone', { platform: 'ios' }),
      device('disabled', { controlEnabled: false }),
      device('sleeping', { online: false }),
    ]);
    expect(await s.remote.listDevices()).toEqual([
      { deviceId: 'local', deviceName: 'self', local: true, available: true },
      { deviceId: 'mac', deviceName: 'mac', local: false, available: true },
      {
        deviceId: 'disabled',
        deviceName: 'disabled',
        local: false,
        available: false,
        unavailableReason: 'REMOTE_DISABLED',
      },
      {
        deviceId: 'sleeping',
        deviceName: 'sleeping',
        local: false,
        available: false,
        unavailableReason: 'REMOTE_DEVICE_OFFLINE',
      },
    ]);
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it('keeps local available even before the relay registers this host', async () => {
    expect(await setup().remote.listDevices()).toEqual([
      { deviceId: 'local', deviceName: 'Local', local: true, available: true },
    ]);
  });
  it('uses the read-only channel and preserves source pagination', async () => {
    const s = setup();
    expect(await s.remote.query('mac', 'list_sessions', { limit: 5 })).toMatchObject({ ok: true });
    expect(s.invoke).toHaveBeenCalledWith(
      'mac',
      DL_HISTORY_QUERY_CHANNEL,
      [{ tool: 'list_sessions', args: { limit: 5 } }],
      { preSend: expect.any(Function) },
    );
  });
  it.each([
    ['CHANNEL_NOT_ALLOWED', 'REMOTE_UNSUPPORTED'],
    ['ACCESS_REVOKED', 'REMOTE_ACCESS_REVOKED'],
    ['DEVICE_OFFLINE', 'REMOTE_DEVICE_OFFLINE'],
    ['INVOKE_TIMEOUT', 'REMOTE_TIMEOUT'],
    ['PAYLOAD_TOO_LARGE', 'REMOTE_PAYLOAD_TOO_LARGE'],
  ])('reports %s without retries or local fallback', async (code, expected) => {
    const s = setup();
    s.invoke.mockResolvedValueOnce({ ok: false, error: { code, message: 'Unavailable' } } as any);
    expect(await s.remote.query('mac', 'search_chat_history', { query: 'x' })).toMatchObject({
      ok: false,
      errorCode: expected,
    });
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });
  it('maps thrown transport errors and rejects malformed responses', async () => {
    const s = setup();
    s.invoke.mockRejectedValueOnce(new DeviceLinkError('ACCESS_REVOKED', 'revoked'));
    expect(await s.remote.query('mac', 'list_sessions', {})).toMatchObject({
      errorCode: 'REMOTE_ACCESS_REVOKED',
    });
    s.invoke.mockResolvedValueOnce({ ok: true, result: [] } as any);
    expect(await s.remote.query('mac', 'list_sessions', {})).toMatchObject({
      errorCode: 'REMOTE_INVALID_RESPONSE',
    });
  });
  it('rejects discovery and late query replies across account changes', async () => {
    const s = setup();
    s.listDevices.mockImplementationOnce(async () => {
      s.changeOwner();
      return { devices: [] };
    });
    await expect(s.remote.listDevices()).rejects.toThrow('Owner changed');
    s.invoke.mockImplementationOnce(async () => {
      s.changeOwner();
      return { ok: true, result: { ok: true, sessions: [], hasMore: false, nextCursor: null } };
    });
    await expect(s.remote.query('mac', 'list_sessions', {})).rejects.toThrow('Owner changed');
  });
});
