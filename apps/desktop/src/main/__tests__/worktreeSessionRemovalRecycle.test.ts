/**
 * sessionRemovalRecycle 回归(P0 重构:回收唯一驱动点):
 *   - ephemeral worktree 跳过(池生命周期)
 *   - 非 ephemeral → removeWorktreeForSession
 *   - 共享会话进入 archived/deleted 后按安全路径关系重试 owner 回收
 *   - 启动对账:只补收 deleted / 行缺失的孤儿,active / archived 保留;DB 失败零删除
 */
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorktreeMeta } from '../worktree/types';

interface SessionRow {
  id: string;
  status: string | null | undefined;
  workingDir: string | null;
  worktreePath: string | null;
}

const removeMock = vi.fn();
const storeMap = new Map<string, WorktreeMeta>();
const sessionRows: SessionRow[] = [];
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
          where: (condition: { queryChunks?: unknown[] }) => {
            if (sessionLookupError) throw sessionLookupError;
            const sessionId = (condition?.queryChunks?.[3] as { value?: unknown } | undefined)
              ?.value;
            return typeof sessionId === 'string'
              ? sessionRows.filter((row) => row.id === sessionId)
              : sessionRows;
          },
        }),
      }),
    },
  }),
}));

const BASE_REPO = path.resolve('/repo');

function makeMeta(sessionId: string, ephemeral = false, name = sessionId): WorktreeMeta {
  return {
    sessionId,
    name,
    path: path.join(BASE_REPO, '.xdt-worktrees', name),
    baseRepo: BASE_REPO,
    branch: `xdt/${name}`,
    sourceBranch: 'main',
    createdAt: '2026-07-01T00:00:00.000Z',
    ephemeral,
  };
}

