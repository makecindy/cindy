/**
 * sessionOperations 业务体回归测试:GUI 同口径守卫(远程 / 运行中 / IM 接管 / 已归档 /
 * 空草稿 / review)、NOT_FOUND 整批不写、逐个应用与中途失败的返回形状、fork 错误码映射、
 * 分支家族遍历。依赖全部注入,不加载 Electron。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  deleteSessions,
  exportSession,
  forkSession,
  getSessionBranches,
  moveSessions,
  openSessionInNewWindow,
  setSessionsPinned,
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
  const updateSession = vi.fn(async (id: string, patch: Record<string, unknown>) => ({
    ...byId.get(id),
    ...patch,
  }));
  const deps: SessionOperationsDeps = {
    loadSessions: async (ids) => ids.flatMap((id) => (byId.has(id) ? [byId.get(id) as SessionOpsRow] : [])),
    loadChildren: async (parentIds) => rows.filter((r) => r.parentSessionId && parentIds.includes(r.parentSessionId)),
    listWorkerSessionIds: async () => [],
    isTurnRunning: () => false,
    isImAttached: () => false,
    isDirectory: async () => true,
    updateSession,
    worktreeRemovalPreview: async () => ({ hasWorktree: false, dirty: false }),
    exportShare: async ({ targetPath }) => ({ status: 'ok', filePath: targetPath, fidelity: 'full', missingTranscripts: [], mediaMissing: 0, orcaWorkers: 0 }),
    openInNewWindow: vi.fn(),
    resolveMessageClientId: async () => 'client-1',
    forkAtMessage: async () => ({ id: 'forked' }),
    ...overrides,
  };
  return { deps, updateSession };
}

const toProject = { kind: 'project' as const, workingDir: '/tmp/new' };

describe('moveSessions', () => {
  it('applies the GUI patch through updateSession for every id', async () => {
    const { deps, updateSession } = makeDeps([row('a'), row('b')]);
    const res = await moveSessions(deps, { sessionIds: ['a', 'b'], target: toProject });
    expect(res.ok).toBe(true);
    expect(updateSession.mock.calls.map((c) => c[1])).toEqual([
      { workingDir: '/tmp/new', workspaceKind: 'project' },
      { workingDir: '/tmp/new', workspaceKind: 'project' },
    ]);
    if (res.ok) expect(res.moved.map((m) => m.workingDir)).toEqual(['/tmp/new', '/tmp/new']);
  });

  it('moves to dialogue with workspaceKind only', async () => {
    const { deps, updateSession } = makeDeps([row('a')]);
    await moveSessions(deps, { sessionIds: ['a'], target: { kind: 'dialogue' } });
    expect(updateSession).toHaveBeenCalledWith('a', { workspaceKind: 'dialogue' });
  });

  it('NOT_FOUND for any missing id writes nothing', async () => {
    const { deps, updateSession } = makeDeps([row('a')]);
    const res = await moveSessions(deps, { sessionIds: ['a', 'ghost'], target: toProject });
    expect(res).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('INVALID_ARGS when working_dir is not a directory', async () => {
    const { deps, updateSession } = makeDeps([row('a')], { isDirectory: async () => false });
    const res = await moveSessions(deps, { sessionIds: ['a'], target: toProject });
    expect(res).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<SessionOpsRow>, Partial<SessionOperationsDeps>]>([
    ['remote', { remoteHostId: 'host' }, {}],
    ['deleted', { status: 'deleted' }, {}],
    ['archived', { status: 'archived' }, {}],
    ['review', { source: 'review' }, {}],
    ['empty draft', { title: 'New Maker', messageCount: 0 }, {}],
    ['running', {}, { isTurnRunning: (id) => id === 'b' }],
    ['lead with running worker', { orcaRole: 'lead' }, { listWorkerSessionIds: async () => ['w'], isTurnRunning: (id) => id === 'w' }],
    ['IM attached', {}, { isImAttached: (id) => id === 'b' }],
  ])('PRECONDITION_FAILED (%s) blocks the whole batch', async (_name, patch, overrides) => {
    const { deps, updateSession } = makeDeps([row('a'), row('b', patch)], overrides);
    const res = await moveSessions(deps, { sessionIds: ['a', 'b'], target: toProject });
    expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
    if (!res.ok) expect(res.message).toContain('b: ');
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('reports partial progress when a later update fails', async () => {
    const { deps } = makeDeps([row('a'), row('b')], {
      updateSession: vi.fn(async (id: string) => {
        if (id === 'b') throw new Error('disk on fire');
        return {};
      }),
    });
    const res = await moveSessions(deps, { sessionIds: ['a', 'b'], target: toProject });
    expect(res).toMatchObject({ ok: false, errorCode: 'INTERNAL', moved: [{ sessionId: 'a' }] });
  });
});

describe('setSessionsPinned', () => {
  it('writes pinnedAt ISO / null through updateSession', async () => {
    const { deps, updateSession } = makeDeps([row('a')]);
    await setSessionsPinned(deps, { sessionIds: ['a'], pinned: true });
    expect(typeof updateSession.mock.calls[0][1].pinnedAt).toBe('string');
    await setSessionsPinned(deps, { sessionIds: ['a'], pinned: false });
    expect(updateSession.mock.calls[1][1]).toEqual({ pinnedAt: null });
  });

  it('refuses archived sessions', async () => {
    const { deps, updateSession } = makeDeps([row('a', { status: 'archived' })]);
    const res = await setSessionsPinned(deps, { sessionIds: ['a'], pinned: true });
    expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
    expect(updateSession).not.toHaveBeenCalled();
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
      items: [{ sessionId: 'a', dirtyWorktree: false }, { sessionId: 'b', dirtyWorktree: true }],
    });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('soft-deletes via status=deleted and allows archived sessions', async () => {
    const { deps, updateSession } = makeDeps([row('a', { status: 'archived' })]);
    const res = await deleteSessions(deps, { sessionIds: ['a'], dryRun: false });
    expect(updateSession).toHaveBeenCalledWith('a', { status: 'deleted' });
    expect(res).toMatchObject({ ok: true, items: [{ sessionId: 'a', status: 'deleted' }] });
  });

  it('blocks running / remote / attached sessions', async () => {
    const { deps, updateSession } = makeDeps([row('a'), row('b')], { isImAttached: (id) => id === 'b' });
    const res = await deleteSessions(deps, { sessionIds: ['a', 'b'], dryRun: false });
    expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
    expect(updateSession).not.toHaveBeenCalled();
  });
});

describe('exportSession', () => {
  it('appends the share extension and validates the parent directory', async () => {
    const exportShare = vi.fn(async ({ targetPath }: { targetPath: string }) => ({
      status: 'ok' as const,
      filePath: targetPath,
      fidelity: 'full',
      missingTranscripts: [],
      mediaMissing: 0,
      orcaWorkers: 0,
    }));
    const { deps } = makeDeps([row('a')], { exportShare });
    const res = await exportSession(deps, { sessionId: 'a', targetPath: '/tmp/out/x', password: null, excludeMedia: false }, '.cshare');
    expect(exportShare).toHaveBeenCalledWith(expect.objectContaining({ targetPath: '/tmp/out/x.cshare' }));
    expect(res).toMatchObject({ ok: true, filePath: '/tmp/out/x.cshare' });

    const { deps: bad } = makeDeps([row('a')], { isDirectory: async () => false });
    const res2 = await exportSession(bad, { sessionId: 'a', targetPath: '/nope/x', password: null, excludeMedia: false }, '.cshare');
    expect(res2).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  });

  it('maps oversize and coded errors', async () => {
    const { deps } = makeDeps([row('a')], {
      exportShare: async () => ({ status: 'oversize', totalBytes: 10, mediaBytes: 8, limitBytes: 5 }),
    });
    const res = await exportSession(deps, { sessionId: 'a', targetPath: '/tmp/x.cshare', password: null, excludeMedia: false }, '.cshare');
    expect(res).toMatchObject({ ok: false, errorCode: 'OVERSIZE', data: { limit_bytes: 5 } });

    const { deps: remote } = makeDeps([row('a')], {
      exportShare: async () => {
        throw Object.assign(new Error('remote'), { code: 'PRECONDITION_FAILED' });
      },
    });
    const res2 = await exportSession(remote, { sessionId: 'a', targetPath: '/tmp/x.cshare', password: null, excludeMedia: false }, '.cshare');
    expect(res2).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
  });
});

describe('openSessionInNewWindow', () => {
  it('opens existing sessions and rejects deleted ones', async () => {
    const { deps } = makeDeps([row('a'), row('d', { status: 'deleted' })]);
    expect(await openSessionInNewWindow(deps, { sessionId: 'a' })).toMatchObject({ ok: true, sessionId: 'a' });
    expect(deps.openInNewWindow).toHaveBeenCalledWith('a');
    expect(await openSessionInNewWindow(deps, { sessionId: 'd' })).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
    expect(await openSessionInNewWindow(deps, { sessionId: 'x' })).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
  });
});

describe('forkSession', () => {
  it('resolves the message client id and returns the forked session', async () => {
    const forkAtMessage = vi.fn(async () => ({ id: 'forked' }));
    const { deps } = makeDeps([row('a'), row('forked', { parentSessionId: 'a' })], { forkAtMessage });
    const res = await forkSession(deps, { sessionId: 'a', messageId: 'm1' });
    expect(forkAtMessage).toHaveBeenCalledWith('a', 'client-1');
    expect(res).toMatchObject({ ok: true, session: { sessionId: 'forked' } });
  });

  it('maps fork error codes', async () => {
    const withCode = (code: string) =>
      makeDeps([row('a')], {
        forkAtMessage: async () => {
          throw Object.assign(new Error(code), { code });
        },
      }).deps;
    expect(await forkSession(withCode('NOT_USER_MESSAGE'), { sessionId: 'a', messageId: 'm' })).toMatchObject({ errorCode: 'INVALID_ARGS' });
    expect(await forkSession(withCode('NO_PRIOR_ASSISTANT'), { sessionId: 'a', messageId: 'm' })).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    expect(await forkSession(withCode('UNSUPPORTED_HISTORY'), { sessionId: 'a', messageId: 'm' })).toMatchObject({ errorCode: 'UNSUPPORTED_CAPABILITY' });
    const { deps: noMsg } = makeDeps([row('a')], { resolveMessageClientId: async () => null });
    expect(await forkSession(noMsg, { sessionId: 'a', messageId: 'm' })).toMatchObject({ errorCode: 'NOT_FOUND' });
  });
});

describe('getSessionBranches', () => {
  it('walks up to the root and collects all descendants', async () => {
    const { deps } = makeDeps([
      row('root'),
      row('c1', { parentSessionId: 'root', forkedAtMessageId: 'm1' }),
      row('c2', { parentSessionId: 'root' }),
      row('gc', { parentSessionId: 'c1' }),
      row('other'),
    ]);
    const res = await getSessionBranches(deps, { sessionId: 'gc' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rootSessionId).toBe('root');
      expect(res.family.map((f) => f.sessionId).sort()).toEqual(['c1', 'c2', 'gc', 'root']);
      expect(res.family.find((f) => f.sessionId === 'c1')).toMatchObject({ parentSessionId: 'root', forkedAtMessageId: 'm1' });
    }
  });
});
