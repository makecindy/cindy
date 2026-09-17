import { describe, expect, it } from 'vitest';
import type { SessionMeetingQueueItem } from '@cindy/device-link';
import { SessionMeetingAccess } from '../sessionMeetingAccess';

const identity = { meetingId: 'meeting-1', sessionId: 'task-1', ownerAccountId: 'owner', hostDeviceId: 'host' };
const a = { memberId: 'member-a', accountId: 'account-a', version: 1, deviceIds: ['device-a'] };
const b = { memberId: 'member-b', accountId: 'account-b', version: 1, deviceIds: ['device-b'] };
const caller = { accountId: a.accountId, deviceId: a.deviceIds[0] };
const snapshot = (revision = 1, guests = [a, b]) => ({ ...identity, revision, status: 'active', guests });
const loaded = () => {
  const access = new SessionMeetingAccess(identity);
  access.applyVerifiedSnapshot(snapshot());
  return access;
};

describe('task host meeting authority', () => {
  it('revokes queued delivery after removal and ignores an older snapshot', () => {
    const access = loaded();
    const ticket = access.capture(caller, 'task-1', 'history.read');
    expect(ticket.isCurrent()).toBe(true);
    access.applyVerifiedSnapshot(snapshot(2, [b]));
    expect(access.applyVerifiedSnapshot(snapshot(1))).toBe(false);
    expect(ticket.isCurrent()).toBe(false);
    expect(() => access.applyVerifiedSnapshot(snapshot(3))).toThrow('Revoked');
    const fresh = { ...a, memberId: 'member-a-new' };
    access.applyVerifiedSnapshot(snapshot(3, [fresh, b]));
    expect(ticket.isCurrent()).toBe(false);
    expect(access.capture(caller, 'task-1', 'history.read').isCurrent()).toBe(true);
  });
  it('changing one guest does not cancel another guest or the owner', () => {
    const access = loaded();
    const ticket = access.capture(caller, 'task-1', 'input.send');
    const owner = access.capture({ accountId: 'owner', deviceId: 'owner-phone' }, 'task-1', 'approval.resolve');
    access.applyVerifiedSnapshot(snapshot(2, [a]));
    expect(ticket.isCurrent()).toBe(true);
    expect(owner.isCurrent()).toBe(true);
  });
  it('is isolated between two meetings shared by the same guest device', () => {
    const access = loaded();
    const otherIdentity = { ...identity, meetingId: 'meeting-2', sessionId: 'task-2' };
    const other = new SessionMeetingAccess(otherIdentity);
    other.applyVerifiedSnapshot({ ...snapshot(), ...otherIdentity });
    const second = other.capture(caller, 'task-2', 'history.read');
    access.close();
    expect(second.isCurrent()).toBe(true);
  });
  it('cannot revive after local close or account logout even with a higher revision', () => {
    const access = loaded();
    const ticket = access.capture(caller, 'task-1', 'attachment.read');
    access.close();
    expect(access.applyVerifiedSnapshot(snapshot(50))).toBe(false);
    expect(ticket.isCurrent()).toBe(false);
  });
  it('refuses reopening a server-closed meeting under its original ID', () => {
    const access = loaded();
    access.applyVerifiedSnapshot({ ...snapshot(2), status: 'closed' });
    expect(() => access.applyVerifiedSnapshot(snapshot(3))).toThrow('cannot reopen');
  });
  it('does not silently replace a different scope or a conflicting revision', () => {
    const access = loaded();
    for (const key of Object.keys(identity)) {
      expect(() => access.applyVerifiedSnapshot({ ...snapshot(2), [key]: 'different' })).toThrow('scope');
    }
    expect(() => access.applyVerifiedSnapshot(snapshot(1, [b]))).toThrow('Conflicting');
    expect(access.applyVerifiedSnapshot(snapshot(1, [b, a]))).toBe(false);
  });
  it('invalidates old delivery when a device grant changes', () => {
    const access = loaded();
    const ticket = access.capture(caller, 'task-1', 'history.read');
    expect(() => access.applyVerifiedSnapshot(snapshot(2, [{ ...a, deviceIds: ['device-a', 'device-c'] }, b]))).toThrow('revision');
    access.applyVerifiedSnapshot(snapshot(2, [{ ...a, version: 2 }, b]));
    expect(ticket.isCurrent()).toBe(false);
  });
  it('rereads pending status and snapshots caller identity across an await', () => {
    const access = loaded();
    let item: SessionMeetingQueueItem = { sessionId: 'task-1', authorAccountId: 'account-a', state: 'pending' };
    const mutableCaller = { ...caller };
    const ticket = access.capture(mutableCaller, 'task-1', 'input.edit', () => item);
    mutableCaller.accountId = 'owner';
    item = { ...item, authorAccountId: 'account-b' };
    expect(ticket.isCurrent()).toBe(false);
    item = { ...item, authorAccountId: 'account-a', state: 'accepted' };
    expect(ticket.isCurrent()).toBe(false);
  });
});
