import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteAgentCaps } from '@cindy/device-link';
import type { ProviderGroupConfig, ProviderGroupMemberState, ProviderGroupView } from '../../../shared/providerGroup';
import type { ProviderGroupOwnerScope } from '../runtime';
import { createGuestSupportReader, readSharedGroupStatus, SHARED_GROUP_STATUS_TIMEOUT_MS, type SharedGroupStatusDeps } from '../sharedStatus';

function setup(states: ProviderGroupMemberState[] = ['available', 'full', 'cooling', 'offline', 'paused', 'unavailable']) {
  let current = true;
  let config: ProviderGroupConfig | null = {
    strategy: 'least', autoSwitch: true,
    members: states.map((state, index) => ({
      key: `private-key-${index}`, label: `Secret Computer ${index}`, kind: index === 0 ? 'local' : 'device',
      agentDeviceId: index === 0 ? null : `private-device-${index}`, providerId: 'anthropic',
      limit: 4, weight: 1, paused: state === 'paused',
    })),
  };
  const view: ProviderGroupView = {
    providerId: 'anthropic', config, members: config.members.map((member, index) => ({
      ...member, label: member.label!, ownerName: 'private-owner', state: states[index], running: index === 1 ? 4 : 0,
    })),
  };
  const router = { view: vi.fn(async () => view) };
  const readCaps = vi.fn<SharedGroupStatusDeps['readCaps']>(async () => ({ virtualWorkspace: true, guestRelay: true }) as RemoteAgentCaps);
  const isIncapable = vi.fn(() => false);
  const deps = {
    scope: () => ({ router, isCurrent: () => current }) as unknown as ProviderGroupOwnerScope,
    readGroup: () => config, readCaps, isIncapable,
  };
  return {
    deps, router, view, readCaps, isIncapable,
    changeOwner: () => { current = false; },
    removeGroup: () => { config = null; },
    setConfig: (next: ProviderGroupConfig) => { config = next; },
  };
}

afterEach(() => vi.useRealTimers());

