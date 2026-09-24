import { sharedTaskHostPeer } from '../protocol.js';
import { describe, expect, it } from 'vitest';
import {
  authorizeSharedTaskOperation as authorize,
  parseSharedTaskSnapshot as parse,
  isSharedTaskAttachment, sharedTaskTopics,
} from '../sharedTask.js';
import { buildAttachmentOssRef } from '../attachmentOssRef.js';

const snapshot = () => ({
  sharedTaskId: 'sharedTask-1', sessionId: 'session-1', ownerAccountId: 'owner', hostDeviceId: 'desktop',
  status: 'active', revision: 1,
  guests: [
    { memberId: 'member-a', accountId: 'guest-a', version: 1, deviceIds: ['phone-a', 'desktop-a'] },
    { memberId: 'member-b', accountId: 'guest-b', version: 1, deviceIds: ['phone-b'] },
  ],
});
const guest = { accountId: 'guest-a', deviceId: 'phone-a' };
const owner = { accountId: 'owner', deviceId: 'owner-phone' };

describe('sharedTask authorization', () => {
  it('preserves extended device IDs and still requires the matching account', () => {
    const value = snapshot();
    value.hostDeviceId = '房主~desktop';
    value.guests[0].deviceIds = [' 手机~1 '];
    const parsed = parse(value);
    expect(parsed.hostDeviceId).toBe(value.hostDeviceId);
    expect(authorize(parsed, { accountId: 'guest-a', deviceId: ' 手机~1 ' }, 'session-1', 'history.read').allowed).toBe(true);
    expect(authorize(parsed, { accountId: 'guest-b', deviceId: ' 手机~1 ' }, 'session-1', 'history.read').allowed).toBe(false);
  });
  it('keeps task subscriptions but removes the full-device list from shared peers', () => {
    expect(sharedTaskTopics(sharedTaskHostPeer('shared', 'desktop'), ['sessions', 'session:task'])).toEqual(['session:task']);
    expect(sharedTaskTopics('my-desktop', ['sessions', 'session:task'])).toEqual(['sessions', 'session:task']);
  });
  it('only permits attachment references in this sharing namespace', () => {
    const ref = (ossKey: string) => buildAttachmentOssRef({ ossKey, originalName: 'image.png', mimeType: 'image/png', size: 1, sha256: 'a'.repeat(64) });
    expect(isSharedTaskAttachment(ref('cindy/device-link/shared-task/shared/u/file.png'), 'shared')).toBe(true);
    for (const key of [
      'cindy/device-link/shared-task/other/u/file.png',
      'cindy/device-link/u/file.png',
      'cindy/device-link/shared-task/file.png',
      'cindy/device-link/shared-task/shared/u/../file.png',
      'cindy/device-link/shared-task/shared/u/%2e%2e',
      'cindy/device-link/shared-task/shared/u',
      'cindy/shared-task/shared/u/file.png',
    ]) {
      expect(isSharedTaskAttachment(ref(key), 'shared')).toBe(false);
    }
    expect(isSharedTaskAttachment('file:///private/file.png', 'shared')).toBe(false);
  });
  it.each(['history.read', 'attachment.read', 'attachment.upload', 'input.send', 'agent.configure', 'agent.stop'])(
    'lets an approved guest %s without treating them as the owner', (operation) => {
      expect(authorize(parse(snapshot()), guest, 'session-1', operation)).toMatchObject({ allowed: true, role: 'guest', memberId: 'member-a' });
    },
  );
  it.each(['approval.resolve', 'permission.configure', 'workdir.configure', 'plugins.configure',
    'history.delete', 'session.archive', 'session.export', 'session.fork', 'background.create', 'schedule.create', 'sharedTask.manage'])(
    'requires the owner for %s even when a guest can configure the model', (operation) => {
      expect(authorize(parse(snapshot()), guest, 'session-1', operation)).toEqual({ allowed: false, reason: 'owner-required' });
      expect(authorize(parse(snapshot()), owner, 'session-1', operation)).toMatchObject({ allowed: true, role: 'host' });
    },
  );
  it('does not authorize a different task, unapproved device, or swapped account', () => {
    const state = parse(snapshot());
    expect(authorize(state, guest, 'session-2', 'history.read').allowed).toBe(false);
    expect(authorize(state, { ...guest, deviceId: 'phone-b' }, 'session-1', 'history.read').allowed).toBe(false);
    expect(authorize(state, { ...guest, accountId: 'stranger' }, 'session-1', 'history.read').allowed).toBe(false);
    expect(authorize(state, owner, 'session-2', 'history.read').allowed).toBe(false);
  });
  it('denies unknown operations including toString rather than inheriting object properties', () => {
    for (const operation of ['toString', '__proto__', 'approval.auto', 'shell.execute']) {
      expect(authorize(parse(snapshot()), owner, 'session-1', operation)).toEqual({ allowed: false, reason: 'unknown-operation' });
    }
  });
  it.each(['input.edit', 'input.withdraw'])('checks authoritative ownership and pending state for %s', (operation) => {
    const state = parse(snapshot());
    const item = { sessionId: 'session-1', authorAccountId: 'guest-b', state: 'pending' as const };
    expect(authorize(state, guest, 'session-1', operation, item).allowed).toBe(false);
    expect(authorize(state, owner, 'session-1', operation, item).allowed).toBe(true);
    expect(authorize(state, guest, 'session-1', operation, { ...item, authorAccountId: 'guest-a' }).allowed).toBe(true);
    expect(authorize(state, owner, 'session-1', operation, { ...item, state: 'accepted' }).allowed).toBe(false);
    expect(authorize(state, owner, 'session-1', operation, { ...item, sessionId: 'session-2' }).allowed).toBe(false);
    expect(authorize(state, owner, 'session-1', operation).allowed).toBe(false);
  });
  it('closed and not-yet-loaded sharedTasks cannot authorize their owner or guests', () => {
    for (const actor of [guest, owner]) {
      expect(authorize(null, actor, 'session-1', 'history.read').allowed).toBe(false);
      expect(authorize(parse({ ...snapshot(), status: 'closed' }), actor, 'session-1', 'history.read').allowed).toBe(false);
    }
  });
});

