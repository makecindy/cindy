import { describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';

import { readRemoteMessageStatus } from '../messageStatusRemote';
import { MAKER_INVOKE } from '../../maker-ipc/channels';

const target = { deviceId: 'device-a', sessionId: 'session-1', messageId: 'm-1' };

function invokeReturning(payload: InvokeResultPayload) {
  return vi.fn(async () => payload);
}

describe('readRemoteMessageStatus', () => {
  it('invokes the device-link channel with session and message ids', async () => {
    const invoke = invokeReturning({
      ok: true,
      result: { ok: true, status: 'queued', position: 0 },
    });

    const result = await readRemoteMessageStatus(target, { invoke });

    expect(invoke).toHaveBeenCalledWith(
      'device-a',
      MAKER_INVOKE.INPUT_MESSAGE_STATUS,
      ['session-1', 'm-1'],
    );
    expect(result).toMatchObject({ ok: true, status: 'queued', position: 0 });
  });

  it('maps an offline device to REMOTE_DEVICE_OFFLINE', async () => {
    const invoke = vi.fn(async () => {
      throw new DeviceLinkError('DEVICE_OFFLINE', 'device device-a is offline');
    });

    const result = await readRemoteMessageStatus(target, { invoke });

    expect(result).toMatchObject({ ok: false, errorCode: 'REMOTE_DEVICE_OFFLINE' });
  });

  it('maps CHANNEL_NOT_ALLOWED to REMOTE_UNSUPPORTED for old hosts', async () => {
    const invoke = vi.fn(async () => {
      throw new DeviceLinkError('CHANNEL_NOT_ALLOWED', 'channel not allowed');
    });

    const result = await readRemoteMessageStatus(target, { invoke });

    expect(result).toMatchObject({ ok: false, errorCode: 'REMOTE_UNSUPPORTED' });
  });

  it('passes through remote business errors like NOT_FOUND', async () => {
    const invoke = invokeReturning({
      ok: true,
      result: { ok: false, errorCode: 'NOT_FOUND', message: 'message m-1 not found' },
    });

    const result = await readRemoteMessageStatus(target, { invoke });

    expect(result).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
  });

  it('rejects malformed remote snapshots as INTERNAL', async () => {
    const invoke = invokeReturning({
      ok: true,
      result: { ok: true, status: 'bogus' },
    });

    const result = await readRemoteMessageStatus(target, { invoke });

    expect(result).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
  });
});
