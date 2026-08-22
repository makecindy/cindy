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
      runtime: {
        identity: '12345678901234567',
        generation: 'a'.repeat(32),
        state: 'active',
        predecessor: 'b'.repeat(32),
      },
      inReplyTo: '1234567890abcdef',
    })).toBe(true);
    expect(isImSchedulerFrame({
      kind: 'advertisement',
      sentAt: 1,
      channels: [],
      runtimeGaps: [
        {
          identity: '12345678901234567',
          generation: 'c'.repeat(32),
          state: 'dirty',
        },
        {
          identity: '12345678901234567',
          generation: 'd'.repeat(32),
          state: 'dirty',
        },
      ],
    })).toBe(true);
    expect(isImSchedulerFrame({
      kind: 'probe',
      sentAt: 1,
      nonce: '1234567890abcdef',
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
      runtimeGaps: [
        {
          identity: '12345678901234567',
          generation: 'c'.repeat(32),
          state: 'dirty',
        },
      ],
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
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
      runtime: {
        identity: '12345678901234567',
        generation: 'not-a-generation',
        state: 'dirty',
      },
    })).toBe(false);
    expect(isImSchedulerFrame({
      kind: 'advertisement',
      sentAt: 1,
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
      runtime: {
        identity: '12345678901234567',
        generation: 'a'.repeat(32),
        state: { toString: () => 'active' },
      },
    })).toBe(false);
    expect(isImSchedulerFrame({
      kind: 'probe',
      sentAt: 1,
      nonce: '1234567890abcdef',
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
      runtime: {
        identity: '12345678901234567',
        generation: 'a'.repeat(32),
        state: 'clean',
        predecessor: 'b'.repeat(32),
      },
    })).toBe(false);
    expect(isImSchedulerFrame({
      kind: 'advertisement',
      sentAt: 1,
      channels: [
        { channel: 'discord', identity: '12345678901234567' },
        { channel: 'discord', identity: '12345678901234568' },
      ],
    })).toBe(false);
    expect(isImSchedulerFrame({
      kind: 'advertisement',
      sentAt: 1,
      channels: [],
      runtimeGaps: [
        {
          identity: '12345678901234567',
          generation: 'c'.repeat(32),
          state: 'active',
        },
      ],
    })).toBe(false);
    expect(isImSchedulerFrame({
      kind: 'advertisement',
      sentAt: 1,
      channels: [],
      runtimeGaps: [
        {
          identity: '12345678901234567',
          generation: 'c'.repeat(32),
          state: 'dirty',
        },
        {
          identity: '12345678901234567',
          generation: 'c'.repeat(32),
          state: 'dirty',
        },
      ],
    })).toBe(false);
  });
});
