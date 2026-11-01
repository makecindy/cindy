/**
 * 供应商组设置的校正(存储读取与 IPC 写入共用)：坏形态清洗、范围收敛、去重与「没有组内电脑即没有组」。
 */
import { describe, expect, it } from 'vitest';

import {
  PROVIDER_GROUP_DEFAULT_LIMIT,
  PROVIDER_GROUP_MAX_LIMIT,
  normalizeProviderGroupConfig,
  providerGroupDeviceCount,
  providerGroupMemberKey,
  providerGroupSummaryForWire,
  parseProviderGroupRebalanceSuggestion,
  parseProviderGroupRemoteRequest,
  parseProviderGroupRemoteView,
  parseProviderGroupRemotePick,
} from '../providerGroup';

// Unit protocol: legacy or malformed quota hints cannot manufacture an automatic wait.
it.each([undefined, {}, { resetAtMs: '5000' }, { resetAtMs: -1 }, { resetAtMs: Infinity }])(
  'ignores unavailable replies without a valid quota hint: %j', (usageLimit) => {
    expect(parseProviderGroupRemotePick({ kind: 'unavailable', usageLimit }, 'anthropic')).toEqual({ kind: 'unavailable' });
  },
);

describe('group detail diagnostics compatibility', () => {
  it('round-trips a Fast prohibition and retains only a strict pending flag', () => {
    const config = normalizeProviderGroupConfig({ allowFast: false, members: [{ kind: 'local' }] }, 'openai')!;
    expect(providerGroupSummaryForWire(config).allowFast).toBe(false);
    expect(parseProviderGroupRemoteView({ config, members: [], fastPolicyPending: true }, 'openai')).toMatchObject({ config: { allowFast: false }, fastPolicyPending: true });
    expect(parseProviderGroupRemoteView({ config, members: [], fastPolicyPending: 'true' }, 'openai')).not.toHaveProperty('fastPolicyPending');
    expect(normalizeProviderGroupConfig({ members: [{ kind: 'local' }] }, 'openai')).not.toHaveProperty('allowFast');
  });
  const config = { members: [{ kind: 'local' }] };
  const payload = (extra: Record<string, unknown>) => ({ config, members: [{ key: 'local', state: 'available', ...extra }] });

  it('preserves explicit diagnostic requests and ignores malformed options', () => {
    expect(parseProviderGroupRemoteRequest({ action: 'view', providerId: 'anthropic', includeGuestSupport: true }))
      .toEqual({ action: 'view', providerId: 'anthropic', includeGuestSupport: true });
    expect(parseProviderGroupRemoteRequest({ action: 'view', providerId: 'anthropic', includeGuestSupport: 'true' }))
      .toEqual({ action: 'view', providerId: 'anthropic' });
  });

  it('retains valid optional versions and support without changing the ordinary state', () => {
    expect(parseProviderGroupRemoteView(payload({ appVersion: '0.1.104-beta', guestSupport: 'needs-update' }), 'anthropic').members[0])
      .toMatchObject({ appVersion: '0.1.104-beta', guestSupport: 'needs-update', state: 'available' });
  });

  it.each([{}, { appVersion: 1, guestSupport: true }, { appVersion: 'secret hostname', guestSupport: 'all-good' }, { appVersion: '1.2.3-' + 'a'.repeat(65) }])(
    'accepts old replies and drops malformed diagnostics: %j', (extra) => {
      const member = parseProviderGroupRemoteView(payload(extra), 'anthropic').members[0];
      expect(member.state).toBe('available');
      expect(member.appVersion).toBeUndefined();
      expect(member.guestSupport).toBeUndefined();
    },
  );

  // Unit protocol (protocol-compatibility.md 供应商组配额): the same-account `view` may carry one quota window
  // for the progress bar. Old owners omit it; malformed values must not draw a bar from invented numbers.
  it('keeps a valid quota window and clamps its percentage', () => {
    const week = 7 * 86_400_000;
    expect(parseProviderGroupRemoteView(payload({ quota: { usedPercent: 140, resetAtMs: 5_000, windowMs: week } }), 'anthropic')
      .members[0].quota).toEqual({ usedPercent: 100, resetAtMs: 5_000, windowMs: week });
    expect(parseProviderGroupRemoteView(payload({ quota: { usedPercent: 0, resetAtMs: null, windowMs: week } }), 'anthropic')
      .members[0].quota).toEqual({ usedPercent: 0, resetAtMs: null, windowMs: week });
  });

  // Unit protocol: confirmed exhaustion must survive remote viewing; old/malformed
  // replies must not turn a generic cooldown into a claim that the quota is spent.
  it('preserves confirmed quota exhaustion only for a cooling own-account member', () => {
    expect(parseProviderGroupRemoteView(payload({ state: 'cooling', usageLimit: { resetAtMs: 5_000 } }), 'anthropic')
      .members[0]).toMatchObject({ state: 'cooling', usageLimit: { resetAtMs: 5_000 } });
    expect(parseProviderGroupRemoteView(payload({ state: 'cooling', usageLimit: { resetAtMs: null } }), 'anthropic')
      .members[0].usageLimit).toEqual({ resetAtMs: null });
    for (const extra of [
      { state: 'cooling' }, { state: 'cooling', usageLimit: { resetAtMs: '5000' } },
      { state: 'cooling', usageLimit: { resetAtMs: -1 } }, { state: 'cooling', usageLimit: { resetAtMs: Infinity } },
      { usageLimit: { resetAtMs: 5_000 } },
    ]) {
      expect(parseProviderGroupRemoteView(payload(extra), 'anthropic').members[0]).not.toHaveProperty('usageLimit');
    }
    const shared = {
      config: { members: [{ kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic' }] },
      members: [{ key: 'share:s1:anthropic', state: 'cooling', usageLimit: { resetAtMs: 5_000 } }],
    };
    expect(parseProviderGroupRemoteView(shared, 'anthropic').members[0]).not.toHaveProperty('usageLimit');
  });

  it.each([
    'full', { usedPercent: '40', resetAtMs: 5_000, windowMs: 1 }, { usedPercent: 40, windowMs: 1 },
    { usedPercent: 40, resetAtMs: -1, windowMs: 1 }, { usedPercent: 40, resetAtMs: 5_000, windowMs: 0 },
    { usedPercent: 40, resetAtMs: 5_000, windowMs: 32 * 86_400_000 },
  ])('drops a malformed quota window: %j', (quota) => {
    expect(parseProviderGroupRemoteView(payload({ quota }), 'anthropic').members[0]).not.toHaveProperty('quota');
  });

  it('never takes a quota window for a shared-in computer', () => {
    const raw = {
      config: { members: [{ kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic' }] },
      members: [{ key: 'share:s1:anthropic', state: 'available', quota: { usedPercent: 40, resetAtMs: 5_000, windowMs: 1_000 } }],
    };
    expect(parseProviderGroupRemoteView(raw, 'anthropic').members[0]).not.toHaveProperty('quota');
  });
});

// Unit protocol (protocol-compatibility.md 供应商组任务进行中换号)：手机与远程控制经 `provider-group:remote` 问任务所在电脑
// 要不要换号、转达用户的选择。旧端不认识这两个动作(客户端按不提议处理)；被控端必须拒绝改不了组的坏请求，客户端不能
// 用编造的提议弹窗。
describe('switching accounts between messages', () => {
  const quota = { usedPercent: 20, resetAtMs: 5_000, windowMs: 7 * 86_400_000 };

  it('reads both requests and rejects a malformed choice', () => {
    expect(parseProviderGroupRemoteRequest({ action: 'rebalance-suggestion', sessionId: 's1' }))
      .toEqual({ action: 'rebalance-suggestion', sessionId: 's1' });
    expect(parseProviderGroupRemoteRequest({ action: 'rebalance-decision', sessionId: 's1', memberKey: 'device:mini:anthropic', remember: true }))
      .toEqual({ action: 'rebalance-decision', sessionId: 's1', memberKey: 'device:mini:anthropic', remember: true });
    for (const bad of [{ remember: 'true' }, { memberKey: 'a b' }, { memberKey: '' }]) {
      expect(() => parseProviderGroupRemoteRequest({
        action: 'rebalance-decision', sessionId: 's1', memberKey: 'device:mini:anthropic', remember: false, ...bad,
      })).toThrow();
    }
  });

  it('only turns a well-formed reply into a suggestion', () => {
    // 电脑名和账号名分别合法，组合名称不能让整条提议消失（review #6693）。
    const label = `${'D'.repeat(128)} · ${'A'.repeat(128)}`;
    expect(parseProviderGroupRebalanceSuggestion({ kind: 'ask', memberKey: 'local', label, quota })?.label).toBe(label);
    expect(parseProviderGroupRebalanceSuggestion({ kind: 'ask', memberKey: 'local', label: `${label}X`, quota })).toBeNull();
    expect(parseProviderGroupRebalanceSuggestion({ kind: 'auto', memberKey: 'device:mini:anthropic', label: 'Mini', quota }))
      .toEqual({ kind: 'auto', memberKey: 'device:mini:anthropic', label: 'Mini', quota });
    for (const raw of [null, { ok: false }, { kind: 'move', memberKey: 'local', label: 'Mini', quota },
      { kind: 'ask', memberKey: 'local', label: '', quota }, { kind: 'ask', memberKey: 'local', label: 'Mini', quota: { usedPercent: 20 } }]) {
      expect(parseProviderGroupRebalanceSuggestion(raw)).toBeNull();
    }
  });
});

describe('accounts on the same computer', () => {
  const raw = {
    members: [
      { kind: 'local' },
      { kind: 'device', agentDeviceId: 'vm', providerId: 'openai-a', providerName: ' GPT work ' },
      { kind: 'device', agentDeviceId: 'vm', providerId: 'openai-b', providerName: 'bad\u0007name' },
      { kind: 'share', agentDeviceId: 'share:s1', providerId: 'openai' },
    ],
  };

  it('counts each computer once however many of its accounts are in the group', () => {
    const config = normalizeProviderGroupConfig(raw, 'openai')!;
    expect(config.members).toHaveLength(4);
    expect(providerGroupDeviceCount(config.members)).toBe(3);
  });

  it('counts shares from the same computer of the sharer as one computer once that computer is known', () => {
    const shares = normalizeProviderGroupConfig({
      members: [
        { kind: 'local' },
        { kind: 'share', agentDeviceId: 'share:s1', providerId: 'openai', hostDeviceId: 'kai-pc' },
        { kind: 'share', agentDeviceId: 'share:s2', providerId: 'openai-b', hostDeviceId: 'kai-pc' },
        // 还没补记那台电脑的旧组员：按分享各算一台。
        { kind: 'share', agentDeviceId: 'share:s3', providerId: 'openai' },
        // 只有分享来的才记分享者那台电脑；设备 ID 是协议里的不透明值，允许任意字符。
        { kind: 'device', agentDeviceId: 'vm', providerId: 'openai', hostDeviceId: 'kai-pc' },
        { kind: 'share', agentDeviceId: 'share:s4', providerId: 'openai', hostDeviceId: 'phone:1' },
        { kind: 'share', agentDeviceId: 'share:s5', providerId: 'openai', hostDeviceId: ' ' },
      ],
    }, 'openai')!;
    expect(shares.members.map((m) => m.hostDeviceId)).toEqual([undefined, 'kai-pc', 'kai-pc', undefined, undefined, 'phone:1', ' ']);
    expect(providerGroupDeviceCount(shares.members)).toBe(6);
    expect(providerGroupSummaryForWire(shares).members.map((m) => m.hostDeviceId))
      .toEqual([undefined, 'kai-pc', 'kai-pc', undefined, undefined, 'phone:1', ' ']);
  });

  it('accepts the full shared-task host device id domain and rejects only empty or oversized values', () => {
    const config = normalizeProviderGroupConfig({
      members: [
        { kind: 'share', agentDeviceId: 'share:s1', providerId: 'openai', hostDeviceId: 'phone~1' },
        { kind: 'share', agentDeviceId: 'share:s2', providerId: 'openai', hostDeviceId: '设备/手机' },
        { kind: 'share', agentDeviceId: 'share:s3', providerId: 'openai', hostDeviceId: '' },
        { kind: 'share', agentDeviceId: 'share:s4', providerId: 'openai', hostDeviceId: 'x'.repeat(129) },
      ],
    }, 'openai')!;
    expect(config.members.map((member) => member.hostDeviceId)).toEqual(['phone~1', '设备/手机', undefined, undefined]);
  });

  it('keeps a valid account name snapshot and carries it to same-account computers', () => {
    const config = normalizeProviderGroupConfig(raw, 'openai')!;
    expect(config.members[1].providerName).toBe('GPT work');
    expect(config.members[2].providerName).toBeUndefined();
    expect(providerGroupSummaryForWire(config).members.map((m) => m.providerName)).toEqual([undefined, 'GPT work', undefined, undefined]);
  });

  it('reads the account name from a group host reply and falls back to the snapshot for an old host', () => {
    const config = normalizeProviderGroupConfig(raw, 'openai');
    const view = parseProviderGroupRemoteView({
      config,
      members: [
        { key: 'device:vm:openai-a', state: 'available' },
        { key: 'device:vm:openai-b', state: 'available', providerName: 'GPT home' },
      ],
    }, 'openai');
    expect(view.members.map((m) => m.providerName)).toEqual(['GPT work', 'GPT home']);
  });
});

describe('providerGroupMemberKey', () => {
  it('keys the local member, same-account devices and received shares separately', () => {
    expect(providerGroupMemberKey(null, 'anthropic')).toBe('local');
    expect(providerGroupMemberKey('dev-1', 'anthropic-1a2b3c4d')).toBe('device:dev-1:anthropic-1a2b3c4d');
    expect(providerGroupMemberKey('share:abc', 'anthropic')).toBe('share:abc:anthropic');
  });
});

describe('normalizeProviderGroupConfig', () => {
  it('round-trips the opt-in usage strategy without changing the default', () => {
    expect(normalizeProviderGroupConfig({ strategy: 'usage', members: [{ kind: 'local' }] }, 'anthropic')?.strategy).toBe('usage');
    expect(normalizeProviderGroupConfig({ members: [{ kind: 'local' }] }, 'anthropic')?.strategy).toBe('least');
  });

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
