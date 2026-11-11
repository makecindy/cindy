/**
 * 原分享被删除或已退出(provider-groups.md §3)：已收到的分享名单完整可信时，组里指向已不在的分享的电脑移出组；
 * 名单说不准时什么都不动，分享只是暂停(仍在名单里)时保留。
 */
import { describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import {
  pruneRemovedShareMembers,
  recordShareHosts,
  type PruneRemovedShareMembersDeps,
  type RecordShareHostsDeps,
} from '../removedShares';

function member(key: string, kind: ProviderGroupMember['kind'], agentDeviceId: string | null): ProviderGroupMember {
  return { key, kind, agentDeviceId, providerId: 'anthropic', limit: 4, weight: 1, paused: false };
}

const LOCAL = member('local', 'local', null);
const MINI = member('device:mini:anthropic', 'device', 'mini');
const FROM_A = member('share:a1:anthropic', 'share', 'share:a1');
const FROM_D = member('share:d1:anthropic', 'share', 'share:d1');

function setup(received: ReadonlySet<string> | null) {
  let groups: Record<string, ProviderGroupConfig> = {
    anthropic: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI, FROM_A, FROM_D] },
    openai: { strategy: 'least', autoSwitch: true, members: [{ ...LOCAL, providerId: 'openai' }] },
  };
  const writeGroup = vi.fn(async (providerId: string, config: unknown) => {
    groups = { ...groups, [providerId]: config as ProviderGroupConfig };
    return config;
  });
  const deps: PruneRemovedShareMembersDeps = {
    confirmedShareIds: () => received,
    listGroups: () => groups,
    writeGroup,
    pruneBindings: vi.fn(async () => undefined),
    ownerKey: () => 'owner',
    changed: vi.fn(),
  };
  return { deps, writeGroup, groups: () => groups };
}

describe('removing computers whose share is gone', () => {
  it('removes only the shared-in computers whose share is no longer received, and their task bindings', async () => {
    const env = setup(new Set(['d1']));
    expect(await pruneRemovedShareMembers(env.deps)).toEqual([FROM_A.key]);
    expect(env.groups().anthropic.members.map((m) => m.key)).toEqual([LOCAL.key, MINI.key, FROM_D.key]);
    expect(env.deps.pruneBindings).toHaveBeenCalledWith('anthropic', new Set([LOCAL.key, MINI.key, FROM_D.key]));
    expect(env.deps.changed).toHaveBeenCalledWith('anthropic');
    // 没有变化的组不写。
    expect(env.writeGroup).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the received list is not known to be complete', async () => {
    const env = setup(null);
    expect(await pruneRemovedShareMembers(env.deps)).toEqual([]);
    expect(env.writeGroup).not.toHaveBeenCalled();
  });

  it('keeps everything when every share is still received (paused shares stay in the list)', async () => {
    const env = setup(new Set(['a1', 'd1']));
    expect(await pruneRemovedShareMembers(env.deps)).toEqual([]);
    expect(env.writeGroup).not.toHaveBeenCalled();
  });

  it('stops when the account changes before writing', async () => {
    const env = setup(new Set());
    let owner = 'owner';
    env.deps.ownerKey = () => owner;
    env.deps.listGroups = () => {
      owner = 'someone-else';
      return env.groups();
    };
    expect(await pruneRemovedShareMembers(env.deps)).toEqual([]);
    expect(env.writeGroup).not.toHaveBeenCalled();
  });

  it('does not prune the new account bindings when the account changes while the group write completes', async () => {
    const env = setup(new Set());
    let owner = 'owner';
    env.deps.ownerKey = () => owner;
    env.writeGroup.mockImplementationOnce(async () => { owner = 'new-owner'; return null; });
    expect(await pruneRemovedShareMembers(env.deps)).toEqual([]);
    expect(env.deps.pruneBindings).not.toHaveBeenCalled();
    expect(env.deps.changed).not.toHaveBeenCalled();
  });

  it('does not publish old account changes or continue with other groups after binding cleanup changes account', async () => {
    const env = setup(new Set());
    let owner = 'owner';
    env.deps.ownerKey = () => owner;
    env.deps.pruneBindings = vi.fn(async () => { owner = 'new-owner'; });
    expect(await pruneRemovedShareMembers(env.deps)).toEqual([]);
    expect(env.deps.pruneBindings).toHaveBeenCalledTimes(1);
    expect(env.deps.changed).not.toHaveBeenCalled();
  });
});