describe('sharedTask authority decoding', () => {
  it('projects unknown fields, copies and freezes nested device grants', () => {
    const input = snapshot();
    const parsed = parse({ ...input, token: 'invalid-fixture-secret', role: 'host' });
    input.guests[0].deviceIds.push('attacker-device');
    expect(parsed).not.toHaveProperty('token');
    expect(parsed).not.toHaveProperty('role');
    expect(parsed.guests[0].deviceIds).not.toContain('attacker-device');
    expect(Object.isFrozen(parsed.guests[0].deviceIds)).toBe(true);
    expect(Object.isFrozen(parsed.guests)).toBe(true);
  });
  it.each([0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1'])(
    'rejects ambiguous revisions %s', (revision) => expect(() => parse({ ...snapshot(), revision })).toThrow(),
  );
  it('rejects duplicate accounts, members and device identities', () => {
    for (const patch of [
      { accountId: 'owner' }, { accountId: 'guest-a' }, { memberId: 'member-a' },
      { deviceIds: ['phone-b', 'phone-b'] },
    ]) {
      const input = snapshot();
      input.guests[1] = { ...input.guests[1], ...patch };
      expect(() => parse(input)).toThrow();
    }
  });
  it('scopes colliding device claims by authenticated account', () => {
    const input = snapshot();
    input.guests[1].deviceIds = ['phone-a', input.hostDeviceId];
    const parsed = parse(input);
    expect(authorize(parsed, { accountId: 'guest-b', deviceId: 'phone-a' }, 'session-1', 'history.read'))
      .toMatchObject({ allowed: true, memberId: 'member-b' });
    expect(authorize(parsed, { accountId: 'outsider', deviceId: 'phone-a' }, 'session-1', 'history.read').allowed).toBe(false);
  });
  it('counts members by account while permitting multiple devices for a member', () => {
    expect(parse(snapshot()).guests).toHaveLength(2);
    const input = snapshot();
    input.guests.push(
      { memberId: 'member-c', accountId: 'guest-c', version: 1, deviceIds: [] },
      { memberId: 'member-d', accountId: 'guest-d', version: 1, deviceIds: [] },
    );
    expect(() => parse(input)).toThrow();
  });
});
