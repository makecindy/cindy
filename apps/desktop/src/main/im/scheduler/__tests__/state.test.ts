import { describe, expect, it } from 'vitest';

import { compareSchedulerStrings, selectIngressDevice } from '../state';

describe('Discord scheduler election state', () => {
  it('orders scheduler values without consulting the process locale', () => {
    expect(compareSchedulerStrings('Z', 'a')).toBe(-1);
    expect(compareSchedulerStrings('a', 'Z')).toBe(1);
    expect(compareSchedulerStrings('same', 'same')).toBe(0);
  });

  it('selects the same deterministic Desktop regardless of input order', () => {
    const devices = [
      {
        deviceId: 'z',
        online: true,
        platform: 'darwin',
        channels: [{ channel: 'discord' as const, identity: '12345678901234567' }],
        lastSeenAt: 2,
      },
      {
        deviceId: 'a',
        online: true,
        platform: 'win32',
        channels: [{ channel: 'discord' as const, identity: '12345678901234567' }],
        lastSeenAt: 1,
      },
    ];
    expect(selectIngressDevice('discord', '12345678901234567', devices)).toBe('a');
    expect(selectIngressDevice('discord', '12345678901234567', [...devices].reverse())).toBe('a');
  });

  it('ignores offline, mobile, and differently configured devices', () => {
    expect(
      selectIngressDevice('discord', '12345678901234567', [
        {
          deviceId: 'offline',
          online: false,
          platform: 'darwin',
          channels: [{ channel: 'discord' as const, identity: '12345678901234567' }],
          lastSeenAt: 1,
        },
        {
          deviceId: 'phone',
          online: true,
          platform: 'ios',
          channels: [{ channel: 'discord' as const, identity: '12345678901234567' }],
          lastSeenAt: 1,
        },
        {
          deviceId: 'other',
          online: true,
          platform: 'linux',
          channels: [{ channel: 'discord' as const, identity: '76543210987654321' }],
          lastSeenAt: 1,
        },
      ]),
    ).toBeNull();
  });
});
