import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_LINK_INVOKE, DEVICE_LINK_PUSH } from '../../shared/deviceLinkIpc';
import { createRemoteReadBridge } from '../remoteReadBridge';

const history = 'local-db:history:query';
const roster = 'maker:remote-resources:list';
const missing = (channel: string) => new Error(
  `Error invoking remote method 'device-link:invoke': Error: [NOT_FOUND] no local IPC handler for channel '${channel}'`,
);

function fixture() {
  const events = new EventEmitter();
  const invoke = vi.fn();
  const bridge = createRemoteReadBridge({ invoke, on: events.on.bind(events) });
  const read = (device = 'old', channel = history) => bridge.invoke(device, channel, []);
  const push = (event: string, payload: unknown) => events.emit(event, {}, payload);
  return { bridge, invoke, read, push };
}

describe('remote optional reads at the desktop IPC boundary', () => {
  it('stops only the missing channel on the answering peer without caching data or an empty success', async () => {
    const { read, invoke } = fixture();
    invoke.mockRejectedValueOnce(missing(history)).mockResolvedValueOnce(['teammate']).mockResolvedValueOnce(['task']);
    await expect(read()).rejects.toThrow('no local IPC handler');
    await expect(read()).rejects.toThrow('[NOT_FOUND]');
    await expect(read('old', roster)).resolves.toEqual(['teammate']);
    await expect(read('new')).resolves.toEqual(['task']);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it.each([
    '[DEVICE_LINK_TIMEOUT] no result within 30000ms',
    '[PERMISSION_DENIED] history is private',
    '[DEVICE_LINK_CHANNEL_NOT_ALLOWED] An account-owned link is required',
    '[NOT_FOUND] Session does not exist',
    `[NOT_FOUND] no local IPC handler for channel '${roster}'`,
    '[UNSUPPORTED_CAPABILITY] This collection does not support the requested action',
  ])('allows a successful next read after %s', async (message) => {
    const { read, invoke } = fixture();
    invoke.mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(['task']);
    await expect(read()).rejects.toThrow(message);
    await expect(read()).resolves.toEqual(['task']);
  });

  it('does not relearn an old failure after the target reconnects', async () => {
    const { read, invoke, push } = fixture();
    let rejectOld!: (cause: Error) => void;
    invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const old = read();
    push(DEVICE_LINK_PUSH.PEER_LINK_REOPENED, { deviceId: 'old' });
    rejectOld(missing(history));
    await expect(old).rejects.toThrow('no local IPC handler');
    invoke.mockResolvedValue(['now supported']);
    await expect(read()).resolves.toEqual(['now supported']);
  });

  it('lets a late-starting legacy scheduler become readable without reopening unrelated history', async () => {
    const { read, invoke, push } = fixture();
    const schedule = 'maker:schedule:list';
    invoke.mockRejectedValueOnce(missing(history)).mockRejectedValueOnce(missing(schedule)).mockResolvedValueOnce(['run']);
    await expect(read()).rejects.toThrow('[NOT_FOUND]');
    await expect(read('old', schedule)).rejects.toThrow('[NOT_FOUND]');
    push(DEVICE_LINK_PUSH.REMOTE_PUSH, { deviceId: 'old', channel: 'maker:schedule:event', payload: { type: 'ready' } });
    await expect(read()).rejects.toThrow('[NOT_FOUND]');
    await expect(read('old', schedule)).resolves.toEqual(['run']);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['maker:schedule:list', 'DEVICE_LINK_CHANNEL_NOT_ALLOWED', "channel 'maker:schedule:list' not allowed remotely"],
    ['maker:schedule:list-sidebar-index-runs', 'UNSUPPORTED_CAPABILITY', 'Capability maker:schedule:list-sidebar-index-runs is not supported in host client mode'],
  ])('retries %s on an upgraded peer even without a relay disconnect', async (channel, code, reason) => {
    const { read, invoke, push } = fixture();
    const presence = (appVersion: string) => push(DEVICE_LINK_PUSH.PRESENCE_CHANGED, {
      deviceId: 'old', online: true, remoteControlEnabled: true, appVersion,
    });
    invoke.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error(`[${code}] ${reason}`)).mockResolvedValueOnce(['run']);
    await read('old', roster);
    presence('1');
    await expect(read('old', channel)).rejects.toThrow(reason);
    presence('1');
    await expect(read('old', channel)).rejects.toThrow(reason);
    presence('2');
    await expect(read('old', channel)).resolves.toEqual(['run']);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('rechecks after changed capabilities, but not an identical handshake or routine presence', async () => {
    const { bridge, invoke, read, push } = fixture();
    let capabilities: string[] = [];
    invoke.mockImplementation(async (method: string) => {
      if (method === DEVICE_LINK_INVOKE.OPEN_LINK) return { appVersion: '1', allowlistHash: 'a', capabilities };
      if (!capabilities.length) throw missing(history);
      return ['available'];
    });
    await bridge.openLink('old');
    await expect(read()).rejects.toThrow('[NOT_FOUND]');
    push(DEVICE_LINK_PUSH.PRESENCE_CHANGED, { deviceId: 'old', online: true, remoteControlEnabled: true, appVersion: '1', busy: true });
    await bridge.openLink('old');
    await expect(read()).rejects.toThrow('[NOT_FOUND]');
    expect(invoke.mock.calls.filter(([method]) => method === DEVICE_LINK_INVOKE.INVOKE)).toHaveLength(1);
    capabilities = ['new'];
    await bridge.openLink('old');
    await expect(read()).resolves.toEqual(['available']);
  });
});
