import { beforeEach, expect, it, vi } from 'vitest';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';

function session(id: string): RemoteSession {
  return { id, userId: 'owner', title: id, workingDir: '/repo', workspaceKind: 'project', model: 'model', effort: '',
    permissionMode: 'default', fastMode: false, status: 'active', agentKind: 'codex',
    userSendAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
}
beforeEach(() => remoteSessionStore.clear());

it('keeps Home stable through 100 usage pushes while details receive every update', () => {
  remoteSessionStore.setDeviceSessions('host', 'Host', Array.from({ length: 1000 }, (_, i) => session(`s${i}`)));
  const home = remoteSessionStore.getHomeSessions();
  const notifyHome = vi.fn(), notifyDetail = vi.fn();
  const stopHome = remoteSessionStore.subscribeHomeStatus(notifyHome);
  const stopDetail = remoteSessionStore.subscribe(notifyDetail);
  try {
    for (let i = 1; i <= 100; i++) {
      remoteSessionStore.applyRemotePush('host', 'usage:session-tokens-changed', { sessionId: 's0', totalTokens: i });
      expect(remoteSessionStore.getSessions()[0].totalTokenUsage).toBe(i);
      expect(remoteSessionStore.getHomeSessions()).toBe(home);
    }
    expect(notifyHome).not.toHaveBeenCalled();
    expect(notifyDetail).toHaveBeenCalledTimes(100);
    remoteSessionStore.applySessionPatch('host', 's0', { title: 'renamed', totalCostUsd: 2 });
    expect(remoteSessionStore.getHomeSessions()[0].title).toBe('renamed');
    expect(remoteSessionStore.getSessions()[0].totalTokenUsage).toBe(100);
    expect(remoteSessionStore.getHomeSessions()[1]).toBe(home[1]);
    expect(notifyHome).toHaveBeenCalledOnce();
  } finally { stopHome(); stopDetail(); }
});

it('reconciles usage-only full snapshots and still publishes reorder, archive and clear', () => {
  remoteSessionStore.setDeviceSessions('host', 'Host', [session('a'), session('b')]);
  const home = remoteSessionStore.getHomeSessions();
  remoteSessionStore.setDeviceSessions('host', 'Host', [{ ...session('a'), totalCostUsd: 5 }, session('b')]);
  expect(remoteSessionStore.getHomeSessions()).toBe(home);
  expect(remoteSessionStore.getSessions()[0].totalCostUsd).toBe(5);
  remoteSessionStore.setDeviceSessions('host', 'Host', [session('b'), session('a')]);
  expect(remoteSessionStore.getHomeSessions()).toEqual([home[1], home[0]]);
  remoteSessionStore.applySessionPatch('host', 'a', { status: 'archived' });
  expect(remoteSessionStore.getHomeSessions().map(row => row.id)).toEqual(['b']);
  remoteSessionStore.clear();
  expect(remoteSessionStore.getHomeSessions()).toEqual([]);
});

it('does not let a stale shard usage patch replace the canonical device winner', () => {
  remoteSessionStore.setDeviceIdentity([{ deviceId: 'new', name: 'Host' }]);
  remoteSessionStore.setDeviceSessions('old', 'Host', [session('a')]);
  remoteSessionStore.setDeviceSessions('new', 'Host', [{ ...session('a'), totalCostUsd: 4 }]);
  const current = remoteSessionStore.getSessions()[0];
  remoteSessionStore.applySessionPatch('old', 'a', { totalCostUsd: 99 });
  expect(remoteSessionStore.getSessions()[0]).toBe(current);
  expect(current.deviceLinkDeviceId).toBe('new');
});