describe('anonymous shared group status', () => {
  it('coalesces capability reads per computer within an explicitly created reader', async () => {
    const env = setup(['available', 'available']);
    const member = env.view.config!.members[1];
    const read = createGuestSupportReader(env.readCaps);
    expect(await Promise.all([read(member), read({ ...member, providerId: 'other' })])).toEqual(['supported', 'supported']);
    expect(env.readCaps).toHaveBeenCalledTimes(1);
    env.readCaps.mockResolvedValue({ virtualWorkspace: true } as RemoteAgentCaps);
    expect(await createGuestSupportReader(env.readCaps)(member)).toBe('needs-update');
  });

  it('coalesces shared accounts that point to one physical computer', async () => {
    const env = setup(['available', 'available']);
    const base = env.view.config!.members[1]!;
    const members = [
      { ...base, kind: 'share' as const, agentDeviceId: 'share:s1', hostDeviceId: 'kai-pc' },
      { ...base, kind: 'share' as const, agentDeviceId: 'share:s2', hostDeviceId: 'kai-pc' },
    ];
    env.readCaps.mockResolvedValue({ virtualWorkspace: true, reshareConsent: true } as RemoteAgentCaps);
    const read = createGuestSupportReader(env.readCaps);

    expect(await Promise.all(members.map((member) => read(member)))).toEqual(['supported', 'supported']);
    expect(env.readCaps).toHaveBeenCalledTimes(1);
    expect(env.readCaps).toHaveBeenCalledWith(members[0]);
  });

  it('projects coarse states without identities, sources, limits, or usage', async () => {
    const env = setup();
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual([
      'available', 'busy', 'cooling', 'offline', 'paused', 'unavailable',
    ]);
    expect(env.readCaps).toHaveBeenCalledTimes(1);
  });

  it('bounds capability probes for 512 members and shares them across concurrent refreshes', async () => {
    vi.useFakeTimers();
    const env = setup(Array.from({ length: 512 }, () => 'available'));
    let active = 0;
    let peak = 0;
    env.readCaps.mockImplementation(() => new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        resolve({ virtualWorkspace: true, guestRelay: true } as RemoteAgentCaps);
      }, 1);
    }));
    const first = readSharedGroupStatus(env.deps, 'anthropic');
    const second = readSharedGroupStatus({
      ...env.deps, readCaps: (member) => env.deps.readCaps(member),
    }, 'anthropic');
    await vi.advanceTimersByTimeAsync(0);
    expect(env.readCaps).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(512);
    const expected = Array.from({ length: 512 }, (_, index) => index === 1 ? 'busy' : 'available');
    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(env.readCaps).toHaveBeenCalledTimes(511);
  });

  it('expires queued probes without releasing physical slots or repeating timed-out requests', async () => {
    vi.useFakeTimers();
    const env = setup(Array.from({ length: 512 }, () => 'available'));
    const finish: Array<(caps: RemoteAgentCaps) => void> = [];
    env.readCaps.mockImplementation(() => new Promise((resolve) => { finish.push(resolve); }));
    const first = readSharedGroupStatus(env.deps, 'anthropic');
    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_TIMEOUT_MS);
    expect(await first).toEqual(['available', ...Array.from({ length: 511 }, () => 'unknown')]);
    expect(env.readCaps).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(15_000 - SHARED_GROUP_STATUS_TIMEOUT_MS);
    const second = readSharedGroupStatus(env.deps, 'anthropic');
    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_TIMEOUT_MS);
    expect(await second).toEqual(await first);
    expect(env.readCaps).toHaveBeenCalledTimes(4);

    for (const resolve of finish) resolve({ virtualWorkspace: true, guestRelay: true } as RemoteAgentCaps);
    await vi.advanceTimersByTimeAsync(0);
    expect(env.readCaps).toHaveBeenCalledTimes(4);
    const third = readSharedGroupStatus(env.deps, 'anthropic');
    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_TIMEOUT_MS);
    expect((await third)?.slice(0, 6)).toEqual(['available', 'busy', 'available', 'available', 'available', 'unknown']);
    expect(env.readCaps).toHaveBeenCalledTimes(8);
    expect(new Set(env.readCaps.mock.calls.map(([member]) => member.agentDeviceId)).size).toBe(8);
  });

  it('reuses completed capabilities for 15 seconds without caching live group states', async () => {
    vi.useFakeTimers();
    const env = setup(['available', 'available']);
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual(['available', 'busy']);
    env.view.members[1].running = 0;
    env.readCaps.mockResolvedValue({ virtualWorkspace: true } as RemoteAgentCaps);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual(['available', 'available']);
    expect(env.readCaps).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual(['available', 'needs-update']);
    expect(env.readCaps).toHaveBeenCalledTimes(2);
  });

  it('does not dispatch expired queued probes before their timeout callbacks run', async () => {
    vi.useFakeTimers();
    const env = setup(Array.from({ length: 10 }, () => 'available'));
    const finish: Array<(caps: RemoteAgentCaps) => void> = [];
    env.readCaps.mockImplementation(() => new Promise((resolve) => { finish.push(resolve); }));
    const result = readSharedGroupStatus(env.deps, 'anthropic');
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + SHARED_GROUP_STATUS_TIMEOUT_MS);
    for (const resolve of finish) resolve({ virtualWorkspace: true, guestRelay: true } as RemoteAgentCaps);
    await vi.advanceTimersByTimeAsync(0);
    expect(env.readCaps).toHaveBeenCalledTimes(4);
    expect((await result)?.slice(0, 6)).toEqual(['available', 'busy', 'available', 'available', 'available', 'unknown']);
  });

  it.each(['throw', 'reject'])('releases physical slots after a capability %s', async (failure) => {
    vi.useFakeTimers();
    const env = setup(Array.from({ length: 10 }, () => 'available'));
    env.readCaps.mockImplementation(() => {
      if (failure === 'throw') throw new Error('Unavailable');
      return Promise.reject(new Error('Unavailable'));
    });
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual([
      'available', ...Array.from({ length: 9 }, () => 'unknown'),
    ]);
    expect(env.readCaps).toHaveBeenCalledTimes(9);
    env.readCaps.mockResolvedValue({ virtualWorkspace: true, guestRelay: true } as RemoteAgentCaps);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual([
      'available', 'busy', ...Array.from({ length: 8 }, () => 'available'),
    ]);
    expect(env.readCaps).toHaveBeenCalledTimes(18);
  });

  it('does not start queued probes after the owner changes', async () => {
    vi.useFakeTimers();
    const env = setup(Array.from({ length: 10 }, () => 'available'));
    const finish: Array<(caps: RemoteAgentCaps) => void> = [];
    env.readCaps.mockImplementation(() => new Promise((resolve) => { finish.push(resolve); }));
    const result = readSharedGroupStatus(env.deps, 'anthropic');
    await vi.advanceTimersByTimeAsync(0);
    expect(env.readCaps).toHaveBeenCalledTimes(4);
    env.changeOwner();
    for (const resolve of finish) resolve({ virtualWorkspace: true, guestRelay: true } as RemoteAgentCaps);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBeNull();
    expect(env.readCaps).toHaveBeenCalledTimes(4);
  });

  it('isolates pending and cached capabilities between owner runtimes', async () => {
    vi.useFakeTimers();
    const previous = setup(['available', 'available']);
    previous.readCaps.mockImplementation(() => new Promise(() => {}));
    const stale = readSharedGroupStatus(previous.deps, 'anthropic');
    await vi.advanceTimersByTimeAsync(0);
    previous.changeOwner();
    const current = setup(['available', 'available']);
    expect(await readSharedGroupStatus(current.deps, 'anthropic')).toEqual(['available', 'busy']);
    expect(current.readCaps).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_TIMEOUT_MS);
    expect(await stale).toBeNull();
    expect(previous.readCaps).toHaveBeenCalledTimes(1);
  });

  it('checks guest compatibility even when the owner can use the computer', async () => {
    vi.useFakeTimers();
    const env = setup(['available', 'available']);
    env.readCaps.mockResolvedValue({ virtualWorkspace: true } as RemoteAgentCaps);
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual(['available', 'needs-update']);
    // A shared member is isolated by its host, but still needs reshareConsent so
    // the anonymous status matches the actual guest-task admission check.
    env.view.config!.members[1].kind = 'share';
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual(['available', 'needs-update']);
    env.readCaps.mockResolvedValue({ virtualWorkspace: true, reshareConsent: true } as RemoteAgentCaps);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual(['available', 'busy']);
  });

  // 转分享(provider-sharing.md §4.3)：主人没同意过读状态的这个人时，分享来的电脑对他显示暂不可用，与实际分配一致。
  it('shows a shared-in computer as unavailable to a shared user its owner has not agreed to', async () => {
    const env = setup(['available', 'available', 'offline']);
    env.view.config!.members[1].kind = 'share';
    env.view.config!.members[2].kind = 'share';
    let agreed = false;
    const reshareState: NonNullable<SharedGroupStatusDeps['reshareState']> = vi.fn((member) =>
      (member.kind === 'share' && !agreed ? 'unavailable' : null));
    expect(await readSharedGroupStatus({ ...env.deps, reshareState }, 'anthropic')).toEqual(['available', 'unavailable', 'offline']);
    // 离线的照实显示离线；不再为没同意的那台探测能力。
    expect(reshareState).toHaveBeenCalledTimes(2);
    expect(env.readCaps).not.toHaveBeenCalled();
    agreed = true;
    env.readCaps.mockResolvedValue({ virtualWorkspace: true, reshareConsent: true } as RemoteAgentCaps);
    // 同意后照常显示(这台在跑任务，显示忙碌)。
    expect(await readSharedGroupStatus({ ...env.deps, reshareState }, 'anthropic')).toEqual(['available', 'busy', 'offline']);
  });

  // 受邀者看到的是电脑不是账号(provider-groups.md §10，2026-10-15)：同一台电脑的几个账号合成一项，取最能接任务的状态。
  it('lists one state per computer, taking the most usable account of each computer', async () => {
    const env = setup(['available', 'cooling', 'full', 'offline', 'cooling', 'paused']);
    const members = env.view.config!.members;
    members[2].agentDeviceId = members[1].agentDeviceId;
    for (const index of [3, 4]) {
      Object.assign(members[index], { kind: 'share', agentDeviceId: `share:s${index}`, hostDeviceId: 'kai-pc' });
    }
    // 本机；同一台(冷却 + 满载仍能接 → 忙碌)；Kai 的那台(离线 + 冷却 → 冷却)；暂停的那台。
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual(['available', 'busy', 'cooling', 'paused']);
  });

  it('reflects the same temporary exclusion as the guest router without probing or changing it', async () => {
    const env = setup(['available', 'available']);
    env.isIncapable.mockReturnValue(true);
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual(['available', 'needs-update']);
    expect(env.readCaps).not.toHaveBeenCalled();
  });

  it('keeps confirmed statuses while an unresponsive capability read becomes unknown', async () => {
    vi.useFakeTimers();
    const env = setup(['available', 'available']);
    env.readCaps.mockImplementation(() => new Promise(() => {}));
    const result = readSharedGroupStatus(env.deps, 'anthropic');
    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_TIMEOUT_MS);
    expect(await result).toEqual(['available', 'unknown']);
  });

  it('bounds a failed/slow group read without declaring computers available', async () => {
    vi.useFakeTimers();
    const env = setup();
    env.router.view.mockImplementation(() => new Promise(() => {}));
    const result = readSharedGroupStatus(env.deps, 'anthropic');
    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_TIMEOUT_MS);
    expect(await result).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'paused', 'unknown']);
    expect(env.readCaps).not.toHaveBeenCalled();
  });

  it('discards status when ownership or group membership changes during the read', async () => {
    const env = setup();
    env.readCaps.mockImplementation(async () => {
      env.changeOwner();
      return { virtualWorkspace: true, guestRelay: true } as RemoteAgentCaps;
    });
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toBeNull();
    const changed = setup();
    changed.readCaps.mockImplementation(async () => {
      changed.setConfig({ ...changed.view.config!, members: [...changed.view.config!.members].reverse() });
      return { virtualWorkspace: true, guestRelay: true } as RemoteAgentCaps;
    });
    expect(await readSharedGroupStatus(changed.deps, 'anthropic')).toBeNull();
    changed.removeGroup();
    expect(await readSharedGroupStatus(changed.deps, 'anthropic')).toBeNull();
  });
});
