import { describe, expect, it } from 'vitest';
import {
  createProjectOrderFetchFence,
  hostLocalProjectKeysOnly,
  isHostProjectOrderChannelMissing,
  isHostProjectOrderReachable,
  localHostSeedOwnerKey,
  parseSyncedProjectOrderSnapshot,
  shouldAcceptHostProjectOrderPush,
  shouldSeedLocalHostProjectOrder,
  projectOrderLedgerForScope,
  projectOrderWriteLedger,
  remapControllerOrderToHost,
  remapHostOrderToController,
  remapHostProjectKeyToController,
  resolveDisplayedProjectOrder,
  resolveProjectOrderWriteScope,
  shouldPersistViewerSortAfterHostActivity,
  reconcileManualProjectOrder,
} from '../projectOrderSync';

describe('project order key remap', () => {
  it('round-trips host local keys through a controller device prefix', () => {
    const deviceId = 'dev/one';
    const host = ['local:/Users/dash/cindy', 'local:/tmp/app'];
    const controller = remapHostOrderToController(deviceId, host);
    expect(controller).toEqual([
      remapHostProjectKeyToController(deviceId, host[0]),
      remapHostProjectKeyToController(deviceId, host[1]),
    ]);
    expect(remapControllerOrderToHost(deviceId, controller)).toEqual(host);
  });

  it('folds Windows host paths to the mobile grouping key and restores case on the way back', () => {
    const deviceId = 'win-box';
    const host = ['local:C:/Work/App'];
    const controller = remapHostOrderToController(deviceId, host);
    expect(controller).toEqual([
      `device:${encodeURIComponent(deviceId)}:c:/work/app`,
    ]);
    expect(remapControllerOrderToHost(deviceId, controller, host)).toEqual(host);
  });

  it('folds worktree host paths to the grouping key and restores the host spelling', () => {
    const deviceId = 'dev-1';
    const host = ['local:/repo/.cindy-worktrees/serene-lovelace'];
    const controller = remapHostOrderToController(deviceId, host);
    expect(controller).toEqual([
      `device:${encodeURIComponent(deviceId)}:/repo`,
    ]);
    expect(remapControllerOrderToHost(deviceId, controller, host)).toEqual(host);
  });

  it('keeps a POSIX backslash filename verbatim instead of folding it as Windows', () => {
    const deviceId = 'posix-box';
    // `foo\bar` 是 POSIX 下的单个合法文件名,不能被当成 Windows 分隔符折叠/小写,
    // 否则会与 `local:/repo/foo/bar` 生成同一个项目键而错误合并。
    const backslash = remapHostProjectKeyToController(deviceId, 'local:/repo/Foo\\Bar');
    const slash = remapHostProjectKeyToController(deviceId, 'local:/repo/Foo/Bar');
    expect(backslash).toBe(`device:${encodeURIComponent(deviceId)}:/repo/Foo\\Bar`);
    expect(slash).toBe(`device:${encodeURIComponent(deviceId)}:/repo/Foo/Bar`);
    expect(backslash).not.toBe(slash);
  });
});

describe('parseSyncedProjectOrderSnapshot', () => {
  it('fails closed to a non-authoritative activity snapshot', () => {
    expect(parseSyncedProjectOrderSnapshot(null)).toEqual({
      authoritative: false,
      available: true,
      manualProjectOrder: [],
      projectOrder: 'activity',
    });
  });

  it('drops mixed viewer keys from a host snapshot', () => {
    expect(parseSyncedProjectOrderSnapshot({
      authoritative: true,
      projectOrder: 'custom',
      manualProjectOrder: ['local:/a', 'device:other:/b', 'remote:ssh:/c'],
    })).toEqual({
      authoritative: true,
      available: true,
      manualProjectOrder: ['local:/a'],
      projectOrder: 'custom',
    });
  });
});

