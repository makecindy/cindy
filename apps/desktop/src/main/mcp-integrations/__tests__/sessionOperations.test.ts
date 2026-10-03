/**
 * sessionOperations 骨架回归测试:各会话操作工具共用的行加载、GUI 同口径守卫
 * (远程 / 运行中 / IM 接管 / 伙伴 / 协同 worker / 已归档 / 空草稿 / review)与错误码映射。
 * 依赖全部注入,不加载 Electron。具体工具的业务体测试随各工具 PR 一起加。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  deleteSessions,
  lateGuard,
  loadAll,
  mapIpcError,
  mutationGuard,
  type SessionOperationsDeps,
  type SessionOpsRow,
} from '../sessionOperations.js';

function row(id: string, patch: Partial<SessionOpsRow> = {}): SessionOpsRow {
  return {
    id,
    title: `title-${id}`,
    workingDir: '/tmp/old',
    workspaceKind: 'project',
    status: 'active',
    source: 'user',
    remoteHostId: null,
    orcaRole: null,
    parentSessionId: null,
    forkedAtMessageId: null,
    createdAt: 1,
    messageCount: 3,
    ...patch,
  };
}

function makeDeps(rows: SessionOpsRow[], overrides: Partial<SessionOperationsDeps> = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  // 与 updateSessionInDb 同款:beforeWrite 在"锁内"执行,返回原因即以 PRECONDITION_FAILED 拒绝。
  const updateSession = vi.fn(
    async (
      id: string,
      patch: Record<string, unknown>,
      hooks?: { beforeWrite?: () => Promise<string | null> },
    ) => {
      const reason = await hooks?.beforeWrite?.();
      if (reason) throw Object.assign(new Error(`[PRECONDITION_FAILED] ${reason}`), { code: 'PRECONDITION_FAILED' });
      return { ...byId.get(id), ...patch };
    },
  );
  const deps: SessionOperationsDeps = {
    loadSessions: async (ids) => ids.flatMap((id) => (byId.has(id) ? [byId.get(id) as SessionOpsRow] : [])),
    loadChildren: async (parentIds) => rows.filter((r) => r.parentSessionId && parentIds.includes(r.parentSessionId)),
    listWorkerSessionIds: async () => [],
    isTurnRunning: () => false,
    isImAttached: () => false,
    updateSession,
    worktreeRemovalPreview: async () => ({ hasWorktree: false, dirty: false }),
    ...overrides,
  };
  return { deps, updateSession };
}

describe('loadAll', () => {
  it('returns every requested row in order', async () => {
    const { deps } = makeDeps([row('a'), row('b')]);
    const loaded = await loadAll(deps, ['a', 'b']);
    expect(Array.isArray(loaded) && loaded.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('NOT_FOUND when any id is missing — callers must not write a partial batch', async () => {
    const { deps } = makeDeps([row('a')]);
    expect(await loadAll(deps, ['a', 'missing'])).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
  });
});

describe('mutationGuard', () => {
  it('passes an ordinary active local session', async () => {
    const { deps } = makeDeps([row('a')]);
    expect(await mutationGuard(deps, row('a'))).toBeNull();
  });

  it('rejects SSH remote sessions', async () => {
    const { deps } = makeDeps([row('a')]);
    expect(await mutationGuard(deps, row('a', { remoteHostId: 'host' }))).toBeTruthy();
  });

  it('rejects deleted sessions', async () => {
    const { deps } = makeDeps([row('a')]);
    expect(await mutationGuard(deps, row('a', { status: 'deleted' }))).toBeTruthy();
  });

  it('rejects Bot-owned and Orca worker sessions, which the sidebar never lists', async () => {
    const { deps } = makeDeps([row('a')]);
    expect(await mutationGuard(deps, row('a', { source: 'bot' }))).toBeTruthy();
    expect(await mutationGuard(deps, row('a', { orcaRole: 'worker' }))).toBeTruthy();
  });

  it('rejects a running session', async () => {
    const { deps } = makeDeps([row('a')], { isTurnRunning: (id) => id === 'a' });
    expect(await mutationGuard(deps, row('a'))).toBeTruthy();
  });

  it('rejects an Orca lead whose worker is running', async () => {
    const { deps } = makeDeps([row('lead', { orcaRole: 'lead' })], {
      listWorkerSessionIds: async () => ['w1'],
      isTurnRunning: (id) => id === 'w1',
    });
    expect(await mutationGuard(deps, row('lead', { orcaRole: 'lead' }))).toBeTruthy();
  });

  it('rejects a session currently controlled over IM', async () => {
    const { deps } = makeDeps([row('a')], { isImAttached: () => true });
    expect(await mutationGuard(deps, row('a'))).toBeTruthy();
  });
});

describe('lateGuard', () => {
  it('passes when nothing changed since the precheck', async () => {
    const { deps } = makeDeps([row('a')]);
    expect(await lateGuard(deps, 'a', { allowArchived: false })).toBeNull();
  });

  it('rejects a session deleted between precheck and write', async () => {
    const { deps } = makeDeps([row('a', { status: 'deleted' })]);
    expect(await lateGuard(deps, 'a', { allowArchived: false })).toBeTruthy();
  });

  it('rejects a session archived in between unless the caller allows archived', async () => {
    const { deps } = makeDeps([row('a', { status: 'archived' })]);
    expect(await lateGuard(deps, 'a', { allowArchived: false })).toBeTruthy();
    expect(await lateGuard(deps, 'a', { allowArchived: true })).toBeNull();
  });

  it('rejects a session that started running, or got taken over, before the write', async () => {
    const running = makeDeps([row('a')], { isTurnRunning: () => true }).deps;
    expect(await lateGuard(running, 'a', { allowArchived: false })).toBeTruthy();
    const attached = makeDeps([row('a')], { isImAttached: () => true }).deps;
    expect(await lateGuard(attached, 'a', { allowArchived: false })).toBeTruthy();
  });

  it('rejects a session that disappeared entirely', async () => {
    const { deps } = makeDeps([]);
    expect(await lateGuard(deps, 'gone', { allowArchived: true })).toBeTruthy();
  });
});

describe('mapIpcError', () => {
  it('keeps the structured business code from an IPC error', () => {
    const e = Object.assign(new Error('[PRECONDITION_FAILED] busy'), { code: 'PRECONDITION_FAILED' });
    expect(mapIpcError(e)).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
  });

  it('falls back to INTERNAL for an unknown throw', () => {
    expect(mapIpcError(new Error('boom'))).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
  });
});

describe('deleteSessions', () => {
  it('dry run previews dirty worktrees without writing', async () => {
    const { deps, updateSession } = makeDeps([row('a'), row('b')], {
      worktreeRemovalPreview: async (id) => ({ hasWorktree: id === 'b', dirty: true }),
    });
    const res = await deleteSessions(deps, { sessionIds: ['a', 'b'], dryRun: true });
    expect(res).toMatchObject({
      ok: true,
      items: [
        { sessionId: 'a', dirtyWorktree: false, dirtyWorktreeUnknown: false },
        { sessionId: 'b', dirtyWorktree: true, dirtyWorktreeUnknown: false },
      ],
    });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('treats a failed worktree preview as dirty and flags it unknown', async () => {
    const { deps } = makeDeps([row('a')], {
      worktreeRemovalPreview: async () => {
        throw new Error('git status failed');
      },
    });
    const res = await deleteSessions(deps, { sessionIds: ['a'], dryRun: true });
    expect(res).toMatchObject({ ok: true, items: [{ dirtyWorktree: true, dirtyWorktreeUnknown: true }] });
  });

  it('soft-deletes via status=deleted with an in-lock recheck and allows archived sessions', async () => {
    const { deps, updateSession } = makeDeps([row('a', { status: 'archived' })]);
    const res = await deleteSessions(deps, { sessionIds: ['a'], dryRun: false });
    expect(updateSession.mock.calls[0].slice(0, 2)).toEqual(['a', { status: 'deleted' }]);
    expect(updateSession.mock.calls[0][2]?.beforeWrite).toBeTypeOf('function');
    expect(res).toMatchObject({ ok: true, items: [{ sessionId: 'a', status: 'deleted' }] });
  });

  it('refuses when the previewed dirty state changed before the real delete', async () => {
    const { deps, updateSession } = makeDeps([row('a')], {
      worktreeRemovalPreview: async () => ({ hasWorktree: true, dirty: true }),
    });
    const res = await deleteSessions(deps, { sessionIds: ['a'], dryRun: false, expectedDirty: { a: false } });
    expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('rechecks running state inside the write lock and preserves deleted items', async () => {
    let checks = 0;
    const { deps, updateSession } = makeDeps([row('a'), row('b')], {
      isTurnRunning: (id) => id === 'b' && ++checks > 1,
    });
    const res = await deleteSessions(deps, { sessionIds: ['a', 'b'], dryRun: false });
    expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED', items: [{ sessionId: 'a' }] });
    expect(updateSession).toHaveBeenCalledTimes(2);
  });

  it.each<[string, Partial<SessionOpsRow>, Partial<SessionOperationsDeps>]>([
    ['remote', { remoteHostId: 'host' }, {}],
    ['deleted', { status: 'deleted' }, {}],
    ['bot', { source: 'bot' }, {}],
    ['worker', { orcaRole: 'worker' }, {}],
    ['running', {}, { isTurnRunning: (id) => id === 'b' }],
    ['IM attached', {}, { isImAttached: (id) => id === 'b' }],
  ])('PRECONDITION_FAILED (%s) blocks the whole batch', async (_name, patch, overrides) => {
    const { deps, updateSession } = makeDeps([row('a'), row('b', patch)], overrides);
    const res = await deleteSessions(deps, { sessionIds: ['a', 'b'], dryRun: false });
    expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('NOT_FOUND for any missing id writes nothing and mapped codes survive update failures', async () => {
    const { deps, updateSession } = makeDeps([row('a')]);
    expect(await deleteSessions(deps, { sessionIds: ['a', 'ghost'], dryRun: false })).toMatchObject({
      ok: false,
      errorCode: 'NOT_FOUND',
    });
    expect(updateSession).not.toHaveBeenCalled();
    const { deps: failing } = makeDeps([row('a'), row('b')], {
      updateSession: vi.fn(async (id: string) => {
        if (id === 'b') throw Object.assign(new Error('[NOT_FOUND] gone'), { code: 'NOT_FOUND' });
        return {};
      }),
    });
    expect(await deleteSessions(failing, { sessionIds: ['a', 'b'], dryRun: false })).toMatchObject({
      ok: false,
      errorCode: 'NOT_FOUND',
      items: [{ sessionId: 'a' }],
    });
  });
});
