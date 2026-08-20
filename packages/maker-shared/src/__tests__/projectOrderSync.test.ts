import { describe, expect, it } from 'vitest';
import {
  hostLocalProjectKeysOnly,
  isHostProjectOrderReachable,
  parseSyncedProjectOrderSnapshot,
  projectOrderLedgerForScope,
  projectOrderWriteLedger,
  remapControllerOrderToHost,
  remapHostOrderToController,
  remapHostProjectKeyToController,
  resolveDisplayedProjectOrder,
  resolveProjectOrderWriteScope,
  shouldPersistViewerSortAfterHostActivity,
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