describe('isHostProjectOrderChannelMissing', () => {
  it('only treats missing-channel codes as unavailable', () => {
    expect(isHostProjectOrderChannelMissing({ code: 'CHANNEL_NOT_ALLOWED' })).toBe(true);
    expect(isHostProjectOrderChannelMissing({ code: 'REMOTE_DISABLED' })).toBe(true);
    expect(isHostProjectOrderChannelMissing({
      message: '[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel not allowed remotely',
    })).toBe(true);
    expect(isHostProjectOrderChannelMissing(
      new Error('[DEVICE_LINK_REMOTE_DISABLED] remote control disabled'),
    )).toBe(true);
    expect(isHostProjectOrderChannelMissing({ code: 'NOT_CONNECTED' })).toBe(false);
    expect(isHostProjectOrderChannelMissing(new Error('timeout'))).toBe(false);
  });
});

describe('hostLocalProjectKeysOnly', () => {
  it('keeps only local host keys', () => {
    expect(hostLocalProjectKeysOnly(['local:/a', 'device:x:/b', 'local:/a', ''])).toEqual(['local:/a']);
  });
});

describe('resolveProjectOrderWriteScope', () => {
  it('treats all / multi-select as viewer mixed order', () => {
    expect(resolveProjectOrderWriteScope('all', 'local')).toEqual({ kind: 'viewer' });
    expect(resolveProjectOrderWriteScope(['local', 'dev-1'], 'local')).toEqual({ kind: 'viewer' });
  });

  it('routes a single machine to that host', () => {
    expect(resolveProjectOrderWriteScope(['local'], 'local')).toEqual({ kind: 'host', deviceId: null });
    expect(resolveProjectOrderWriteScope(['dev-1'], 'local')).toEqual({ kind: 'host', deviceId: 'dev-1' });
  });
});

describe('resolveDisplayedProjectOrder', () => {
  const viewer = { projectOrder: 'activity' as const, manualProjectOrder: ['device:a:/x'] };
  const hostCustom = {
    authoritative: true,
    available: true,
    manualProjectOrder: ['local:/a'],
    projectOrder: 'custom' as const,
  };

  it('uses the viewer mixed list for ALL / unavailable hosts', () => {
    expect(resolveDisplayedProjectOrder(
      { kind: 'viewer' },
      hostCustom,
      viewer,
      ['device:a:/x'],
    )).toEqual(viewer);
    expect(resolveDisplayedProjectOrder(
      { kind: 'host', deviceId: 'dev-1' },
      { ...hostCustom, available: false },
      viewer,
      ['device:dev-1:/a'],
    )).toEqual(viewer);
  });

  it('uses the remapped host custom list for a single reachable machine', () => {
    expect(resolveDisplayedProjectOrder(
      { kind: 'host', deviceId: 'dev-1' },
      hostCustom,
      viewer,
      ['device:dev-1:/a'],
    )).toEqual({
      projectOrder: 'custom',
      manualProjectOrder: ['device:dev-1:/a'],
    });
  });

  it('does not keep the viewer custom check when the host ledger is activity', () => {
    expect(resolveDisplayedProjectOrder(
      { kind: 'host', deviceId: 'dev-1' },
      {
        authoritative: true,
        available: true,
        manualProjectOrder: [],
        projectOrder: 'activity',
      },
      { projectOrder: 'custom', manualProjectOrder: ['device:a:/x'] },
      [],
    )).toEqual({
      projectOrder: 'activity',
      manualProjectOrder: [],
    });
  });
});

describe('createProjectOrderFetchFence', () => {
  it('drops a GET that finished after a live update', () => {
    const fence = createProjectOrderFetchFence();
    const token = fence.begin('dev-1');
    fence.noteLiveUpdate('dev-1');
    expect(fence.shouldApplyFetch('dev-1', token)).toBe(false);
  });

  it('still applies a GET that started after the last live update', () => {
    const fence = createProjectOrderFetchFence();
    fence.noteLiveUpdate('dev-1');
    const token = fence.begin('dev-1');
    expect(fence.shouldApplyFetch('dev-1', token)).toBe(true);
  });
});

