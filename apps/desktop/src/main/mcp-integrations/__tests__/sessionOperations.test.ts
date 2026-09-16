/**
 * sessionOperations 业务体回归测试:GUI 同口径守卫(远程 / 运行中 / IM 接管 / 已归档 /
 * 空草稿 / review)、NOT_FOUND 整批不写、逐个应用与中途失败。依赖全部注入,不加载 Electron。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  moveSessions,
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

  it('stores the canonical directory so a symlinked working_dir cannot be persisted', async () => {
    // stat() 会跟随软链;把字面串写进 session 意味着日后恢复以链接目标为 cwd。
    const { deps, updateSession } = makeDeps([row('a')], {
      resolveDirectory: async () => '/real/project',
    });
    const res = await moveSessions(deps, {
      sessionIds: ['a'],
      target: { kind: 'project', workingDir: '/link/project' },
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
    expect(already.updateSession).not.toHaveBeenCalled();

    const notPinned = makeDeps([row('b')]);
    const res2 = await setSessionsPinned(notPinned.deps, { sessionIds: ['b'], pinned: false });
    expect(res2).toMatchObject({ ok: true, changed: [] });
    expect(notPinned.updateSession).not.toHaveBeenCalled();
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
