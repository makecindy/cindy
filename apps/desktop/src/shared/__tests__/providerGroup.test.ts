/**
 * 供应商组设置的校正(存储读取与 IPC 写入共用)：坏形态清洗、范围收敛、去重与「没有组内电脑即没有组」。
 */
import { describe, expect, it } from 'vitest';

import {
  PROVIDER_GROUP_DEFAULT_LIMIT,
  PROVIDER_GROUP_MAX_LIMIT,
  normalizeProviderGroupConfig,
  providerGroupMemberKey,
} from '../providerGroup';

describe('providerGroupMemberKey', () => {
  it('keys the local member, same-account devices and received shares separately', () => {
    expect(providerGroupMemberKey(null, 'anthropic')).toBe('local');
    expect(providerGroupMemberKey('dev-1', 'anthropic-1a2b3c4d')).toBe('device:dev-1:anthropic-1a2b3c4d');
    expect(providerGroupMemberKey('share:abc', 'anthropic')).toBe('share:abc:anthropic');
  });
});

describe('normalizeProviderGroupConfig', () => {
  it('keeps valid members, fills defaults and pins the local member to the group provider', () => {
    const config = normalizeProviderGroupConfig({
      strategy: 'round',
      members: [
        { kind: 'local', providerId: 'something-else', limit: 2 },
        { kind: 'device', agentDeviceId: 'dev-1', providerId: 'anthropic-1a2b3c4d', label: ' Studio ' },
        { kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic', paused: true, weight: 3 },
      ],
    }, 'anthropic');
    expect(config).toEqual({
      strategy: 'round',
      autoSwitch: true,
      members: [
        { key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 2, weight: 1, paused: false },
        {
          key: 'device:dev-1:anthropic-1a2b3c4d',
          kind: 'device',
          agentDeviceId: 'dev-1',
          providerId: 'anthropic-1a2b3c4d',
          label: 'Studio',
          limit: PROVIDER_GROUP_DEFAULT_LIMIT,
          weight: 1,
          paused: false,
        },
        {
          key: 'share:s1:anthropic',
          kind: 'share',
          agentDeviceId: 'share:s1',
          providerId: 'anthropic',
          limit: PROVIDER_GROUP_DEFAULT_LIMIT,
          weight: 3,
          paused: true,
        },
      ],
    });
  });

  it('drops malformed members, mismatched device kinds and duplicates; clamps limits', () => {
    const config = normalizeProviderGroupConfig({
      strategy: 'bogus',
      autoSwitch: false,
      members: [
        { kind: 'device', agentDeviceId: 'share:s1', providerId: 'x' },
        { kind: 'share', agentDeviceId: 'dev-1', providerId: 'x' },
        { kind: 'device', agentDeviceId: 'dev-1', providerId: 'bad id' },
        { kind: 'device', agentDeviceId: 'dev-1', providerId: 'x', limit: 999 },
        { kind: 'device', agentDeviceId: 'dev-1', providerId: 'x', limit: 1 },
        'junk',
      ],
    }, 'x');
    expect(config?.strategy).toBe('least');
    expect(config?.autoSwitch).toBe(false);
    expect(config?.members).toHaveLength(1);
    expect(config?.members[0].limit).toBe(PROVIDER_GROUP_MAX_LIMIT);
  });

  it('returns null when nothing is left: removing the last member deletes the group', () => {
    expect(normalizeProviderGroupConfig({ strategy: 'least', members: [] }, 'anthropic')).toBeNull();
    expect(normalizeProviderGroupConfig(null, 'anthropic')).toBeNull();
    expect(normalizeProviderGroupConfig({ members: [{ kind: 'local' }] }, 'bad id')).toBeNull();
  });
});