// 旧组里分享来的电脑补记分享者那台电脑，同一台的几个分享才能按一台电脑展示与计数(provider-groups.md §10)。
describe('recording the computer of shared-in members', () => {
  function setupHosts(hosts: ReadonlyMap<string, string>) {
    let groups: Record<string, ProviderGroupConfig> = {
      anthropic: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI, FROM_A, { ...FROM_D, hostDeviceId: 'host-d' }] },
      openai: { strategy: 'least', autoSwitch: true, members: [{ ...LOCAL, providerId: 'openai' }] },
    };
    const updateGroup = vi.fn<RecordShareHostsDeps['updateGroup']>(async (providerId, updater) => {
      const current = groups[providerId] ?? null;
      const updated = updater(current);
      if (updated !== undefined) {
        if (updated) groups = { ...groups, [providerId]: updated };
        else {
          const next = { ...groups };
          delete next[providerId];
          groups = next;
        }
      }
      return groups[providerId] ?? null;
    });
    const deps: RecordShareHostsDeps = {
      shareHosts: () => hosts,
      listGroups: () => groups,
      updateGroup,
      ownerKey: () => 'owner',
      changed: vi.fn(),
    };
    return { deps, updateGroup, groups: () => groups, setGroups: (next: Record<string, ProviderGroupConfig>) => { groups = next; } };
  }

  it('fills in the computer of shares it can see and writes only the groups that change', async () => {
    const env = setupHosts(new Map([['a1', 'host-a'], ['d1', 'host-d']]));
    expect(await recordShareHosts(env.deps)).toEqual(['anthropic']);
    expect(env.groups().anthropic.members.map((m) => m.hostDeviceId)).toEqual([undefined, undefined, 'host-a', 'host-d']);
    expect(env.updateGroup).toHaveBeenCalledTimes(1);
    expect(env.deps.changed).toHaveBeenCalledWith('anthropic');
    // 再跑一次没有变化，不再写。
    expect(await recordShareHosts(env.deps)).toEqual([]);
    expect(env.updateGroup).toHaveBeenCalledTimes(1);
  });

  it('leaves shares it cannot see yet as they are, and does nothing before the list is read', async () => {
    const env = setupHosts(new Map([['d1', 'host-d']]));
    expect(await recordShareHosts(env.deps)).toEqual([]);
    expect(env.groups().anthropic.members[2].hostDeviceId).toBeUndefined();
    const empty = setupHosts(new Map());
    expect(await recordShareHosts(empty.deps)).toEqual([]);
    expect(empty.updateGroup).not.toHaveBeenCalled();
  });

  it('stops when the account changes during the write', async () => {
    const env = setupHosts(new Map([['a1', 'host-a']]));
    let owner = 'owner';
    env.deps.ownerKey = () => owner;
    env.updateGroup.mockImplementationOnce(async () => { owner = 'new-owner'; return null; });
    expect(await recordShareHosts(env.deps)).toEqual([]);
    expect(env.deps.changed).not.toHaveBeenCalled();
  });

  it('patches the latest group and does not recreate a group deleted while waiting for the lock', async () => {
    const env = setupHosts(new Map([['a1', 'host-a']]));
    const original = env.groups();
    env.setGroups({
      ...original,
      openai: { ...original.openai, members: [...original.openai.members, { ...FROM_A, providerId: 'openai' }] },
    });
    const initial = env.groups();
    env.updateGroup.mockImplementationOnce(async (providerId, updater) => {
      const latest = {
        ...initial.anthropic,
        strategy: 'round',
        members: [...initial.anthropic.members, { ...LOCAL, key: 'new-local' }],
      } satisfies ProviderGroupConfig;
      env.setGroups({ ...initial, anthropic: latest });
      const updated = updater(env.groups()[providerId] ?? null);
      if (updated) env.setGroups({ ...env.groups(), [providerId]: updated });
      return updated ?? null;
    });
    env.updateGroup.mockImplementationOnce(async (providerId, updater) => {
      const next = { ...env.groups() };
      delete next[providerId];
      env.setGroups(next);
      expect(updater(null)).toBeUndefined();
      return null;
    });

    expect(await recordShareHosts(env.deps)).toEqual(['anthropic']);
    expect(env.groups().anthropic.strategy).toBe('round');
    expect(env.groups().anthropic.members.map((m) => m.key)).toContain('new-local');
    expect(env.groups().anthropic.members.find((m) => m.key === FROM_A.key)?.hostDeviceId).toBe('host-a');
    expect(env.groups().openai).toBeUndefined();
  });
});
