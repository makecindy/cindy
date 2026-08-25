import { describe, expect, it } from 'vitest';

import { selectIngressDevice } from '../state';

describe('Discord scheduler state', () => {
  it('selects one deterministic Desktop ingress for the same Discord identity', () => {
    const devices = [
      { deviceId: 'z', online: true, platform: 'darwin', channels: [{ channel: 'discord' as const, identity: 'bot-1' }], lastSeenAt: 1 },
      { deviceId: 'a', online: true, platform: 'win32', channels: [{ channel: 'discord' as const, identity: 'bot-1' }], lastSeenAt: 2 },
      { deviceId: 'phone', online: true, platform: 'ios', channels: [{ channel: 'discord' as const, identity: 'bot-1' }], lastSeenAt: 3 },
    ];

    expect(selectIngressDevice('discord', 'bot-1', devices)).toBe('a');
  });

  it('ignores offline, non-Desktop, and different-identity devices', () => {
    const devices = [
      { deviceId: 'offline', online: false, platform: 'darwin', channels: [{ channel: 'discord' as const, identity: 'bot-1' }], lastSeenAt: 1 },
      { deviceId: 'other', online: true, platform: 'linux', channels: [{ channel: 'discord' as const, identity: 'bot-2' }], lastSeenAt: 2 },
      { deviceId: 'phone', online: true, platform: 'ios', channels: [{ channel: 'discord' as const, identity: 'bot-1' }], lastSeenAt: 3 },
    ];

    expect(selectIngressDevice('discord', 'bot-1', devices)).toBeNull();
  });
});
