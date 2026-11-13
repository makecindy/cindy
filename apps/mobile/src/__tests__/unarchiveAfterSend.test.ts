import { beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteSessionStore, sessionMetaWriteGuard, sessionPendingWrites } from '@/session/remoteSessionStore';
import { unarchiveSessionAfterSend } from '@/session/unarchiveAfterSend';
import type { RemoteSession } from '@/session/types';

function session(id: string, patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id, userId: 'user-1', title: id, workingDir: '/repo', workspaceKind: 'project', model: 'claude',
    effort: 'medium', permissionMode: 'default', fastMode: false, status: 'archived', agentKind: 'cc',
    userSendAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

const statusOf = (id: string) => remoteSessionStore.getSessions().find((item) => item.id === id)?.status;

describe('unarchiveSessionAfterSend', () => {
  beforeEach(() => remoteSessionStore.clear());

  it('writes status active to the host once the message is accepted', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const invoke = vi.fn(async () => ({}));
    await unarchiveSessionAfterSend('s1', 'dev-1', invoke as never);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'local-db:sessions:patch-meta', ['s1', { status: 'active' }], { preSend: expect.any(Function) });
    expect(statusOf('s1')).toBe('active');
  });

  it('keeps the task archived when the host write fails, without surfacing an error', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const invoke = vi.fn(async () => { throw new Error('HOST_REJECTED'); });
    await expect(unarchiveSessionAfterSend('s1', 'dev-1', invoke as never)).resolves.toBeUndefined();
    expect(statusOf('s1')).toBe('archived');
  });

  it('lets a later archive win: the stale unarchive neither retries nor rolls the row back', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    let fail: (error: Error) => void = () => {};
    const invoke = vi.fn((_d: string, _c: string, _a?: unknown[], options?: { preSend?: () => void }) => {
      options?.preSend?.();
      return new Promise((_resolve, reject) => { fail = reject; });
    });
    const pending = unarchiveSessionAfterSend('s1', 'dev-1', invoke as never);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    sessionMetaWriteGuard.begin('s1', ['status']); // 用户随后又归档/删除了这个任务
    fail(new Error('HOST_REJECTED'));
    await pending;
    expect(statusOf('s1')).toBe('active');
  });

  it('asks the host when the cache no longer has the row, then writes active and reconciles', async () => {
    const reseed = vi.spyOn(remoteSessionStore, 'requestReseed');
    const invoke = vi.fn(async () => ({}));
    await unarchiveSessionAfterSend('s1', 'dev-1', invoke as never, async () => session('s1'));
    expect(invoke).toHaveBeenCalledWith('dev-1', 'local-db:sessions:patch-meta', ['s1', { status: 'active' }], { preSend: expect.any(Function) });
    expect(reseed).toHaveBeenCalledWith('dev-1');
    expect(remoteSessionStore.getSessions()).toHaveLength(0);
    reseed.mockRestore();
  });

  it('does nothing when the cache has no row and the host says the task is not archived', async () => {
    const invoke = vi.fn(async () => ({}));
    await unarchiveSessionAfterSend('s1', 'dev-1', invoke as never, async () => session('s1', { status: 'active' }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reconciles when another controller archived it while the write was in flight', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const reseed = vi.spyOn(remoteSessionStore, 'requestReseed');
    const invoke = vi.fn(async () => {
      // 其他控制端的 status 推送在途期间到达,被本机在途写遮蔽。
      sessionPendingWrites.filterPatch('s1', { status: 'archived' }, { status: 'active' });
      return {};
    });
    await unarchiveSessionAfterSend('s1', 'dev-1', invoke as never);
    expect(reseed).toHaveBeenCalledWith('dev-1');
    reseed.mockRestore();
  });

  it('does not reconcile needlessly after a clean write', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const reseed = vi.spyOn(remoteSessionStore, 'requestReseed');
    await unarchiveSessionAfterSend('s1', 'dev-1', (async () => ({})) as never);
    expect(reseed).not.toHaveBeenCalled();
    reseed.mockRestore();
  });

  it('gives a second accepted message its own attempt when the first unarchive fails', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    let failFirst: (error: Error) => void = () => {};
    const invoke = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockResolvedValue({});
    const first = unarchiveSessionAfterSend('s1', 'dev-1', invoke as never);
    const second = unarchiveSessionAfterSend('s1', 'dev-1', invoke as never); // 缓存此刻已被乐观改成 active
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    failFirst(new Error('HOST_REJECTED'));
    await Promise.all([first, second]);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(statusOf('s1')).toBe('active');
  });

  it('retires the row instead of reinserting a ghost when the host reports the task gone', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const invoke = vi.fn(async () => { throw Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' }); });
    await unarchiveSessionAfterSend('s1', 'dev-1', invoke as never);
    expect(remoteSessionStore.getSessions().some((item) => item.id === 's1' && item.status === 'archived')).toBe(false);
  });

  it('reconciles the optimistic row with the host reply', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const invoke = vi.fn(async () => session('s1', { status: 'active', updatedAt: '2026-02-02T00:00:00.000Z' }));
    await unarchiveSessionAfterSend('s1', 'dev-1', invoke as never);
    expect(remoteSessionStore.getSessions().find((item) => item.id === 's1')?.updatedAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it.each([
    ['an active task', session('s1', { status: 'active' })],
    ['a Bot-managed task', session('s1', { source: 'bot' })],
    ['a collaboration worker', session('s1', { orcaRole: 'worker' })],
  ])('leaves %s alone', async (_name, row) => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [row]);
    const invoke = vi.fn(async () => ({}));
    await unarchiveSessionAfterSend('s1', 'dev-1', invoke as never);
    expect(invoke).not.toHaveBeenCalled();
    expect(statusOf('s1')).toBe(row.status);
  });
});