describe('shouldAcceptHostProjectOrderPush', () => {
  const ownerA = { dataOwnerId: 'acct-a', ownerGeneration: 2 };

  it('drops a late frame from a previous owner or generation', () => {
    expect(shouldAcceptHostProjectOrderPush({
      controllerDataOwnerId: 'acct-a',
      incoming: { dataOwnerId: 'acct-b', ownerGeneration: 9 },
      incomingPresent: true,
      previous: ownerA,
      seenStampFromDevice: true,
    })).toBe(false);
    expect(shouldAcceptHostProjectOrderPush({
      controllerDataOwnerId: 'acct-a',
      incoming: { dataOwnerId: 'acct-a', ownerGeneration: 1 },
      incomingPresent: true,
      previous: ownerA,
      seenStampFromDevice: true,
    })).toBe(false);
  });

  it('keeps an unstamped frame only before the device has proven stamp support', () => {
    expect(shouldAcceptHostProjectOrderPush({
      controllerDataOwnerId: 'acct-a',
      incoming: undefined,
      incomingPresent: false,
      previous: undefined,
      seenStampFromDevice: false,
    })).toBe(true);
    expect(shouldAcceptHostProjectOrderPush({
      controllerDataOwnerId: 'acct-a',
      incoming: undefined,
      incomingPresent: false,
      previous: ownerA,
      seenStampFromDevice: true,
    })).toBe(false);
  });
});

describe('shouldSeedLocalHostProjectOrder', () => {
  const stamp = { dataOwnerId: 'owner-a', ownerGeneration: 3 };
  const emptyHost = {
    authoritative: false,
    available: true,
    manualProjectOrder: [],
    ownerStamp: stamp,
    projectOrder: 'activity' as const,
  };

  it('seeds only once per owner after a successful write', () => {
    expect(shouldSeedLocalHostProjectOrder(
      emptyHost,
      { custom: true, keys: ['local:/a'] },
      new Set(),
    )).toBe(true);
    expect(shouldSeedLocalHostProjectOrder(
      emptyHost,
      { custom: true, keys: ['local:/a'] },
      new Set([localHostSeedOwnerKey(stamp)]),
    )).toBe(false);
  });

  it('retries after a failed seed because the owner is not marked', () => {
    expect(shouldSeedLocalHostProjectOrder(
      emptyHost,
      { custom: true, keys: ['local:/a'] },
      new Set(),
    )).toBe(true);
  });

  it('seeds the local subsequence of a mixed viewer ledger', () => {
    expect(shouldSeedLocalHostProjectOrder(
      emptyHost,
      { custom: true, keys: ['local:/a', 'device:other:/b'] },
      new Set(),
    )).toBe(true);
  });
});

describe('reconcileManualProjectOrder', () => {
  it('keeps active spelling when prev only has the folded Windows key', () => {
    expect(reconcileManualProjectOrder(
      ['local:c:/work/app', 'local:/posix'],
      ['local:C:/Work/App', 'local:/posix', 'local:/new'],
    )).toEqual(['local:C:/Work/App', 'local:/posix', 'local:/new']);
  });
});

describe('project order write routing', () => {
  it('sends ALL / multi-select drags to the viewer ledger only', () => {
    expect(projectOrderLedgerForScope(resolveProjectOrderWriteScope('all', 'local'))).toBe('viewer');
    expect(projectOrderLedgerForScope(resolveProjectOrderWriteScope(['local', 'dev-1'], 'local'))).toBe('viewer');
  });

  it('sends a single-machine drag to that host ledger', () => {
    expect(projectOrderLedgerForScope(resolveProjectOrderWriteScope(['local'], 'local'))).toBe('host');
    expect(projectOrderLedgerForScope(resolveProjectOrderWriteScope(['dev-1'], 'local'))).toBe('host');
  });

  it('does not flip viewer mixed-manual when a host switches to activity', () => {
    expect(shouldPersistViewerSortAfterHostActivity(true)).toBe(false);
    expect(shouldPersistViewerSortAfterHostActivity(false)).toBe(true);
  });

  it('falls back to the viewer ledger when the host channel is unavailable', () => {
    const hostScope = resolveProjectOrderWriteScope(['dev-1'], 'local');
    expect(isHostProjectOrderReachable({
      authoritative: false,
      available: false,
      manualProjectOrder: [],
      projectOrder: 'activity',
    })).toBe(false);
    expect(projectOrderWriteLedger(hostScope, {
      authoritative: false,
      available: false,
      manualProjectOrder: [],
      projectOrder: 'activity',
    })).toBe('viewer');
    expect(projectOrderWriteLedger(hostScope, {
      authoritative: false,
      available: true,
      manualProjectOrder: [],
      projectOrder: 'activity',
    })).toBe('host');
  });
});
