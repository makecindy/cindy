/**
 * sessionOperations 骨架回归测试:各会话操作工具共用的行加载、GUI 同口径守卫
 * (远程 / 运行中 / IM 接管 / 伙伴 / 协同 worker / 已归档 / 空草稿 / review)与错误码映射。
 * 依赖全部注入,不加载 Electron。具体工具的业务体测试随各工具 PR 一起加。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  getSessionBranches,
  lateGuard,
  loadAll,
  mapIpcError,
  mutationGuard,
  openSessionInNewWindow,
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
    openInNewWindow: vi.fn(),
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
