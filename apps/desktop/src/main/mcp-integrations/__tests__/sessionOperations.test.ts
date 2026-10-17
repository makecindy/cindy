/**
 * sessionOperations 骨架回归测试:各会话操作工具共用的行加载、GUI 同口径守卫
 * (远程 / 运行中 / IM 接管 / 伙伴 / 协同 worker / 已归档 / 空草稿 / review)与错误码映射。
 * 依赖全部注入,不加载 Electron。具体工具的业务体测试随各工具 PR 一起加。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  deleteSessions,
  exportSession,
  forkSession,
  getSessionBranches,
  lateGuard,
  loadAll,
  mapIpcError,
  mutationGuard,
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
    pinnedAt: null,
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
      hooks?: { beforeWrite?: () => Promise<string | null>; skipIfPinnedUnchanged?: boolean },
    ) => {
      const reason = await hooks?.beforeWrite?.();
      if (reason) throw Object.assign(new Error(`[PRECONDITION_FAILED] ${reason}`), { code: 'PRECONDITION_FAILED' });
      if (hooks?.skipIfPinnedUnchanged) {
        const [fresh] = await deps.loadSessions([id]);
        if (fresh && (fresh.pinnedAt != null) === (patch.pinnedAt != null)) return false;
      }
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
    resolveDirectory: async (path: string) => path,
    fileExists: async () => false,
    exportShare: async ({ targetPath }) => ({
      status: 'ok',
      filePath: targetPath,
      fidelity: 'full',
      missingTranscripts: [],
      mediaMissing: 0,
      orcaWorkers: 0,
    }),
    openInNewWindow: vi.fn(),
    withSessionLock: async <T,>(_sessionId: string, task: () => Promise<T>) => task(),
    resolveMessageClientId: async () => ({ clientId: 'client-1', role: 'assistant', text: '' }),
    forkAtMessage: async () => ({ id: 'forked' }),
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

describe('setSessionsPinned', () => {
  it('writes pinnedAt ISO / null through updateSession', async () => {
    const { deps, updateSession } = makeDeps([row('a')]);
    await setSessionsPinned(deps, { sessionIds: ['a'], pinned: true });
    expect(typeof updateSession.mock.calls[0][1].pinnedAt).toBe('string');
    const pinned = makeDeps([row('a', { pinnedAt: 1767225600000 })]);
    await setSessionsPinned(pinned.deps, { sessionIds: ['a'], pinned: false });
    expect(pinned.updateSession.mock.calls[0][1]).toEqual({ pinnedAt: null });
  });

  it('skips sessions already in the requested pin state', async () => {
    // 重复写 pinnedAt 会打乱置顶排序并再次触发强制摘要生成;未变化的不计入 changed。
    const already = makeDeps([row('a', { pinnedAt: 1767225600000 })]);
    const res = await setSessionsPinned(already.deps, { sessionIds: ['a'], pinned: true });
    expect(res).toMatchObject({ ok: true, changed: [] });
    expect(already.updateSession).toHaveBeenCalledTimes(1);

    const notPinned = makeDeps([row('b')]);
    const res2 = await setSessionsPinned(notPinned.deps, { sessionIds: ['b'], pinned: false });
    expect(res2).toMatchObject({ ok: true, changed: [] });
    expect(notPinned.updateSession).toHaveBeenCalledTimes(1);
  });

  it('uses pin state observed inside the write path, not the preflight snapshot', async () => {
    const initial = row('a', { pinnedAt: 1767225600000 });
    let reads = 0;
    const { deps, updateSession } = makeDeps([initial], {
      loadSessions: async () => {
        reads += 1;
        return [{ ...initial, pinnedAt: reads === 1 ? initial.pinnedAt : null }];
      },
    });
    const result = await setSessionsPinned(deps, { sessionIds: ['a'], pinned: true });
    expect(result).toMatchObject({ ok: true, changed: [{ sessionId: 'a' }] });
    expect(updateSession).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite a pin applied after preflight', async () => {
    const initial = row('a');
    let reads = 0;
    const { deps, updateSession } = makeDeps([initial], {
      loadSessions: async () => {
        reads += 1;
        return [{ ...initial, pinnedAt: reads === 1 ? null : 1767225600000 }];
      },
    });
    const result = await setSessionsPinned(deps, { sessionIds: ['a'], pinned: true });
    expect(result).toMatchObject({ ok: true, changed: [] });
    expect(updateSession).toHaveBeenCalledTimes(1);
  });

  it('rechecks terminal state inside the write lock and preserves changed items', async () => {
    const rows = [row('a'), row('b')];
    let loads = 0;
    const { deps, updateSession } = makeDeps(rows, {
      loadSessions: async (ids) => {
        loads += 1;
        return ids.flatMap((id) => {
          const r = rows.find((x) => x.id === id);
          if (!r) return [];
          return [loads > 1 && id === 'b' ? { ...r, status: 'archived' as const } : r];
        });
      },
    });
    const res = await setSessionsPinned(deps, { sessionIds: ['a', 'b'], pinned: true });
    expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED', changed: [{ sessionId: 'a' }] });
    expect(updateSession.mock.calls[1][2]?.beforeWrite).toBeTypeOf('function');
  });

  it('pins a running session — including the caller itself, which is always running', async () => {
    // pin 只写 pinnedAt 元数据,不触碰工作区:复用带运行态检查的 lateGuard 会让 agent
    // 连自己所在的会话都置顶不了(执行工具调用时它必然 isTurnRunning),而 GUI 是允许的。
    const { deps, updateSession } = makeDeps([row('a')], {
      isTurnRunning: () => true,
      isImAttached: () => true,
    });
    const res = await setSessionsPinned(deps, { sessionIds: ['a'], pinned: true });
    expect(res).toMatchObject({ ok: true, changed: [{ sessionId: 'a' }] });
    expect(updateSession).toHaveBeenCalledTimes(1);
  });

  it('still rejects a session deleted inside the write lock even when runtime checks are off', async () => {
    // 关掉运行态复核不能连终态复核一起关掉:预检时还是 active,进写锁后才被另一窗口删除。
    const base = row('a');
    let loads = 0;
    const { deps } = makeDeps([base], {
      isTurnRunning: () => true,
      loadSessions: async (ids) => {
        loads += 1;
        // 第一次是批量预检,之后是 beforeWrite 的锁内复核。
        const status = loads === 1 ? ('active' as const) : ('deleted' as const);
        return ids.flatMap((id) => (id === 'a' ? [{ ...base, status }] : []));
      },
    });
    const res = await setSessionsPinned(deps, { sessionIds: ['a'], pinned: true });
    expect(loads).toBeGreaterThan(1);
    expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
  });

  it('pins SSH remote sessions like the GUI patchMeta path does', async () => {
    const { deps, updateSession } = makeDeps([row('a', { remoteHostId: 'host' })]);
    const res = await setSessionsPinned(deps, { sessionIds: ['a'], pinned: true });
    expect(res).toMatchObject({ ok: true, changed: [{ sessionId: 'a' }] });
    expect(updateSession).toHaveBeenCalledTimes(1);
  });

  it('preserves the mapped IPC error code from a failed update', async () => {
    const { deps } = makeDeps([row('a'), row('b')], {
      updateSession: vi.fn(async (id: string) => {
        if (id === 'b') throw Object.assign(new Error('[NOT_FOUND] gone'), { code: 'NOT_FOUND' });
        return {};
      }),
    });
    const res = await setSessionsPinned(deps, { sessionIds: ['a', 'b'], pinned: true });
    expect(res).toMatchObject({ ok: false, errorCode: 'NOT_FOUND', changed: [{ sessionId: 'a' }] });
  });

  it('refuses archived, deleted, Bot and Orca worker sessions for the whole batch', async () => {
    for (const patch of [
      { status: 'archived' as const },
      { status: 'deleted' as const },
      { source: 'bot' },
      { orcaRole: 'worker' as const },
    ]) {
      const { deps, updateSession } = makeDeps([row('a'), row('b', patch)]);
      const res = await setSessionsPinned(deps, { sessionIds: ['a', 'b'], pinned: true });
      expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
      expect(updateSession).not.toHaveBeenCalled();
    }
  });

  it('NOT_FOUND for any missing id writes nothing', async () => {
    const { deps, updateSession } = makeDeps([row('a')]);
    const res = await setSessionsPinned(deps, { sessionIds: ['a', 'ghost'], pinned: true });
    expect(res).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('reports partial progress when a later update fails', async () => {
    const { deps } = makeDeps([row('a'), row('b')], {
      updateSession: vi.fn(async (id: string) => {
        if (id === 'b') throw new Error('disk on fire');
        return {};
      }),
    });
    const res = await setSessionsPinned(deps, { sessionIds: ['a', 'b'], pinned: true });
    expect(res).toMatchObject({ ok: false, errorCode: 'INTERNAL', changed: [{ sessionId: 'a' }] });
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

  it('rejects a worktree dirtied after preflight but before the locked write', async () => {
    let previews = 0;
    const { deps } = makeDeps([row('a')], {
      worktreeRemovalPreview: async () => ({ hasWorktree: true, dirty: ++previews > 1 }),
    });
    const res = await deleteSessions(deps, { sessionIds: ['a'], dryRun: false, expectedDirty: { a: false } });
    expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED', items: [] });
    expect(previews).toBe(2);
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

describe('exportSession', () => {
  const params = { sessionId: 'a', excludeMedia: false };

  it('appends the share extension, derives the parent with path.dirname and validates it', async () => {
    const exportShare = vi.fn(async ({ targetPath }: { targetPath: string }) => ({
      status: 'ok' as const,
      filePath: targetPath,
      fidelity: 'full',
      missingTranscripts: [],
      mediaMissing: 0,
      orcaWorkers: 0,
    }));
    const resolveDirectory = vi.fn(async (path: string) => path);
    const { deps } = makeDeps([row('a')], { exportShare, resolveDirectory });
    const res = await exportSession(deps, { ...params, targetPath: '/tmp/out/x' }, '.cshare');
    expect(resolveDirectory).toHaveBeenCalledWith('/tmp/out');
    expect(exportShare).toHaveBeenCalledWith({ sessionId: 'a', targetPath: '/tmp/out/x.cshare', excludeMedia: false });
    expect(res).toMatchObject({ ok: true, filePath: '/tmp/out/x.cshare', fidelity: 'full' });

    const { deps: bad } = makeDeps([row('a')], { resolveDirectory: async () => null });
    expect(await exportSession(bad, { ...params, targetPath: '/nope/x' }, '.cshare')).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
    });
  });

  it('rejects relative targets and refuses to overwrite an existing file', async () => {
    const { deps, exportShare } = { ...makeDeps([row('a')]), exportShare: vi.fn() };
    expect(await exportSession(deps, { ...params, targetPath: 'relative/x' }, '.cshare')).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
    });
    const { deps: existing } = makeDeps([row('a')], { fileExists: async () => true, exportShare });
    expect(await exportSession(existing, { ...params, targetPath: '/tmp/x.cshare' }, '.cshare')).toMatchObject({
      ok: false,
      errorCode: 'PRECONDITION_FAILED',
    });
    expect(exportShare).not.toHaveBeenCalled();
  });

  it('maps oversize outcomes and coded errors', async () => {
    const { deps } = makeDeps([row('a')], {
      exportShare: async () => ({ status: 'oversize', totalBytes: 10, mediaBytes: 8, limitBytes: 5 }),
    });
    expect(await exportSession(deps, { ...params, targetPath: '/tmp/x.cshare' }, '.cshare')).toMatchObject({
      ok: false,
      errorCode: 'OVERSIZE',
      data: { total_bytes: 10, limit_bytes: 5 },
    });
    const { deps: remote } = makeDeps([row('a')], {
      exportShare: async () => {
        throw Object.assign(new Error('remote'), { code: 'PRECONDITION_FAILED' });
      },
    });
    expect(await exportSession(remote, { ...params, targetPath: '/tmp/x.cshare' }, '.cshare')).toMatchObject({
      ok: false,
      errorCode: 'PRECONDITION_FAILED',
    });
    const { deps: raced } = makeDeps([row('a')], {
      exportShare: async () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
    });
    expect(await exportSession(raced, { ...params, targetPath: '/tmp/x.cshare' }, '.cshare')).toMatchObject({
      ok: false,
      errorCode: 'PRECONDITION_FAILED',
    });
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

  it('refuses to open a Bot session as an ordinary task window', async () => {
    // 副窗只经 resolveSessionRoute 解析 Orca 身份,伙伴会话会落到 /cc-agent/ 而非 /bots/。
    const { deps } = makeDeps([row('b', { source: 'bot' })]);
    expect(await openSessionInNewWindow(deps, { sessionId: 'b' })).toMatchObject({
      ok: false,
      errorCode: 'PRECONDITION_FAILED',
    });
    expect(deps.openInNewWindow).not.toHaveBeenCalled();
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

  it('excludes Bot delegation children but keeps forks that have no message anchor', async () => {
    // botDelegationService 给委派子会话写 sessions.parentSessionId(botDelegationService.ts:806),
    // 那些会话 source='bot',侧栏不展示;而 forkSessionStripEncrypted 建的分支
    // 是 parentSessionId 有值、forkedAtMessageId 为空的合法分支,必须留下。
    const { deps } = makeDeps([
      row('root'),
      row('anchored', { parentSessionId: 'root', forkedAtMessageId: 'm1' }),
      row('stripFork', { parentSessionId: 'root' }),
      row('delegated', { parentSessionId: 'root', source: 'bot' }),
      row('worker', { parentSessionId: 'root', orcaRole: 'worker' }),
    ]);
    const res = await getSessionBranches(deps, { sessionId: 'root' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.family.map((f) => f.sessionId).sort()).toEqual(['anchored', 'root', 'stripFork']);
    }
  });

  it('refuses a Bot or worker session as the family entry point', async () => {
    // 否则:有可见祖先时入口会被 BFS 过滤掉(成功结果里没有请求的 id);
    // 没有可见父节点时入口又会自己当根混进家族 —— 两种都与契约矛盾。
    const { deps } = makeDeps([
      row('root'),
      row('botChild', { parentSessionId: 'root', source: 'bot' }),
      row('lonelyWorker', { orcaRole: 'worker' }),
    ]);
    expect(await getSessionBranches(deps, { sessionId: 'botChild' })).toMatchObject({
      ok: false,
      errorCode: 'PRECONDITION_FAILED',
    });
    expect(await getSessionBranches(deps, { sessionId: 'lonelyWorker' })).toMatchObject({
      ok: false,
      errorCode: 'PRECONDITION_FAILED',
    });
  });

  it('refuses a soft-deleted session as the family entry point', async () => {
    const { deps } = makeDeps([row('gone', { status: 'deleted' })]);
    expect(await getSessionBranches(deps, { sessionId: 'gone' })).toMatchObject({
      ok: false,
      errorCode: 'PRECONDITION_FAILED',
    });
  });

  it('drops soft-deleted sessions and their descendants from the family', async () => {
    const { deps } = makeDeps([
      row('root'),
      row('keep', { parentSessionId: 'root' }),
      row('gone', { parentSessionId: 'root', status: 'deleted' }),
      row('orphan', { parentSessionId: 'gone' }),
    ]);
    const res = await getSessionBranches(deps, { sessionId: 'keep' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.family.map((f) => f.sessionId).sort()).toEqual(['keep', 'root']);
  });
});

describe('forkSession', () => {
  it('does not reacquire the active caller session lock', async () => {
    let lockCalls = 0;
    const withSessionLock = async <T,>(_id: string, task: () => Promise<T>) => {
      lockCalls += 1;
      return task();
    };
    const { deps } = makeDeps([row('a')], { withSessionLock });
    expect(await forkSession(deps, { callerSessionId: 'a', sessionId: 'a', messageId: 'm' })).toMatchObject({
      ok: false,
      errorCode: 'PRECONDITION_FAILED',
    });
    expect(lockCalls).toBe(0);
  });
  it('resolves the message client id and returns the forked session', async () => {
    const forkAtMessage = vi.fn(async () => ({ id: 'forked' }));
    const { deps } = makeDeps([row('a'), row('forked', { parentSessionId: 'a' })], { forkAtMessage });
    const res = await forkSession(deps, { sessionId: 'a', messageId: 'm1' });
    expect(forkAtMessage).toHaveBeenCalledWith('a', 'client-1');
    expect(res).toMatchObject({ ok: true, session: { sessionId: 'forked' } });
  });

  it('refuses deleted, remote and unknown sessions', async () => {
    const { deps } = makeDeps([row('d', { status: 'deleted' }), row('r', { remoteHostId: 'host' })]);
    expect(await forkSession(deps, { sessionId: 'd', messageId: 'm' })).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    expect(await forkSession(deps, { sessionId: 'r', messageId: 'm' })).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    expect(await forkSession(deps, { sessionId: 'x', messageId: 'm' })).toMatchObject({ errorCode: 'NOT_FOUND' });
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
    expect(await forkSession(withCode('SOMETHING_ELSE'), { sessionId: 'a', messageId: 'm' })).toMatchObject({ errorCode: 'INTERNAL' });
    const { deps: noMsg } = makeDeps([row('a')], { resolveMessageClientId: async () => null });
    expect(await forkSession(noMsg, { sessionId: 'a', messageId: 'm' })).toMatchObject({ errorCode: 'NOT_FOUND' });
  });

  it('refuses to fork at a rewound message instead of silently anchoring earlier', async () => {
    // fork.ts 复制历史时过滤 rewindAt 非空的行,放行会建出不含该消息的新任务。
    const { deps } = makeDeps([row('a')], {
      resolveMessageClientId: async () => ({ clientId: 'c1', role: 'user', text: 'x', rewound: true }),
      forkAtMessage: async () => {
        throw new Error('forkAtMessage must not run for a rewound anchor');
      },
    });
    expect(await forkSession(deps, { sessionId: 'a', messageId: 'm' })).toMatchObject({
      ok: false,
      errorCode: 'PRECONDITION_FAILED',
    });
  });

  it('still reports success when the post-fork read fails', async () => {
    // fork 已建好并广播;补充读取失败若冒泡成 INTERNAL,调用方重试会再建一条重复任务。
    let loads = 0;
    const base = row('a');
    const { deps } = makeDeps([base], {
      loadSessions: async (ids) => {
        loads += 1;
        if (loads > 2) throw new Error('transient db error');
        return ids.flatMap((id) => (id === 'a' ? [base] : []));
      },
    });
    const res = await forkSession(deps, { sessionId: 'a', messageId: 'm' });
    expect(res).toMatchObject({ ok: true, session: { sessionId: 'forked' } });
  });

  it('refuses to fork a source deleted inside the session lock', async () => {
    // forkSessionAtMessage 只校验源行存在,软删除会保留行 —— 预检通过后被并发删除时
    // 必须在锁内复核拦下,否则会从已删除任务派生出 active 子任务。
    const base = row('a');
    let loads = 0;
    const { deps } = makeDeps([base], {
      loadSessions: async (ids) => {
        loads += 1;
        const status = loads === 1 ? ('active' as const) : ('deleted' as const);
        return ids.flatMap((id) => (id === 'a' ? [{ ...base, status }] : []));
      },
      forkAtMessage: async () => {
        throw new Error('forkAtMessage must not run for a deleted source');
      },
    });
    const res = await forkSession(deps, { sessionId: 'a', messageId: 'm' });
    expect(loads).toBeGreaterThan(1);
    expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
  });

  it('returns the selected user message as draftText so the caller can seed the new session', async () => {
    const { deps } = makeDeps([row('a')], {
      resolveMessageClientId: async () => ({ clientId: 'c', role: 'user', text: '继续做第二步' }),
    });
    expect(await forkSession(deps, { sessionId: 'a', messageId: 'm' })).toMatchObject({ ok: true, draftText: '继续做第二步' });
    const { deps: assistant } = makeDeps([row('a')], {
      resolveMessageClientId: async () => ({ clientId: 'c', role: 'assistant', text: 'reply' }),
    });
    const res = await forkSession(assistant, { sessionId: 'a', messageId: 'm' });
    expect(res.ok && 'draftText' in res).toBe(false);
  });
});
