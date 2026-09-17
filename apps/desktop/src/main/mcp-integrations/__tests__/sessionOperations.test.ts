/**
 * sessionOperations 业务体回归测试:GUI 同口径守卫(远程 / 运行中 / IM 接管 / 已归档 /
 * 空草稿 / review)、NOT_FOUND 整批不写、逐个应用与中途失败。依赖全部注入,不加载 Electron。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  exportSession,
  moveSessions,
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
    resolveDirectory: async (path: string) => path,
    updateSession,
    fileExists: async () => false,
    exportShare: async ({ targetPath }) => ({
      status: 'ok',
      filePath: targetPath,
      fidelity: 'full',
      missingTranscripts: [],
      mediaMissing: 0,
      orcaWorkers: 0,
    }),
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
    expect(updateSession.mock.calls[0].slice(0, 2)).toEqual(['a', { workspaceKind: 'dialogue' }]);
  });

  it('NOT_FOUND for any missing id writes nothing', async () => {
    const { deps, updateSession } = makeDeps([row('a')]);
    const res = await moveSessions(deps, { sessionIds: ['a', 'ghost'], target: toProject });
    expect(res).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('rejects a symlinked working_dir so approval and the stored path cannot diverge', async () => {
    // 审批发生在入参上,若这里静默替换成 realpath,用户批准的目录与实际生效的目录就不是同一个。
    const { deps, updateSession } = makeDeps([row('a')], {
      resolveDirectory: async () => '/real/project',
    });
    const res = await moveSessions(deps, {
      sessionIds: ['a'],
      target: { kind: 'project', workingDir: '/link/project' },
    });
    expect(res).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(res.ok === false && res.message).toContain('/real/project');
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('compares realpath in storage-normalized form, not raw string', async () => {
    // 同一个目录的不同拼写(这里是尾斜杠;Windows 上则是 `C:/repo` vs `C:\\repo`)
    // 都要先过 normalizeWorkingDirForStorage 再比较,否则普通目录会被误判成软链。
    const { deps, updateSession } = makeDeps([row('a')], {
      resolveDirectory: async () => '/real/project',
    });
    const res = await moveSessions(deps, {
      sessionIds: ['a'],
      target: { kind: 'project', workingDir: '/real/project/' },
    });
    expect(res.ok).toBe(true);
    expect(updateSession.mock.calls[0][1]).toMatchObject({ workingDir: '/real/project' });
  });

  it('rejects a case-only difference rather than guessing volume case sensitivity', async () => {
    // macOS 可挂载大小写敏感卷、Windows 目录也可开启大小写敏感,届时 repo 与 Repo 是两个目录;
    // 按平台折叠大小写会让软链绕过校验,所以一律要求逐字相同,并在消息里给出真实路径。
    const { deps, updateSession } = makeDeps([row('a')], { resolveDirectory: async () => '/Users/Me/repo' });
    const res = await moveSessions(deps, {
      sessionIds: ['a'],
      target: { kind: 'project', workingDir: '/users/me/repo' },
    });
    expect(res).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(res.ok === false && res.message).toContain('/Users/Me/repo');
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('accepts a working_dir that is already canonical', async () => {
    const { deps, updateSession } = makeDeps([row('a')], {
      resolveDirectory: async (path: string) => path,
    });
    const res = await moveSessions(deps, {
      sessionIds: ['a'],
      target: { kind: 'project', workingDir: '/real/project' },
    });
    expect(res.ok).toBe(true);
    expect(updateSession.mock.calls[0][1]).toMatchObject({ workingDir: '/real/project' });
  });

  it('INVALID_ARGS when working_dir is not a directory', async () => {
    const { deps, updateSession } = makeDeps([row('a')], { resolveDirectory: async () => null });
    const res = await moveSessions(deps, { sessionIds: ['a'], target: toProject });
    expect(res).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('rejects a relative working_dir before directory lookup', async () => {
    const { deps, updateSession } = makeDeps([row('a')]);
    const resolveDirectory = vi.spyOn(deps, 'resolveDirectory');
    const res = await moveSessions(deps, { sessionIds: ['a'], target: { kind: 'project', workingDir: 'relative' } });
    expect(res).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(updateSession).not.toHaveBeenCalled();
    expect(resolveDirectory).not.toHaveBeenCalled();
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

  it('rechecks running state inside the write lock and preserves moved items', async () => {
    let checks = 0;
    const { deps, updateSession } = makeDeps([row('a'), row('b')], {
      isTurnRunning: (id) => id === 'b' && ++checks > 1,
    });
    const res = await moveSessions(deps, { sessionIds: ['a', 'b'], target: toProject });
    expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED', moved: [{ sessionId: 'a' }] });
    // 复核发生在 updateSession 的 beforeWrite 里:b 进入了 updateSession 但没有写入。
    expect(updateSession).toHaveBeenCalledTimes(2);
    expect(updateSession.mock.calls[1][2]?.beforeWrite).toBeTypeOf('function');
  });

  it('rechecks IM attachment inside the write lock and preserves moved items', async () => {
    let checks = 0;
    const { deps, updateSession } = makeDeps([row('a'), row('b')], {
      isImAttached: (id) => id === 'b' && ++checks > 1,
    });
    const res = await moveSessions(deps, { sessionIds: ['a', 'b'], target: toProject });
    expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED', moved: [{ sessionId: 'a' }] });
    expect(updateSession).toHaveBeenCalledTimes(2);
  });

  it('refuses a session archived or deleted between precheck and write', async () => {
    for (const late of ['archived', 'deleted'] as const) {
      const rows = [row('a'), row('b')];
      let loads = 0;
      const { deps, updateSession } = makeDeps(rows, {
        // 第一次批量读取正常;之后对 b 的锁内重读返回终态。
        loadSessions: async (ids) => {
          loads += 1;
          return ids.flatMap((id) => {
            const r = rows.find((x) => x.id === id);
            if (!r) return [];
            return [loads > 1 && id === 'b' ? { ...r, status: late } : r];
          });
        },
      });
      const res = await moveSessions(deps, { sessionIds: ['a', 'b'], target: toProject });
      expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED', moved: [{ sessionId: 'a' }] });
      expect(updateSession.mock.calls.filter((c) => c[0] === 'b')).toHaveLength(1);
    }
  });

  it('rejects Bot-managed and Orca worker sessions for the whole batch', async () => {
    for (const patch of [{ source: 'bot' }, { orcaRole: 'worker' as const }]) {
      const { deps, updateSession } = makeDeps([row('a'), row('b', patch)]);
      const res = await moveSessions(deps, { sessionIds: ['a', 'b'], target: toProject });
      expect(res).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
      expect(updateSession).not.toHaveBeenCalled();
    }
  });

  it('preserves the mapped IPC error code from a failed update', async () => {
    const { deps } = makeDeps([row('a'), row('b')], {
      updateSession: vi.fn(async (id: string) => {
        if (id === 'b') throw Object.assign(new Error('[NOT_FOUND] gone'), { code: 'NOT_FOUND' });
        return {};
      }),
    });
    const res = await moveSessions(deps, { sessionIds: ['a', 'b'], target: toProject });
    expect(res).toMatchObject({ ok: false, errorCode: 'NOT_FOUND', moved: [{ sessionId: 'a' }] });
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
  });
});
