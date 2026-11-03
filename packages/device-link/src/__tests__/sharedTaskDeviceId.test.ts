import { describe, expect, it } from 'vitest';
import { sharedTaskDeviceId, parseSharedTaskScope } from '@cindy/device-link-protocol/protocol';

// Keep identical fixtures in both repositories' device-link tests.
describe('shared task wire scope and physical device domain', () => {
  it.each(['phone:1', '_legacy', ' device ', '设备/手机', 'phone~1', '%3A', '"quoted"', '\ud800', '\u0000'.repeat(128), 'x'.repeat(128), 'shared-task~task~host'])('round-trips the auth device domain: %j', deviceId => {
    expect(sharedTaskDeviceId(deviceId)).toBe(deviceId);
    const frame = { src: deviceId, dst: deviceId, sharedTask: { sharedTaskId: 'task', target: { role: 'host' }, source: { role: 'guest', memberId: 'member' } } };
    const decoded = JSON.parse(JSON.stringify(frame));
    expect(decoded).toEqual(frame);
    expect(parseSharedTaskScope(decoded.sharedTask, true)).toEqual(frame.sharedTask);
  });
  it('discards client-supplied source and extraneous fields', () => {
    expect(parseSharedTaskScope({ sharedTaskId: 'task', target: { role: 'host' }, source: { role: 'host' }, grant: 'forged' }))
      .toEqual({ sharedTaskId: 'task', target: { role: 'host' } });
  });
  it.each([null, [], {}, { sharedTaskId: 'task', target: { role: 'guest' } },
    { sharedTaskId: 'task', target: { role: 'host', memberId: 'member' } },
    { sharedTaskId: 'task', target: { role: 'host' }, source: { role: 'host' } },
    { sharedTaskId: '../task', target: { role: 'host' } }])('rejects invalid received scope %j', value => {
    expect(parseSharedTaskScope(value, true)).toBeNull();
  });
  it.each(['', 'x'.repeat(129), null, 1])('rejects an invalid device claim: %j', value => {
    expect(() => sharedTaskDeviceId(value)).toThrow();
  });
});
