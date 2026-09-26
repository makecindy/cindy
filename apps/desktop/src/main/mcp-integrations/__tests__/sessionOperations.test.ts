/**
 * sessionOperations 骨架回归测试:各会话操作工具共用的行加载、GUI 同口径守卫
 * (远程 / 运行中 / IM 接管 / 伙伴 / 协同 worker / 已归档 / 空草稿 / review)与错误码映射。
 * 依赖全部注入,不加载 Electron。具体工具的业务体测试随各工具 PR 一起加。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  exportSession,
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
