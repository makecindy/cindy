import { describe, expect, it, vi } from 'vitest';
import { createTeammateDirectory } from '../teammateDirectory.js';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';

const peer = (id: string, changes: Partial<DeviceLinkDeviceView> = {}): DeviceLinkDeviceView => ({
  deviceId: id, name: id, platform: 'darwin', appVersion: '1', lastSeenAt: null, online: true,
  busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false, ...changes,
});
const resource = (id = 'bot-1', sessionId?: string) => ({ ref: { collectionId: 'teammates', kind: 'bot', id },
  display: { title: 'Same name' },
  links: sessionId ? [{ rel: 'conversation', target: { kind: 'session', sessionId } }] : [] });

describe('teammate directory', () => {
  it('keeps same-name peers distinct, carries their main chat, and reports offline and disabled devices without contacting them', async () => {
    const invoke = vi.fn(async (deviceId: string) => ({ ok: true as const,
      result: { items: [resource('bot-1', deviceId === 'a' ? 'a-main' : undefined)] } }));
    const directory = createTeammateDirectory({ invoke,
      listDevices: async () => ({ devices: [peer('a'), peer('b'), peer('offline', { online: false }),
        peer('disabled', { controlEnabled: false }), peer('self', { isSelf: true })] }) });
    const result = await directory.list();
    expect(result.agents).toEqual([
      { id: 'a::bot-1', name: 'Same name', deviceId: 'a', deviceName: 'a', sessionId: 'a-main' },
      { id: 'b::bot-1', name: 'Same name', deviceId: 'b', deviceName: 'b' },
    ]);
    expect(result.unavailableDevices).toEqual([
      { deviceId: 'offline', deviceName: 'offline', errorCode: 'DEVICE_OFFLINE' },
      { deviceId: 'disabled', deviceName: 'disabled', errorCode: 'REMOTE_DISABLED' },
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([81, 128])('discovers a %i-character Bot ID without dropping later roster entries', async length => {
    const deviceId = 'd'.repeat(80);
    const botId = 'b'.repeat(length);
    const invoke = vi.fn(async () => ({ ok: true as const, result: { items: [resource(botId), resource()] } }));
    const directory = createTeammateDirectory({ invoke, listDevices: async () => ({ devices: [peer(deviceId)] }) });
    expect(await directory.list()).toMatchObject({ agents: [
      { id: `${deviceId}::${botId}` }, { id: `${deviceId}::bot-1` },
    ], unavailableDevices: [] });
  });
});
