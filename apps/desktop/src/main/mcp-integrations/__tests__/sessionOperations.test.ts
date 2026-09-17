/**
 * sessionOperations 业务体回归测试:GUI 同口径守卫(远程 / 运行中 / IM 接管 / 已归档 /
 * 空草稿 / review)、NOT_FOUND 整批不写、逐个应用与中途失败。依赖全部注入,不加载 Electron。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  forkSession,
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
    withSessionLock: async <T,>(_sessionId: string, task: () => Promise<T>) => task(),
    updateSession,
    resolveMessageClientId: async () => ({ clientId: 'client-1', role: 'assistant', text: '' }),
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

describe('forkSession', () => {
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
