import { describe, expect, it } from 'vitest';

import { isImSchedulerFrame } from '../protocol';

describe('Discord scheduler protocol', () => {
  it('accepts minimal non-secret Discord advertisements', () => {
    expect(isImSchedulerFrame({
      kind: 'advertisement',
      sentAt: 1,
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
    })).toBe(true);
    expect(isImSchedulerFrame({
      kind: 'advertisement',
      sentAt: 1,
      channels: [],
      inReplyTo: '1234567890abcdef',
    })).toBe(true);
    expect(isImSchedulerFrame({
      kind: 'probe',
      sentAt: 1,
      nonce: '1234567890abcdef',
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
    })).toBe(true);
  });

  it('rejects other channels, secrets, and malformed Discord identities', () => {
    expect(isImSchedulerFrame({ kind: 'request', requestId: 'r1' })).toBe(false);
    expect(isImSchedulerFrame({ kind: 'probe', sentAt: 1, nonce: 'short', channels: [] })).toBe(false);
    expect(isImSchedulerFrame({
      kind: 'advertisement',
      sentAt: 1,
      channels: [{ channel: 'telegram', identity: '12345678901234567' }],
    })).toBe(false);
    expect(isImSchedulerFrame({
      kind: 'advertisement',
      sentAt: 1,
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
      token: 'must-not-cross-device-link',
    })).toBe(false);
    expect(isImSchedulerFrame({
      kind: 'advertisement',
      sentAt: 1,
      channels: [{ channel: 'discord', identity: '12345678901234567.secret' }],
    })).toBe(false);
    expect(isImSchedulerFrame({
      kind: 'advertisement',
      sentAt: 1,
      channels: [
        { channel: 'discord', identity: '12345678901234567' },
        { channel: 'discord', identity: '12345678901234568' },
      ],
    })).toBe(false);
  });
});
