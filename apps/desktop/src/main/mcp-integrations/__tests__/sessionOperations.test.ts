/**
 * sessionOperations 骨架回归测试:各会话操作工具共用的行加载、GUI 同口径守卫
 * (远程 / 运行中 / IM 接管 / 伙伴 / 协同 worker / 已归档 / 空草稿 / review)与错误码映射。
 * 依赖全部注入,不加载 Electron。具体工具的业务体测试随各工具 PR 一起加。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  lateGuard,
  loadAll,
  mapIpcError,
  mutationGuard,
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
    updateSession,
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