function addSession(
  id: string,
  status: string | null | undefined,
  paths: Partial<Pick<SessionRow, 'workingDir' | 'worktreePath'>> = {},
): SessionRow {
  const row: SessionRow = {
    id,
    status,
    workingDir: paths.workingDir ?? null,
    worktreePath: paths.worktreePath ?? null,
  };
  sessionRows.push(row);
  return row;
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
    it('no store entry and no matching owner → no-op', async () => {
      addSession('nope', 'archived');

      await mod.recycleWorktreeForRemovedSession('nope');

      expect(removeMock).not.toHaveBeenCalled();
    });

    it('ephemeral worktree is pool-managed, skipped', async () => {
      storeMap.set('s1', makeMeta('s1', true));
      addSession('s1', 'archived');
      await mod.recycleWorktreeForRemovedSession('s1');
      expect(removeMock).not.toHaveBeenCalled();
    });

    it('non-ephemeral worktree is removed', async () => {
      storeMap.set('s1', makeMeta('s1'));
      addSession('s1', 'archived');
      await mod.recycleWorktreeForRemovedSession('s1');
      expect(removeMock).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ canRemove: expect.any(Function) }),
      );
    });

    it('passes a live status guard that observes an unarchive during recycle', async () => {
      storeMap.set('s1', makeMeta('s1'));
      const owner = addSession('s1', 'archived');
      removeMock.mockImplementationOnce(
        async (_sessionId: string, options: { canRemove: () => Promise<boolean> }) => {
          await expect(options.canRemove()).resolves.toBe(true);
          owner.status = 'active';
          await expect(options.canRemove()).resolves.toBe(false);
        },
      );

      await mod.recycleWorktreeForRemovedSession('s1');

      expect(removeMock).toHaveBeenCalledTimes(1);
    });

    it('active again before recycle runs → preserves worktree', async () => {
      storeMap.set('s1', makeMeta('s1'));
      addSession('s1', 'active');

      await mod.recycleWorktreeForRemovedSession('s1');

      expect(removeMock).not.toHaveBeenCalled();
    });

    it('status lookup failure → preserves worktree', async () => {
      storeMap.set('s1', makeMeta('s1'));
      sessionLookupError = new Error('db closed');

      await mod.recycleWorktreeForRemovedSession('s1');

      expect(removeMock).not.toHaveBeenCalled();
    });

    it('shared session with its own store meta still retries the owner after processing itself', async () => {
      const ownerMeta = makeMeta('owner');
      const sharedMeta = makeMeta('shared');
      storeMap.set('owner', ownerMeta);
      storeMap.set('shared', sharedMeta);
      addSession('owner', 'archived', { worktreePath: ownerMeta.path });
      addSession('shared', 'archived', { workingDir: ownerMeta.path });
      const removalOrder: string[] = [];
      removeMock.mockImplementation(async (sessionId: string) => {
        removalOrder.push(sessionId);
      });
      const recycleOwner = vi.fn(async (ownerSessionId: string) => {
        await mod.recycleWorktreeForRemovedSession(ownerSessionId, { scanOwners: false });
      });

      await mod.recycleWorktreeForRemovedSession('shared', { recycleOwner });

      expect(recycleOwner).toHaveBeenCalledWith('owner');
      expect(removalOrder).toEqual(['shared', 'owner']);
      expect(removeMock).toHaveBeenNthCalledWith(
        1,
        'shared',
        expect.objectContaining({ canRemove: expect.any(Function) }),
      );
      expect(removeMock).toHaveBeenNthCalledWith(
        2,
        'owner',
        expect.objectContaining({ canRemove: expect.any(Function) }),
      );
    });

    it('ephemeral terminal session still scans and retries a matching owner', async () => {
      const ownerMeta = makeMeta('owner');
      storeMap.set('shared', makeMeta('shared', true));
      storeMap.set('owner', ownerMeta);
      addSession('shared', 'archived', { workingDir: ownerMeta.path });
      addSession('owner', 'archived', { worktreePath: ownerMeta.path });
      const recycleOwner = vi.fn(async (ownerSessionId: string) => {
        await mod.recycleWorktreeForRemovedSession(ownerSessionId, { scanOwners: false });
      });

      await mod.recycleWorktreeForRemovedSession('shared', { recycleOwner });

      expect(recycleOwner).toHaveBeenCalledWith('owner');
      expect(removeMock).toHaveBeenCalledTimes(1);
      expect(removeMock).toHaveBeenCalledWith(
        'owner',
        expect.objectContaining({ canRemove: expect.any(Function) }),
      );
    });

    it('owner scan is fail-closed when its status lookup fails', async () => {
      const ownerMeta = makeMeta('owner');
      storeMap.set('owner', ownerMeta);
      addSession('shared', 'archived', { workingDir: ownerMeta.path });
      sessionLookupError = new Error('db closed');

      await mod.recycleWorktreeForRemovedSession('shared');

      expect(removeMock).not.toHaveBeenCalled();
    });

    it.each(['archived', 'deleted'])(
      'shared session %s retriggers an archived owner by exact worktree path',
      async (sharedStatus) => {
        const ownerMeta = makeMeta('owner');
        storeMap.set('owner', ownerMeta);
        addSession('owner', 'archived', { worktreePath: ownerMeta.path });
        addSession('shared', sharedStatus, { workingDir: ownerMeta.path });
        const recycleOwner = vi.fn(async (ownerSessionId: string) => {
          await mod.recycleWorktreeForRemovedSession(ownerSessionId, { scanOwners: false });
        });

        await mod.recycleWorktreeForRemovedSession('shared', { recycleOwner });

        expect(recycleOwner).toHaveBeenCalledWith('owner');
        expect(removeMock).toHaveBeenCalledWith(
          'owner',
          expect.objectContaining({ canRemove: expect.any(Function) }),
        );
      },
    );

    it('shared nested workingDir safely retriggers its owner, not a sibling prefix', async () => {
      const ownerMeta = makeMeta('owner', false, 'project');
      const siblingMeta = makeMeta('sibling', false, 'project-copy');
      storeMap.set('owner', ownerMeta);
      storeMap.set('sibling', siblingMeta);
      addSession('owner', 'archived', { worktreePath: ownerMeta.path });
      addSession('sibling', 'archived', { worktreePath: siblingMeta.path });
      addSession('shared', 'archived', {
        workingDir: path.join(ownerMeta.path, 'packages', 'desktop'),
      });
      const recycleOwner = vi.fn(async (ownerSessionId: string) => {
        await mod.recycleWorktreeForRemovedSession(ownerSessionId, { scanOwners: false });
      });

      await mod.recycleWorktreeForRemovedSession('shared', { recycleOwner });

      expect(recycleOwner).toHaveBeenCalledTimes(1);
      expect(recycleOwner).toHaveBeenCalledWith('owner');
      expect(removeMock).toHaveBeenCalledTimes(1);
      expect(removeMock).toHaveBeenCalledWith(
        'owner',
        expect.objectContaining({ canRemove: expect.any(Function) }),
      );
    });

    it('owner archived first, then shared archived → first retry can preserve and later event retries', async () => {
      const ownerMeta = makeMeta('owner');
      storeMap.set('owner', ownerMeta);
      addSession('owner', 'archived', { worktreePath: ownerMeta.path });
      const shared = addSession('shared', 'active', { workingDir: ownerMeta.path });

      await mod.recycleWorktreeForRemovedSession('owner');
      expect(removeMock).toHaveBeenCalledTimes(1);

      removeMock.mockClear();
      shared.status = 'archived';
      const recycleOwner = vi.fn(async (ownerSessionId: string) => {
        await mod.recycleWorktreeForRemovedSession(ownerSessionId, { scanOwners: false });
      });
      await mod.recycleWorktreeForRemovedSession('shared', { recycleOwner });

      expect(recycleOwner).toHaveBeenCalledWith('owner');
      expect(removeMock).toHaveBeenCalledTimes(1);
      expect(removeMock).toHaveBeenCalledWith(
        'owner',
        expect.objectContaining({ canRemove: expect.any(Function) }),
      );
    });

    it('batch-style and duplicate terminal events are idempotent after owner store removal', async () => {
      const ownerMeta = makeMeta('owner');
      storeMap.set('owner', ownerMeta);
      addSession('owner', 'archived', { worktreePath: ownerMeta.path });
      addSession('shared-1', 'archived', { workingDir: ownerMeta.path });
      addSession('shared-2', 'archived', { workingDir: ownerMeta.path });
      removeMock.mockImplementation(async (sessionId: string) => {
        storeMap.delete(sessionId);
      });
      const recycleOwner = async (ownerSessionId: string): Promise<void> => {
        await mod.recycleWorktreeForRemovedSession(ownerSessionId, { scanOwners: false });
      };

      await mod.recycleWorktreeForRemovedSession('shared-1', { recycleOwner });
      await mod.recycleWorktreeForRemovedSession('shared-2', { recycleOwner });
      await mod.recycleWorktreeForRemovedSession('shared-1', { recycleOwner });

      expect(removeMock).toHaveBeenCalledTimes(1);
      expect(removeMock).toHaveBeenCalledWith(
        'owner',
        expect.objectContaining({ canRemove: expect.any(Function) }),
      );
    });

    it.each([
      ['active', 'active'],
      ['NULL', null],
      ['unknown', 'paused'],
    ] as const)(
      'shared %s status conservatively preserves the owner',
      async (_label, sharedStatus) => {
        const ownerMeta = makeMeta('owner');
        storeMap.set('owner', ownerMeta);
        addSession('owner', 'archived', { worktreePath: ownerMeta.path });
        addSession('shared', sharedStatus, { workingDir: ownerMeta.path });

        await mod.recycleWorktreeForRemovedSession('shared');

        expect(removeMock).not.toHaveBeenCalled();
      },
    );

    it('shared session lookup failure conservatively preserves the owner', async () => {
      const ownerMeta = makeMeta('owner');
      storeMap.set('owner', ownerMeta);
      addSession('owner', 'archived', { worktreePath: ownerMeta.path });
      sessionLookupError = new Error('db closed');

      await mod.recycleWorktreeForRemovedSession('shared');

      expect(removeMock).not.toHaveBeenCalled();
    });

    it('owner restored to active before shared terminal event is not removed', async () => {
      const ownerMeta = makeMeta('owner');
      storeMap.set('owner', ownerMeta);
      addSession('owner', 'active', { worktreePath: ownerMeta.path });
      addSession('shared', 'archived', { workingDir: ownerMeta.path });

      await mod.recycleWorktreeForRemovedSession('shared');

      expect(removeMock).not.toHaveBeenCalled();
    });

    it('uses the captured owner database and stops its live guard after owner switch', async () => {
      storeMap.set('shared-session-id', makeMeta('shared-session-id'));
      sessionRows.push({ id: 'shared-session-id', status: 'active', workingDir: null, worktreePath: null });
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
      const row = addSession('s1', 'archived');
      await expect(mod.isSessionStillRemovable('s1')).resolves.toBe(true);

      row.status = 'active';
      await expect(mod.isSessionStillRemovable('s1')).resolves.toBe(false);
    });

    it('fails closed when the status lookup fails', async () => {
      sessionLookupError = new Error('db closed');
      await expect(mod.isSessionStillRemovable('s1')).resolves.toBe(false);
    });

    it('uses an explicitly captured database instead of the current global owner', async () => {
      sessionRows.push({ id: 'shared-session-id', status: 'active', workingDir: null, worktreePath: null });
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
      addSession('active', 'active');
      addSession('archived', 'archived');
      addSession('deleted', 'deleted');
      // 'missing' 无行 → 视为孤儿; 'eph' 是 ephemeral 不进候选

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
