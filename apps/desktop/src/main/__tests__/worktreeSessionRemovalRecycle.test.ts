/**
 * sessionRemovalRecycle 回归(P0 重构:回收唯一驱动点):
 *   - ephemeral worktree 跳过(池生命周期)
 *   - 非 ephemeral → removeWorktreeForSession
 *   - 启动对账:只补收 deleted / 行缺失的孤儿,active / archived 保留;DB 失败零删除
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import type { WorktreeMeta } from '../worktree/types';

const removeMock = vi.fn();
const storeMap = new Map<string, WorktreeMeta>();
const sessionRows: Array<{ id: string; status: string | null }> = [];
let sessionLookupError: Error | null = null;

vi.mock('../worktree/WorktreeManager', () => ({
  removeWorktreeForSession: (...args: unknown[]) => removeMock(...args),
}));

vi.mock('../worktree/worktreeStore', () => ({
  get: (sessionId: string) => storeMap.get(sessionId) ?? null,
  getAll: () => [...storeMap.values()],
}));

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => {
            if (sessionLookupError) throw sessionLookupError;
            return sessionRows;
          },
        }),
      }),
    },
  }),
}));

const BASE_REPO = path.resolve('/repo');

function makeMeta(sessionId: string, ephemeral = false): WorktreeMeta {
  return {
    sessionId,
    name: sessionId,
    path: path.join(BASE_REPO, '.xdt-worktrees', sessionId),
    baseRepo: BASE_REPO,
    branch: `xdt/${sessionId}`,
    sourceBranch: 'main',
    createdAt: '2026-07-01T00:00:00.000Z',
    ephemeral,
  };
}

function dbFor(rows: Array<{ id: string; status: string | null }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => rows,
      }),
    }),
  };
}

describe('sessionRemovalRecycle', () => {
  let mod: typeof import('../worktree/sessionRemovalRecycle');

  beforeEach(async () => {
    storeMap.clear();
    sessionRows.length = 0;
    sessionLookupError = null;
    removeMock.mockReset().mockResolvedValue(undefined);
    mod = await import('../worktree/sessionRemovalRecycle');
  });

  describe('recycleWorktreeForRemovedSession', () => {
    it('no store entry → no-op', async () => {
      await mod.recycleWorktreeForRemovedSession('nope');
      expect(removeMock).not.toHaveBeenCalled();
    });

    it('ephemeral worktree is pool-managed, skipped', async () => {
      storeMap.set('s1', makeMeta('s1', true));
      sessionRows.push({ id: 's1', status: 'archived' });
      await mod.recycleWorktreeForRemovedSession('s1');
      expect(removeMock).not.toHaveBeenCalled();
    });

    it('non-ephemeral worktree is removed', async () => {
      storeMap.set('s1', makeMeta('s1'));
      sessionRows.push({ id: 's1', status: 'archived' });
      await mod.recycleWorktreeForRemovedSession('s1');
      expect(removeMock).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ canRemove: expect.any(Function) }),
      );
    });

    it('passes a live status guard that observes an unarchive during recycle', async () => {
      storeMap.set('s1', makeMeta('s1'));
      sessionRows.push({ id: 's1', status: 'archived' });
      removeMock.mockImplementationOnce(
        async (_sessionId: string, options: { canRemove: () => Promise<boolean> }) => {
          await expect(options.canRemove()).resolves.toBe(true);
          sessionRows[0]!.status = 'active';
          await expect(options.canRemove()).resolves.toBe(false);
        },
      );

      await mod.recycleWorktreeForRemovedSession('s1');

      expect(removeMock).toHaveBeenCalledTimes(1);
    });

    it('active again before recycle runs → preserves worktree', async () => {
      storeMap.set('s1', makeMeta('s1'));
      sessionRows.push({ id: 's1', status: 'active' });

      await mod.recycleWorktreeForRemovedSession('s1');

      expect(removeMock).not.toHaveBeenCalled();
    });

    it('status lookup failure → preserves worktree', async () => {
      storeMap.set('s1', makeMeta('s1'));
      sessionLookupError = new Error('db closed');

      await mod.recycleWorktreeForRemovedSession('s1');

      expect(removeMock).not.toHaveBeenCalled();
    });

    it('uses the captured owner database and stops its live guard after owner switch', async () => {
      storeMap.set('shared-session-id', makeMeta('shared-session-id'));
      sessionRows.push({ id: 'shared-session-id', status: 'active' });
      const capturedRows = [{ id: 'shared-session-id', status: 'deleted' as string | null }];
      let ownerCurrent = true;
      removeMock.mockImplementationOnce(
        async (_sessionId: string, options: { canRemove: () => Promise<boolean> }) => {
          await expect(options.canRemove()).resolves.toBe(true);
          ownerCurrent = false;
          await expect(options.canRemove()).resolves.toBe(false);
        },
      );

      await mod.recycleWorktreeForRemovedSession('shared-session-id', {
        db: dbFor(capturedRows) as never,
        isOwnerCurrent: () => ownerCurrent,
      });

      expect(removeMock).toHaveBeenCalledOnce();
    });
  });

  describe('isSessionStillRemovable', () => {
    it('accepts only the current deleted/archived states', async () => {
      sessionRows.push({ id: 's1', status: 'archived' });
      await expect(mod.isSessionStillRemovable('s1')).resolves.toBe(true);

      sessionRows[0]!.status = 'active';
      await expect(mod.isSessionStillRemovable('s1')).resolves.toBe(false);
    });

    it('fails closed when the status lookup fails', async () => {
      sessionLookupError = new Error('db closed');
      await expect(mod.isSessionStillRemovable('s1')).resolves.toBe(false);
    });

    it('uses an explicitly captured database instead of the current global owner', async () => {
      sessionRows.push({ id: 'shared-session-id', status: 'active' });
      const capturedDb = dbFor([{ id: 'shared-session-id', status: 'archived' }]);

      await expect(
        mod.isSessionStillRemovable('shared-session-id', capturedDb as never),
      ).resolves.toBe(true);
    });
  });

  describe('reconcileWorktreesForDeletedSessions', () => {
    it('recycles only deleted / missing owners; active and archived preserved', async () => {
      storeMap.set('active', makeMeta('active'));
      storeMap.set('archived', makeMeta('archived'));
      storeMap.set('deleted', makeMeta('deleted'));
      storeMap.set('missing', makeMeta('missing'));
      storeMap.set('eph', makeMeta('eph', true));
      sessionRows.push(
        { id: 'active', status: 'active' },
        { id: 'archived', status: 'archived' },
        { id: 'deleted', status: 'deleted' },
        // 'missing' 无行 → 视为孤儿; 'eph' 是 ephemeral 不进候选
      );

      await mod.reconcileWorktreesForDeletedSessions();

      const removed = removeMock.mock.calls.map((c) => c[0]).sort();
      expect(removed).toEqual(['deleted', 'missing']);
    });

    it('empty store → no db query, no removals', async () => {
      sessionLookupError = new Error('should not query');
      await mod.reconcileWorktreesForDeletedSessions();
      expect(removeMock).not.toHaveBeenCalled();
    });

    it('db failure → zero removals (conservative)', async () => {
      storeMap.set('deleted', makeMeta('deleted'));
      sessionLookupError = new Error('db closed');

      await mod.reconcileWorktreesForDeletedSessions();

      expect(removeMock).not.toHaveBeenCalled();
    });

    it('single remove failure does not abort the rest', async () => {
      storeMap.set('d1', makeMeta('d1'));
      storeMap.set('d2', makeMeta('d2'));
      removeMock.mockRejectedValueOnce(new Error('locked'));

      await mod.reconcileWorktreesForDeletedSessions();

      expect(removeMock).toHaveBeenCalledTimes(2);
    });
  });
});
