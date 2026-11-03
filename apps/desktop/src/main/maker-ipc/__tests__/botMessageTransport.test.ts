import { describe, expect, it, vi } from 'vitest';
import { createBotMessageTransport } from '../botMessageTransport.js';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';

const peer = (id: string, changes: Partial<DeviceLinkDeviceView> = {}): DeviceLinkDeviceView => ({
  deviceId: id, name: id, platform: 'darwin', appVersion: '1', lastSeenAt: null, online: true,
  busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false, ...changes,
});
const resource = (name = 'Same name') => ({ ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' },
  display: { title: name }, teammateMessaging: { version: 1, available: true } });

describe('teammate device transport', () => {
  it('keeps same-name peers distinct and reports offline and disabled devices without contacting them', async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, result: { items: [resource()] } }));
    const transport = createBotMessageTransport({ selfDeviceId: () => 'self', invoke,
      listDevices: async () => ({ devices: [peer('a'), peer('b'), peer('offline', { online: false }),
        peer('disabled', { controlEnabled: false }), peer('self', { isSelf: true })] }) });
    const result = await transport.list();
    expect(result.agents.map(row => row.id)).toEqual(['a::bot-1', 'b::bot-1']);
    expect(result.unavailableDevices).toEqual([
      { deviceId: 'offline', deviceName: 'offline', errorCode: 'DEVICE_OFFLINE' },
      { deviceId: 'disabled', deviceName: 'disabled', errorCode: 'REMOTE_DISABLED' },
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([81, 128])('discovers and resolves a %i-character Bot ID without dropping later roster entries', async length => {
    const deviceId = 'd'.repeat(80);
    const botId = 'b'.repeat(length);
    const longResource = { ...resource(), ref: { ...resource().ref, id: botId } };
    const invoke = vi.fn(async (_device: string, channel: string) => ({ ok: true as const,
      result: channel.endsWith(':list') ? { items: [longResource, resource()] } : longResource }));
    const transport = createBotMessageTransport({ selfDeviceId: () => 'self', invoke,
      listDevices: async () => ({ devices: [peer(deviceId)] }) });
    expect(await transport.list()).toMatchObject({ agents: [
      { id: `${deviceId}::${botId}` }, { id: `${deviceId}::bot-1` },
    ], unavailableDevices: [] });
    expect(await transport.resolve(`${deviceId}::${botId}`)).toEqual({ id: `${deviceId}::${botId}`, name: 'Same name' });
  });

  it('resolves a fresh stable resource and rejects old hosts and paused peers', async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, result: resource() }));
    const transport = createBotMessageTransport({ selfDeviceId: () => 'self', invoke,
      listDevices: async () => ({ devices: [peer('a')] }) });
    expect(await transport.resolve('a::bot-1')).toEqual({ id: 'a::bot-1', name: 'Same name' });
    await expect(transport.resolve('foreign::bot-1')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    invoke.mockResolvedValueOnce({ ok: true, result: { ...resource(), teammateMessaging: undefined } } as never);
    await expect(transport.resolve('a::bot-1')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    invoke.mockResolvedValueOnce({ ok: true, result: { ...resource(), teammateMessaging: { version: 1, available: false } } });
    await expect(transport.resolve('a::bot-1')).rejects.toMatchObject({ code: 'TARGET_BOT_INACTIVE' });
  });

  it('uses the resource action and propagates the pre-send account guard without treating timeout as failure', async () => {
    const assertCurrent = vi.fn();
    const invoke = vi.fn(async (_device: string, _channel: string, _args: unknown[], opts?: { preSend?: () => void }) => {
      opts?.preSend?.();
      return { ok: true as const, result: { effects: [], teammateMessage: { ok: true, delivered: false, accepted: true, messageId: 'unique-id', wakeKind: 'queued' } } };
    });
    const transport = createBotMessageTransport({ selfDeviceId: () => 'self', invoke,
      listDevices: async () => ({ devices: [peer('a')] }) });
    const input = { targetId: 'a::bot-1', senderBotId: 'bot-2', message: 'hello', messageId: 'unique-id' };
    expect(await transport.send(input, assertCurrent)).toMatchObject({ ok: true, accepted: true, delivered: false });
    expect(invoke).toHaveBeenCalledWith('a', 'maker:remote-resources:invoke', [expect.objectContaining({
      actionId: 'send-message', resourceRef: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' },
      input: { senderBotId: 'bot-2', message: 'hello', messageId: 'unique-id' },
    })], expect.anything());
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    invoke.mockRejectedValueOnce(new Error('timeout'));
    await expect(transport.send(input, assertCurrent)).rejects.toThrow('timeout');
    invoke.mockRejectedValueOnce(Object.assign(new Error('revoked'), { code: 'ACCESS_REVOKED' }));
    expect(await transport.send(input, assertCurrent)).toMatchObject({ ok: false, errorCode: 'ACCESS_REVOKED' });
    // Revocation of an already-sent request cannot establish non-delivery.
    invoke.mockRejectedValueOnce(Object.assign(new Error('revoked in flight'), { code: 'ACCESS_REVOKED', inFlight: true }));
    await expect(transport.send(input, assertCurrent)).rejects.toThrow('revoked in flight');
    invoke.mockResolvedValueOnce({ ok: true, result: { effects: [], teammateMessage: { ok: true, accepted: true,
      delivered: false, messageId: 'another-message', wakeKind: 'queued' } } });
    await expect(transport.send(input, assertCurrent)).rejects.toMatchObject({ code: 'DELIVERY_UNKNOWN' });
  });

  it('reads only a native receipt and preserves revocation, unsupported and mismatched response failures', async () => {
    let enabled = true;
    const invoke = vi.fn(async () => ({ ok: true as const, result: { messageId: 'message-1', accepted: true as true | null } }));
    const transport = createBotMessageTransport({ selfDeviceId: () => 'self', invoke,
      listDevices: async () => ({ devices: [peer('a', { controlEnabled: enabled })] }) });
    const args = { targetId: 'a::bot-1', senderBotId: 'sender', messageId: 'message-1' };
    const guard = vi.fn();
    expect(await transport.readReceipt!(args, guard)).toEqual({ messageId: 'message-1', accepted: true });
    expect(invoke).toHaveBeenCalledWith('a', 'maker:remote-resources:invoke', [expect.objectContaining({
      actionId: 'message-receipt', input: { senderBotId: 'sender', messageId: 'message-1' },
    })], { preSend: guard });
    invoke.mockResolvedValueOnce({ ok: true, result: { messageId: 'other', accepted: true } });
    await expect(transport.readReceipt!(args, guard)).rejects.toMatchObject({ code: 'DELIVERY_UNKNOWN' });
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'UNSUPPORTED_CAPABILITY', message: 'old action unavailable' } } as never);
    await expect(transport.readReceipt!(args, guard)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    enabled = false;
    await expect(transport.readReceipt!(args, guard)).rejects.toMatchObject({ code: 'REMOTE_DISABLED' });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('verifies the exact source reservation through the authenticated resource action', async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, result: { verified: true } }));
    const assertCurrent = vi.fn();
    const transport = createBotMessageTransport({ selfDeviceId: () => 'self', invoke,
      listDevices: async () => ({ devices: [peer('a')] }) });
    expect(await transport.verifySender({ controllerDeviceId: 'a', senderBotId: 'bot-1',
      targetBotId: 'bot-2', message: 'hello', messageId: 'unique-id' }, assertCurrent)).toBe(true);
    expect(invoke).toHaveBeenCalledWith('a', 'maker:remote-resources:invoke', [expect.objectContaining({
      actionId: 'verify-message', resourceRef: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' },
      input: { targetBotId: 'bot-2', message: 'hello', messageId: 'unique-id' },
    })], { preSend: assertCurrent });
    invoke.mockResolvedValueOnce({ ok: true, result: { verified: false } });
    expect(await transport.verifySender({ controllerDeviceId: 'a', senderBotId: 'bot-1',
      targetBotId: 'bot-2', message: 'hello', messageId: 'unique-id' }, assertCurrent)).toBe(false);
    assertCurrent.mockImplementationOnce(() => { throw new Error('owner changed'); });
    await expect(transport.verifySender({ controllerDeviceId: 'a', senderBotId: 'bot-1',
      targetBotId: 'bot-2', message: 'hello', messageId: 'unique-id' }, assertCurrent)).rejects.toThrow('owner changed');
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
