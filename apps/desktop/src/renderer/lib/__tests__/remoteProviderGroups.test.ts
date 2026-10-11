/**
 * 远程供应商列表里的供应商组(provider-groups.md §10)：其他在线电脑的组里的电脑与分享收起，
 * 组所在电脑那一项标成供应商组。
 */
import type { ProviderView } from '@cindy/model-providers';
import { describe, expect, it } from 'vitest';

import { collectRemoteProviderGroups, remoteProviderEntryKey } from '../remoteProviderGroups';

function provider(id: string, extra: Record<string, unknown> = {}): ProviderView {
  return { id, name: id, agents: ['claude-code'], connected: true, remoteInvocationEnabled: true, models: {}, routing: {}, ...extra } as unknown as ProviderView;
}

function group(members: Array<Record<string, unknown>>) {
  return { strategy: 'least', autoSwitch: true, members: [{ kind: 'local' }, ...members] };
}

describe('collectRemoteProviderGroups', () => {
  it('hides the computers and shares in another computer’s group and marks the group entry', () => {
    const result = collectRemoteProviderGroups([
      {
        deviceId: 'mini',
        providers: [provider('anthropic', {
          group: group([
            { kind: 'device', agentDeviceId: 'studio', providerId: 'anthropic-1a2b3c4d' },
            { kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic' },
          ]),
        })],
      },
      { deviceId: 'studio', providers: [provider('anthropic-1a2b3c4d'), provider('openai')] },
    ]);
    expect([...result.hidden].sort()).toEqual([
      remoteProviderEntryKey('share:s1', 'anthropic'),
      remoteProviderEntryKey('studio', 'anthropic-1a2b3c4d'),
    ].sort());
    expect(result.groups.get(remoteProviderEntryKey('mini', 'anthropic'))?.members).toHaveLength(3);
    expect(result.hidden.has(remoteProviderEntryKey('studio', 'openai'))).toBe(false);
  });

  it('keeps both groups when two groups contain each other', () => {
    const result = collectRemoteProviderGroups([
      { deviceId: 'mini', providers: [provider('anthropic', { group: group([{ kind: 'device', agentDeviceId: 'studio', providerId: 'anthropic' }]) })] },
      { deviceId: 'studio', providers: [provider('anthropic', { group: group([{ kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic' }, { kind: 'device', agentDeviceId: 'laptop', providerId: 'anthropic' }]) })] },
    ]);
    expect([...result.hidden]).toEqual([remoteProviderEntryKey('laptop', 'anthropic')]);
    expect(result.groups.size).toBe(2);
  });

  it('collapses every member into its group, including the one the task runs on, and says which group it is in', () => {
    // 2026-10-11：任务被组换到 grok-bot-vm 上运行后，那台不再单独出现，归在 Mac mini 的组那一项下。
    const result = collectRemoteProviderGroups([
      { deviceId: 'mini', providers: [provider('anthropic', { group: group([
        { kind: 'device', agentDeviceId: 'vm-1', providerId: 'anthropic' },
        { kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic' },
      ]) })] },
      { deviceId: 'vm-1', providers: [provider('anthropic'), provider('fp')] },
    ]);
    expect(result.hidden.has(remoteProviderEntryKey('vm-1', 'anthropic'))).toBe(true);
    expect(result.memberOf.get(remoteProviderEntryKey('vm-1', 'anthropic'))).toEqual({ deviceId: 'mini', providerId: 'anthropic' });
    expect(result.memberOf.get(remoteProviderEntryKey('share:s1', 'anthropic'))).toEqual({ deviceId: 'mini', providerId: 'anthropic' });
    expect(result.hidden.has(remoteProviderEntryKey('vm-1', 'fp'))).toBe(false);
  });

  it('also hides the remote members of groups this computer created', () => {
    const local = {
      strategy: 'least' as const,
      autoSwitch: true,
      members: [
        { key: 'local', kind: 'local' as const, agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false },
        { key: 'device:studio:anthropic', kind: 'device' as const, agentDeviceId: 'studio', providerId: 'anthropic', limit: 4, weight: 1, paused: false },
      ],
    };
    const result = collectRemoteProviderGroups([{ deviceId: 'studio', providers: [provider('anthropic')] }], { anthropic: local });
    expect([...result.hidden]).toEqual([remoteProviderEntryKey('studio', 'anthropic')]);
    // 组那一项是这台电脑自己的供应商(本机那一栏)。
    expect(result.memberOf.get(remoteProviderEntryKey('studio', 'anthropic'))).toEqual({ deviceId: null, providerId: 'anthropic' });
    expect(result.groups.size).toBe(0);
  });

  it('ignores groups on providers not open for remote use and malformed summaries', () => {
    const result = collectRemoteProviderGroups([
      { deviceId: 'mini', providers: [
        provider('anthropic', { remoteInvocationEnabled: false, group: group([{ kind: 'device', agentDeviceId: 'studio', providerId: 'a' }]) }),
        provider('openai', { group: { members: 'nope' } }),
      ] },
    ]);
    expect(result.hidden.size).toBe(0);
    expect(result.groups.size).toBe(0);
  });
});
