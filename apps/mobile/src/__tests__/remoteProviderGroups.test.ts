/**
 * 手机模型列表里的供应商组(provider-groups.md §10，与桌面 remoteProviderGroups 同口径)：组里其他电脑上的这个供应商
 * 收进组那一项，被控电脑自己的照常显示；任务归哪个组由被控电脑回答。
 */
import type { ProviderView } from '@cindy/model-providers/registry';
import { describe, expect, it } from 'vitest';

import {
  collectMobileProviderGroups,
  parseSessionProviderGroup,
  providerGroupEntryKey,
} from '@/session/remoteProviderGroups';

const provider = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, models: {}, connected: true, remoteInvocationEnabled: true, ...extra }) as unknown as ProviderView;
const summary = (owner: string, members: Array<{ kind: string; agentDeviceId: string | null; providerId: string; hostDeviceId?: string }>) => ({
  group: {
    strategy: 'least',
    autoSwitch: true,
    members: [
      { key: 'local', kind: 'local', agentDeviceId: null, providerId: owner, paused: false },
      ...members.map((m) => ({ key: `${m.kind}:${m.agentDeviceId}:${m.providerId}`, ...m, paused: false })),
    ],
  },
});

describe('collectMobileProviderGroups', () => {
  it('folds members of another computer’s group into the group entry', () => {
    const groups = collectMobileProviderGroups({
      hostDeviceId: 'host',
      hostProviders: [provider('account')],
      catalogs: [
        {
          deviceId: 'mini',
          providers: [provider('anthropic', summary('anthropic', [
            { kind: 'device', agentDeviceId: 'vm', providerId: 'anthropic-9z' },
            // 被控电脑自己的供应商在组里也照常显示，不收起。
            { kind: 'device', agentDeviceId: 'host', providerId: 'account' },
            { kind: 'share', agentDeviceId: 'share:abc', providerId: 'claude' },
          ]))],
        },
        { deviceId: 'vm', providers: [provider('anthropic-9z'), provider('fp')] },
      ],
    });
    expect([...groups.hidden].sort()).toEqual([
      providerGroupEntryKey('share:abc', 'claude'),
      providerGroupEntryKey('vm', 'anthropic-9z'),
    ].sort());
    expect(groups.memberOf.get(providerGroupEntryKey('vm', 'anthropic-9z'))).toEqual({ deviceId: 'mini', providerId: 'anthropic' });
    expect(groups.sizes.get(providerGroupEntryKey('mini', 'anthropic'))).toBe(4);
    expect(groups.hidden.has(providerGroupEntryKey(null, 'account'))).toBe(false);
  });

  it('counts computers, not accounts, when one computer has several accounts in the group', () => {
    const groups = collectMobileProviderGroups({
      hostDeviceId: 'host',
      hostProviders: [],
      catalogs: [
        {
          deviceId: 'mini',
          providers: [provider('anthropic', summary('anthropic', [
            { kind: 'device', agentDeviceId: 'vm', providerId: 'anthropic-a' },
            { kind: 'device', agentDeviceId: 'vm', providerId: 'anthropic-b' },
            { kind: 'device', agentDeviceId: 'vm', providerId: 'anthropic-c' },
            // 同一个人从同一台电脑分享的两个账号算一台；还没记下那台电脑的分享按分享各算一台。
            { kind: 'share', agentDeviceId: 'share:s1', providerId: 'claude', hostDeviceId: 'kai-pc' },
            { kind: 'share', agentDeviceId: 'share:s2', providerId: 'claude-b', hostDeviceId: 'kai-pc' },
            { kind: 'share', agentDeviceId: 'share:s-special', providerId: 'claude-c', hostDeviceId: 'phone~1' },
            { kind: 'share', agentDeviceId: 'share:s3', providerId: 'claude' },
          ]))],
        },
      ],
    });
    // 组所在电脑 + vm(三个账号) + Kai 的那台(两个分享) + 旧的一个分享 = 4 台电脑；账号仍各自收进组那一项。
    expect(groups.sizes.get(providerGroupEntryKey('mini', 'anthropic'))).toBe(5);
    expect(groups.hidden.has(providerGroupEntryKey('share:s2', 'claude-b'))).toBe(true);
    expect(['anthropic-a', 'anthropic-b', 'anthropic-c']
      .every((id) => groups.hidden.has(providerGroupEntryKey('vm', id)))).toBe(true);
  });

  it('labels the controlled computer’s own group and shared groups, and keeps entries that carry a group', () => {
    const groups = collectMobileProviderGroups({
      hostDeviceId: 'host',
      hostProviders: [provider('account', summary('account', [{ kind: 'device', agentDeviceId: 'vm', providerId: 'anthropic-9z' }]))],
      catalogs: [
        // vm 自己也建了组：本身带组的项不收起(两个组互相包含时两个组都还在)。
        { deviceId: 'vm', providers: [provider('anthropic-9z', summary('anthropic-9z', [{ kind: 'device', agentDeviceId: 'host', providerId: 'account' }]))] },
        { deviceId: 'share:abc', providers: [provider('claude', { groupSize: 3 })] },
      ],
    });
    expect(groups.sizes.get(providerGroupEntryKey(null, 'account'))).toBe(2);
    expect(groups.sizes.get(providerGroupEntryKey('share:abc', 'claude'))).toBe(3);
    expect(groups.hidden.size).toBe(0);
  });

  it('ignores groups of providers closed to remote use and malformed summaries', () => {
    const groups = collectMobileProviderGroups({
      hostDeviceId: 'host',
      hostProviders: [],
      catalogs: [{
        deviceId: 'mini',
        providers: [
          provider('closed', { remoteInvocationEnabled: false, ...summary('closed', [{ kind: 'device', agentDeviceId: 'vm', providerId: 'a' }]) }),
          provider('broken', { group: { members: 'nope' } }),
          provider('mixed', { group: { members: [{ kind: 'share', agentDeviceId: 'vm', providerId: 'a' }, { kind: 'device', agentDeviceId: 'vm', providerId: 'b' }] } }),
        ],
      }],
    });
    expect([...groups.hidden]).toEqual([providerGroupEntryKey('vm', 'b')]);
    expect(groups.sizes.has(providerGroupEntryKey('mini', 'closed'))).toBe(false);
    expect(groups.sizes.has(providerGroupEntryKey('mini', 'broken'))).toBe(false);
  });
});

describe('parseSessionProviderGroup', () => {
  it('maps the controlled computer’s answer onto the picker’s positions', () => {
    expect(parseSessionProviderGroup({ group: { groupDeviceId: 'mini', providerId: 'anthropic' } }, 'host'))
      .toEqual({ deviceId: 'mini', providerId: 'anthropic' });
    // 组建在被控电脑自己身上。
    expect(parseSessionProviderGroup({ group: { groupDeviceId: null, providerId: 'account' } }, 'host'))
      .toEqual({ deviceId: null, providerId: 'account' });
    expect(parseSessionProviderGroup({ group: { groupDeviceId: 'host', providerId: 'account' } }, 'host'))
      .toEqual({ deviceId: null, providerId: 'account' });
  });

  it('treats old computers and malformed answers as not in a group', () => {
    for (const raw of [undefined, null, {}, { group: null }, [], { group: { providerId: '../x' } },
      { group: { groupDeviceId: 'a b', providerId: 'x' } }, { group: { groupDeviceId: 7, providerId: 'x' } }]) {
      expect(parseSessionProviderGroup(raw, 'host')).toBeNull();
    }
  });
});
