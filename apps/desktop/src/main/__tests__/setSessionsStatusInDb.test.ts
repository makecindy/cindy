/**
 * setSessionsStatusInDb 回归测试。
 *
 * 批量归档/取消归档必须原子:走单个 sessions.setStatus 事务,成功后才逐个广播
 * sessions:patched + 通知 agent-island;事务抛错(任一 id 不存在)时整批回滚,
 * 不能广播任何部分成功的 patch。
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionRouteLock } from '../localDb/sessionRouteLock.js';

type SessionRouteLockMock = SessionRouteLock &
  MockInstance<(sessionId: string, task: () => Promise<unknown>) => Promise<unknown>>;

const h = vi.hoisted(() => ({
  tx: vi.fn(),
  tapWindowBroadcast: vi.fn(),
  webContentsSend: vi.fn(),
  closeSession: vi.fn(),
  withSendToSessionLock: vi.fn(async <T>(_sessionId: string, task: () => Promise<T>): Promise<T> =>
    task(),
  ) as SessionRouteLockMock,
  isSessionStillRemovable: vi.fn(),
  cancelSessionOperations: vi.fn(),
  cleanupRemovedSession: vi.fn(),
  removeSessionRefs: vi.fn(),
  recycleWorktreeForRemovedSession: vi.fn(),
  isOwnerScopeCurrent: vi.fn(),
  drizzle: {},
  userDataPath: '',
  agentIslandService: {
    handleSessionMetadataPatch: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userDataPath },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: h.webContentsSend } }],
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({ tx: h.tx, drizzle: h.drizzle }),
}));
vi.mock('../cindy-media/ledger', () => ({
  removeSessionRefsIfDeleted: h.removeSessionRefs,
}));
vi.mock('../localDb/dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../git-context/prRefsStore', () => ({ recomputePrRefsForSession: vi.fn() }));
vi.mock('../localDb/ipc/recentWorkdirs', () => ({ upsertRecentWorkdir: vi.fn() }));
vi.mock('../device-link/broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: vi.fn(() => null),
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  isDataOwnerBroadcastScopeCurrent: h.isOwnerScopeCurrent,
  tapWindowBroadcast: h.tapWindowBroadcast,
}));
vi.mock('../agent-island/service.js', () => ({
  getAgentIslandService: () => h.agentIslandService,
}));
vi.mock('../imageCacheStore', () => ({ removeSession: vi.fn() }));
vi.mock('../maker-host/index.js', () => ({
  getMakerIfReady: () => ({ closeSession: h.closeSession }),
}));
vi.mock('../maker-ipc/register.js', () => ({
  withSendToSessionLock: h.withSendToSessionLock,
}));
vi.mock('../worktree/sessionRemovalRecycle.js', () => ({
  isSessionStillRemovable: h.isSessionStillRemovable,
  recycleWorktreeForRemovedSession: h.recycleWorktreeForRemovedSession,
}));
import {
  recycleSessionWorktreeForStatusChange,
  setSessionRemovalCancelOperations,
  setSessionRemovalCleanup,
  setSessionsStatusInDb,
} from '../localDb/ipc/sessions.js';
import { setSessionRouteLockImplementation } from '../localDb/sessionRouteLock.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-set-sessions-status-'));
  h.closeSession.mockResolvedValue(undefined);
  h.isSessionStillRemovable.mockResolvedValue(true);
  h.cancelSessionOperations.mockResolvedValue(undefined);
  h.cleanupRemovedSession.mockResolvedValue(undefined);
  h.removeSessionRefs.mockResolvedValue(0);
  h.recycleWorktreeForRemovedSession.mockResolvedValue(undefined);
  h.isOwnerScopeCurrent.mockReturnValue(true);
  setSessionRemovalCancelOperations(h.cancelSessionOperations);
  setSessionRemovalCleanup(h.cleanupRemovedSession);
  setSessionRouteLockImplementation(h.withSendToSessionLock);
});

afterEach(() => {
  setSessionRemovalCancelOperations(null);
  setSessionRemovalCleanup(null);
  setSessionRouteLockImplementation(null);
  fs.rmSync(h.userDataPath, { recursive: true, force: true });
});

describe('setSessionsStatusInDb', () => {
  it('runs one sessions.setStatus tx and broadcasts per session after commit', async () => {
    h.tx.mockResolvedValueOnce([
      {
        sessionId: 's1',
        title: 'T1',
        workingDir: '/repo',
        workspaceKind: 'project',
        status: 'active',
      },
      {
        sessionId: 's2',
        title: 'T2',
        workingDir: null,
        workspaceKind: 'dialogue',
        status: 'active',
      },
    ]);

    const result = await setSessionsStatusInDb(['s1', 's2'], 'active');

    expect(h.tx).toHaveBeenCalledWith('sessions.setStatus', {
      sessionIds: ['s1', 's2'],
      status: 'active',
    });
    // 提交后逐个广播
    expect(h.tapWindowBroadcast).toHaveBeenCalledTimes(2);
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 's1',
      patch: { status: 'active' },
    });
    expect(h.webContentsSend).toHaveBeenCalledTimes(2);
    // 返回值是精简后的行(不含 workspaceKind)
    expect(result).toEqual([
      { sessionId: 's1', title: 'T1', workingDir: '/repo', status: 'active' },
      { sessionId: 's2', title: 'T2', workingDir: null, status: 'active' },
    ]);
  });

  it('does not broadcast anything when the tx rolls back (NOT_FOUND)', async () => {
    h.tx.mockRejectedValueOnce(
      Object.assign(new Error('Session 不存在: ghost'), { code: 'NOT_FOUND' }),
    );

    await expect(setSessionsStatusInDb(['s1', 'ghost'], 'archived')).rejects.toThrow('NOT_FOUND');

    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
    expect(h.webContentsSend).not.toHaveBeenCalled();
  });

  it('short-circuits empty input without touching the db', async () => {
    const result = await setSessionsStatusInDb([], 'active');
    expect(result).toEqual([]);
    expect(h.tx).not.toHaveBeenCalled();
  });

  it('does not schedule recycle when batch restores sessions to active', async () => {
    h.tx.mockResolvedValueOnce([
      {
        sessionId: 's1',
        title: 'T1',
        workingDir: '/repo',
        workspaceKind: 'project',
        status: 'active',
      },
    ]);

    await setSessionsStatusInDb(['s1'], 'active');

    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.recycleWorktreeForRemovedSession).not.toHaveBeenCalled();
  });

  it('acquires overlapping batch route locks once in stable order', async () => {
    h.tx.mockResolvedValueOnce([]);

    await setSessionsStatusInDb(['s2', 's1', 's2'], 'active');

    expect(h.withSendToSessionLock.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      's1',
      's2',
    ]);
    expect(h.tx).toHaveBeenCalledWith('sessions.setStatus', {
      sessionIds: ['s2', 's1', 's2'],
      status: 'active',
    });
  });

  it('rechecks current status before closing a session from a delayed archive task', async () => {
    h.tx.mockResolvedValueOnce([
      {
        sessionId: 's1',
        title: 'T1',
        workingDir: '/repo',
        workspaceKind: 'project',
        status: 'archived',
      },
    ]);
    h.isSessionStillRemovable.mockResolvedValueOnce(false);

    await setSessionsStatusInDb(['s1'], 'archived');
    await vi.waitFor(() => {
      expect(h.isSessionStillRemovable).toHaveBeenCalledWith('s1', h.drizzle);
    });

    // The status transaction itself is serialized; the delayed cleanup exits
    // before acquiring a second lock because the task is no longer removable.
    expect(h.withSendToSessionLock).toHaveBeenCalledTimes(1);
    expect(h.withSendToSessionLock).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(h.cancelSessionOperations).not.toHaveBeenCalled();
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.recycleWorktreeForRemovedSession).not.toHaveBeenCalled();
  });

  it('serializes archive-driven close with the session route lock', async () => {
    h.tx.mockResolvedValueOnce([
      {
        sessionId: 's1',
        title: 'T1',
        workingDir: '/repo',
        workspaceKind: 'project',
        status: 'archived',
      },
    ]);

    await setSessionsStatusInDb(['s1'], 'archived');
    await vi.waitFor(() => {
      expect(h.closeSession).toHaveBeenCalledWith('s1');
    });

    expect(h.withSendToSessionLock).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(h.isSessionStillRemovable).toHaveBeenCalledTimes(5);
    expect(h.cancelSessionOperations).toHaveBeenCalledWith('s1');
    expect(h.recycleWorktreeForRemovedSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ db: h.drizzle, isOwnerCurrent: expect.any(Function) }),
    );
  });

  it('broadcasts worktree:changed only after the recycle chain finishes', async () => {
    // renderer 的 WorktreeContext 靠这条推送才能拿到回收后的快照 —— 回收是异步链,
    // 状态 IPC 返回时 store 条目还在,归档动作里那次「顺手 refresh」必然是旧的。
    h.tx.mockResolvedValueOnce([
      {
        sessionId: 's1',
        title: 'T1',
        workingDir: '/repo',
        workspaceKind: 'project',
        status: 'archived',
      },
    ]);
    let finishRecycle!: () => void;
    h.recycleWorktreeForRemovedSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRecycle = () => resolve();
        }),
    );

    await setSessionsStatusInDb(['s1'], 'archived');
    await vi.waitFor(() => {
      expect(h.recycleWorktreeForRemovedSession).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ db: h.drizzle, isOwnerCurrent: expect.any(Function) }),
      );
    });

    // 回收还没结束 —— 此时只该有 sessions:patched，不能提前报 worktree 已变。
    expect(h.webContentsSend).not.toHaveBeenCalledWith('worktree:changed', expect.anything());

    finishRecycle();
    await vi.waitFor(() => {
      expect(h.webContentsSend).toHaveBeenCalledWith('worktree:changed', { sessionId: 's1' });
    });
  });

  it('still broadcasts worktree:changed when the recycle chain fails', async () => {
    // 回收失败/跳过时条目仍在 store 里，重拉拿到「徽标还在」也是真实状态。
    h.tx.mockResolvedValueOnce([
      {
        sessionId: 's1',
        title: 'T1',
        workingDir: '/repo',
        workspaceKind: 'project',
        status: 'archived',
      },
    ]);
    h.recycleWorktreeForRemovedSession.mockRejectedValueOnce(
      new Error('git worktree remove failed'),
    );

    await setSessionsStatusInDb(['s1'], 'archived');

    await vi.waitFor(() => {
      expect(h.webContentsSend).toHaveBeenCalledWith('worktree:changed', { sessionId: 's1' });
    });
  });

  it('does not broadcast worktree:changed when restoring to active', async () => {
    h.tx.mockResolvedValueOnce([
      {
        sessionId: 's1',
        title: 'T1',
        workingDir: '/repo',
        workspaceKind: 'project',
        status: 'active',
      },
    ]);

    await setSessionsStatusInDb(['s1'], 'active');

    expect(h.webContentsSend).not.toHaveBeenCalledWith('worktree:changed', expect.anything());
  });

  it('keeps batch archived status wired to worktree recycle scheduling', () => {
    const source = fs.readFileSync(new URL('../localDb/ipc/sessions.ts', import.meta.url), 'utf8');
    const batchBody = source.match(
      /export async function setSessionsStatusInDb[\s\S]*return applied\.map/,
    )?.[0];
    expect(batchBody).toContain(
      'scheduleWorktreeRecycleForStatusChange(item.sessionId, item.status, {',
    );
    expect(batchBody).toContain('ownerScope,');
    expect(batchBody).toContain('mediaDb: dbClient.drizzle,');
  });
});

describe('recycleSessionWorktreeForStatusChange', () => {
  it('runs the full runtime cleanup chain for archived sessions', async () => {
    await recycleSessionWorktreeForStatusChange('s1', 'archived');

    expect(h.withSendToSessionLock).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(h.cancelSessionOperations).toHaveBeenCalledWith('s1');
    expect(h.cleanupRemovedSession).toHaveBeenCalledWith('s1');
    expect(h.closeSession).toHaveBeenCalledWith('s1');
  });

  it('awaits the shared close and worktree recycle chain for deleted sessions', async () => {
    const order: string[] = [];
    h.cancelSessionOperations.mockImplementationOnce(async () => {
      order.push('cancel');
    });
    h.cleanupRemovedSession.mockImplementationOnce(async () => {
      order.push('cleanup');
    });
    h.removeSessionRefs.mockImplementationOnce(async () => {
      order.push('remove-media-refs');
      return 1;
    });
    h.recycleWorktreeForRemovedSession.mockImplementationOnce(async () => {
      order.push('recycle-worktree');
    });

    await recycleSessionWorktreeForStatusChange('s1', 'deleted');

    expect(h.withSendToSessionLock).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(h.isSessionStillRemovable).toHaveBeenCalledTimes(5);
    expect(h.cancelSessionOperations).toHaveBeenCalledWith('s1');
    expect(h.cleanupRemovedSession).toHaveBeenCalledWith('s1');
    expect(h.closeSession).toHaveBeenCalledWith('s1');
    expect(h.removeSessionRefs).toHaveBeenCalledWith('s1', h.drizzle);
    expect(h.recycleWorktreeForRemovedSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ db: h.drizzle, isOwnerCurrent: expect.any(Function) }),
    );
    expect(h.webContentsSend).toHaveBeenCalledWith('worktree:changed', { sessionId: 's1' });
    expect(order).toEqual(['cancel', 'cleanup', 'remove-media-refs', 'recycle-worktree']);
  });

  it('keeps media and worktree deletion inside the task route lock', async () => {
    let lockHeld = false;
    h.withSendToSessionLock.mockImplementationOnce(
      async <T>(_sessionId: string, task: () => Promise<T>): Promise<T> => {
        lockHeld = true;
        try {
          return await task();
        } finally {
          lockHeld = false;
        }
      },
    );
    h.removeSessionRefs.mockImplementationOnce(async () => {
      expect(lockHeld).toBe(true);
      return 1;
    });
    h.recycleWorktreeForRemovedSession.mockImplementationOnce(async () => {
      expect(lockHeld).toBe(true);
    });

    await recycleSessionWorktreeForStatusChange('s1', 'deleted');

    expect(lockHeld).toBe(false);
    expect(h.removeSessionRefs).toHaveBeenCalledWith('s1', h.drizzle);
    expect(h.recycleWorktreeForRemovedSession).toHaveBeenCalledOnce();
  });

  it('does not touch the runtime or worktree for active sessions', async () => {
    await recycleSessionWorktreeForStatusChange('s1', 'active');

    expect(h.isSessionStillRemovable).not.toHaveBeenCalled();
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.recycleWorktreeForRemovedSession).not.toHaveBeenCalled();
    expect(h.webContentsSend).not.toHaveBeenCalledWith('worktree:changed', expect.anything());
  });

  it('fails closed before closing or recycling when Host cleanup is not configured', async () => {
    setSessionRemovalCancelOperations(null);

    await recycleSessionWorktreeForStatusChange('s1', 'deleted');

    expect(h.isSessionStillRemovable).not.toHaveBeenCalled();
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.recycleWorktreeForRemovedSession).not.toHaveBeenCalled();
    expect(h.webContentsSend).toHaveBeenCalledWith('worktree:changed', { sessionId: 's1' });
  });

  it('does not remove media or recycle the worktree when Simulator cleanup fails', async () => {
    h.cleanupRemovedSession.mockRejectedValueOnce(new Error('simulator is still shutting down'));

    await recycleSessionWorktreeForStatusChange('s1', 'deleted');

    expect(h.cancelSessionOperations).toHaveBeenCalledWith('s1');
    expect(h.cleanupRemovedSession).toHaveBeenCalledWith('s1');
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.removeSessionRefs).not.toHaveBeenCalled();
    expect(h.recycleWorktreeForRemovedSession).not.toHaveBeenCalled();
    expect(h.webContentsSend).toHaveBeenCalledWith('worktree:changed', { sessionId: 's1' });
  });

  it('does not dynamically import the Simulator Host from the recycle path', () => {
    const source = fs.readFileSync(new URL('../localDb/ipc/sessions.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("import('../../mcp-integrations/ios-simulator.js')");
  });

  it('does not let a stale status write clean the next owner database', async () => {
    h.isOwnerScopeCurrent.mockReturnValue(false);

    await recycleSessionWorktreeForStatusChange('shared-session-id', 'deleted', {
      ownerScope: { ownerStamp: 'old-owner' } as never,
      mediaDb: h.drizzle as never,
    });

    expect(h.isSessionStillRemovable).not.toHaveBeenCalled();
    expect(h.cancelSessionOperations).not.toHaveBeenCalled();
    expect(h.cleanupRemovedSession).not.toHaveBeenCalled();
    expect(h.removeSessionRefs).not.toHaveBeenCalled();
    expect(h.recycleWorktreeForRemovedSession).not.toHaveBeenCalled();
  });

  it('stops after Agent close when the captured owner changes mid-cleanup', async () => {
    h.closeSession.mockImplementationOnce(async () => {
      h.isOwnerScopeCurrent.mockReturnValue(false);
    });

    await recycleSessionWorktreeForStatusChange('shared-session-id', 'deleted', {
      ownerScope: { ownerStamp: 'old-owner' } as never,
      mediaDb: h.drizzle as never,
    });

    expect(h.cancelSessionOperations).toHaveBeenCalledWith('shared-session-id');
    expect(h.cleanupRemovedSession).toHaveBeenCalledWith('shared-session-id');
    expect(h.closeSession).toHaveBeenCalledWith('shared-session-id');
    expect(h.removeSessionRefs).not.toHaveBeenCalled();
    expect(h.recycleWorktreeForRemovedSession).not.toHaveBeenCalled();
  });
});
