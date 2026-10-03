/**
 * sessionOperations 骨架回归测试:各会话操作工具共用的行加载、GUI 同口径守卫
 * (远程 / 运行中 / IM 接管 / 伙伴 / 协同 worker / 已归档 / 空草稿 / review)与错误码映射。
 * 依赖全部注入,不加载 Electron。具体工具的业务体测试随各工具 PR 一起加。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  forkSession,
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
