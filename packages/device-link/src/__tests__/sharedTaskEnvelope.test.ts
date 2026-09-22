import { describe, expect, it } from 'vitest';
import { encodeSharedTaskEnvelope as encode, decodeSharedTaskEnvelope as decode } from '../sharedTaskEnvelope.js';
import { sharedTaskHostPeer, sharedTaskGuestPeer, parseSharedTaskPeer, isSharedTaskPeer } from '../sharedTaskPeer.js';
import { PROTOCOL_VERSION, type Envelope } from '../protocol.js';

const frame = (dst: string): Envelope => ({ v: PROTOCOL_VERSION, kind: 'invoke', id: 'request', dst, payload: { channel: 'local-db:sessions:get', args: ['original-session'] } });

describe('shared task local handles and wire scope', () => {
  it('round-trips maximum identifiers without truncating or escaping the physical address twice', () => {
    const task = 't'.repeat(128);
    const member = 'm'.repeat(128);
    const device = String.fromCharCode(0).repeat(128);
    const key = sharedTaskGuestPeer(task, member, device);
    expect(key.length).toBeLessThanOrEqual(2048);
    expect(parseSharedTaskPeer(key)).toEqual({ sharedTaskId: task, role: 'guest', memberId: member, deviceId: device });
    expect(JSON.parse(JSON.stringify(encode({ ...frame(key), kind: 'invoke-result' }, true)))).toMatchObject({
      dst: device, sharedTask: { sharedTaskId: task, target: { role: 'guest', memberId: member } },
    });
  });
  it.each(['shared-task~task~host', 'shared-task~task~guest~member~phone', '_legacy', '设备/手机', ' '.repeat(128), '\u0000'.repeat(128), '\ud800', '%3A', '"quoted"'])('never treats a physical ID as a scoped handle: %j', id => {
    expect(isSharedTaskPeer(id)).toBe(false);
    expect(encode(frame(id), false)).toEqual(frame(id));
    expect(decode({ ...frame(id), src: id }, false)).toEqual({ ...frame(id), src: id });
    const key = sharedTaskGuestPeer('task', 'member', id);
    expect(key.length).toBeGreaterThan(128);
    expect(parseSharedTaskPeer(key)).toEqual({ sharedTaskId: 'task', role: 'guest', memberId: 'member', deviceId: id });
    expect(decode({ ...frame(id), src: key }, true)).toBeNull();
  });
  it('separates two scopes on one device without changing task payloads or wire addresses', () => {
    const first = sharedTaskHostPeer('share-a', 'desktop');
    const second = sharedTaskHostPeer('share-b', 'desktop');
    expect(new Set(['desktop', first, second]).size).toBe(3);
    expect(encode(frame(first), true)).toEqual({ ...frame('desktop'), sharedTask: { sharedTaskId: 'share-a', target: { role: 'host' } } });
    expect(encode(frame(second), true).payload).toEqual(frame(first).payload);
    expect(JSON.stringify(encode(frame(first), true))).not.toContain(first);
  });
  it('requires negotiated relay support and rejects malformed local handles', () => {
    expect(() => encode(frame(sharedTaskHostPeer('task', 'desktop')), false)).toThrow(/shared-task-v2/);
    expect(() => encode({ ...frame('desktop'), sharedTask: { sharedTaskId: 'task', target: { role: 'host' } } }, true)).toThrow();
    const key = sharedTaskHostPeer('task', 'desktop');
    for (const alias of [key + '~', key.trimEnd() + ' ', key.replace('null', 'false')]) expect(parseSharedTaskPeer(alias)).toBeNull();
  });
  it('only converts a valid relay-authored source and keeps malformed scope out of legacy dispatch', () => {
    const incoming: Envelope = { ...frame('desktop'), src: 'phone', sharedTask: { sharedTaskId: 'task', target: { role: 'host' }, source: { role: 'guest', memberId: 'member' } } };
    expect(decode(incoming, true)).toMatchObject({ src: sharedTaskGuestPeer('task', 'member', 'phone'), dst: sharedTaskHostPeer('task', 'desktop') });
    expect(decode(incoming, false)).toBeNull();
    for (const scope of [null, {}, { sharedTaskId: 'task', target: { role: 'host' } }, { ...incoming.sharedTask, source: { role: 'host' } }]) {
      expect(decode({ ...incoming, sharedTask: scope as Envelope['sharedTask'] }, true)).toBeNull();
    }
  });
  it('correlates relay failures to the scope, not to the physical host alone', () => {
    const error: Envelope = { v: PROTOCOL_VERSION, kind: 'relay-error', id: 'request', payload: { code: 'DEVICE_OFFLINE', message: 'offline', dst: 'desktop' }, sharedTask: { sharedTaskId: 'task', target: { role: 'host' } } };
    expect(decode(error, true)?.payload).toEqual({ code: 'DEVICE_OFFLINE', message: 'offline', dst: sharedTaskHostPeer('task', 'desktop') });
    expect(decode({ ...error, sharedTask: undefined, payload: { ...error.payload as object, dst: sharedTaskHostPeer('task', 'desktop') } }, true)).toBeNull();
  });
});
