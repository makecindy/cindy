/**
 * sessions 读 IPC 回归测试：列表置顶补齐与 scheduler 引用状态解析。
 *
 * device-link 控制端首拉只取最近 200 条 active 会话；被控端 active 会话很多时，
 * 较旧的置顶会话可能落在窗口外。第三参数 `{ includePinned: true }` 必须把
 * active pinned 会话补进结果，并对已经在最近窗口内的 pinned 行去重。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const queryResults: unknown[][] = [];

  const makeSelectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.leftJoin = () => chain;
    chain.where = () => chain;
    chain.groupBy = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => Promise.resolve(queryResults.shift() ?? []);
    chain.then = (
      resolve: (value: unknown[]) => void,
      reject: (reason?: unknown) => void,
    ) => Promise.resolve(queryResults.shift() ?? []).then(resolve, reject);
    return chain;
  };

  return {
    ipcHandle: vi.fn(),
    queryResults,
    fakeDb: { select: vi.fn(() => makeSelectChain()) },
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: h.ipcHandle },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../localDb/client/current', () => ({ getDbClient: () => ({ drizzle: h.fakeDb }) }));
vi.mock('../localDb/dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../git-context/prRefsStore', () => ({ recomputePrRefsForSession: vi.fn() }));
vi.mock('../localDb/ipc/recentWorkdirs', () => ({ upsertRecentWorkdir: vi.fn() }));
vi.mock('../device-link/broadcast-tap', () => ({ tapWindowBroadcast: vi.fn() }));
vi.mock('../agent-island/service.js', () => ({
  getAgentIslandService: () => ({ handleSessionMetadataPatch: vi.fn() }),
}));
vi.mock('../imageCacheStore', () => ({ removeSession: vi.fn() }));
vi.mock('../messagePersistBroadcaster', () => ({ noteSessionClearBoundary: vi.fn() }));
vi.mock('../sessionTaskSummary.js', () => ({ backfillPinnedSessionSummaries: vi.fn() }));

import { registerSessionIpc } from '../localDb/ipc/sessions.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.queryResults.length = 0;
});

function sessionRow(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'sonnet',
    effort: null,
    permissionMode: null,
    providerId: null,
    status: 'active',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: 0,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: null,
    agentKind: 'cc',
    source: 'desktop',
    orcaRole: null,
    parentSessionId: null,
    forkedAtMessageId: null,
    worktreePath: null,
    usedProjectContext: 0,
    extraDirs: null,
    remoteHostId: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    summary: null,
    ...patch,
  };
}

function listRow(id: string, patch: Record<string, unknown> = {}) {
  return {
    session: sessionRow(id, patch),
    messageCount: 0,
    latestMessageContent: null,
    latestMessageRole: null,
  };
}

function sessionsListHandler() {
  registerSessionIpc();
  const call = h.ipcHandle.mock.calls.find(([channel]) => channel === 'local-db:sessions:list');
  if (!call) throw new Error('local-db:sessions:list handler not registered');
  return call[1] as (
    event: unknown,
    limit?: unknown,
    status?: unknown,
    options?: unknown,
  ) => Promise<Array<{ id: string }>>;
}

function resolveReferencesHandler() {
  registerSessionIpc();
  const call = h.ipcHandle.mock.calls.find(
    ([channel]) => channel === 'local-db:sessions:resolve-references',
  );
  if (!call) throw new Error('local-db:sessions:resolve-references handler not registered');
  return call[1] as (
    event: unknown,
    sessionIds: unknown,
  ) => Promise<Array<{ sessionId: string; state: string; status?: string }>>;
}

describe('local-db:sessions:list includePinned', () => {
  it('returns recent active rows plus missing active pinned rows without duplicates', async () => {
    const handler = sessionsListHandler();
    h.queryResults.push(
      [listRow('recent'), listRow('pinned-in-window', { pinnedAt: 1 })],
      [listRow('pinned-in-window', { pinnedAt: 1 }), listRow('old-pinned', { pinnedAt: 2 })],
    );

    const result = await handler({}, 2, 'active', { includePinned: true });

    expect(result.map((s) => s.id)).toEqual(['recent', 'pinned-in-window', 'old-pinned']);
    expect(h.fakeDb.select).toHaveBeenCalledTimes(2);
    expect(h.queryResults).toHaveLength(0);
  });

  it('keeps the normal list path to one query when includePinned is not requested', async () => {
    const handler = sessionsListHandler();
    h.queryResults.push([listRow('recent')], [listRow('old-pinned', { pinnedAt: 2 })]);

    const result = await handler({}, 2, 'active');

    expect(result.map((s) => s.id)).toEqual(['recent']);
    expect(h.fakeDb.select).toHaveBeenCalledTimes(1);
    expect(h.queryResults).toHaveLength(1);
  });

  it('also includes pinned rows for the all-status bucket used by mobile detail filters', async () => {
    const handler = sessionsListHandler();
    h.queryResults.push(
      [listRow('recent-active')],
      [listRow('old-active-pinned', { pinnedAt: 1 }), listRow('old-archived-pinned', {
        pinnedAt: 2,
        status: 'archived',
      })],
    );

    const result = await handler({}, 1, 'all', { includePinned: true });

    expect(result.map((s) => s.id)).toEqual([
      'recent-active',
      'old-active-pinned',
      'old-archived-pinned',
    ]);
    expect(h.fakeDb.select).toHaveBeenCalledTimes(2);
    expect(h.queryResults).toHaveLength(0);
  });
});

describe('local-db:sessions:resolve-references', () => {
  it('classifies live, archived, deleted, and missing ids in caller order', async () => {
    const handler = resolveReferencesHandler();
    h.queryResults.push([
      { id: 'active', status: 'active', title: 'Active', agentKind: 'cc' },
      { id: 'archived', status: 'archived', title: 'Archived', agentKind: 'codex' },
      { id: 'deleted', status: 'deleted', title: 'Deleted', agentKind: 'cc' },
    ]);

    const result = await handler({}, ['active', 'missing', 'deleted', 'archived', 'active']);

    expect(result).toEqual([
      expect.objectContaining({ sessionId: 'active', state: 'available', status: 'active' }),
      { sessionId: 'missing', state: 'missing' },
      expect.objectContaining({ sessionId: 'deleted', state: 'deleted', status: 'deleted' }),
      expect.objectContaining({ sessionId: 'archived', state: 'available', status: 'archived' }),
    ]);
    expect(h.fakeDb.select).toHaveBeenCalledTimes(1);
  });

  it('rejects unbounded or malformed input before querying SQLite', async () => {
    const handler = resolveReferencesHandler();

    await expect(handler({}, 'session')).rejects.toThrow('[INVALID_PARAMS]');
    await expect(handler({}, Array.from({ length: 201 }, (_, i) => `s-${i}`))).rejects.toThrow(
      '[INVALID_PARAMS]',
    );
    expect(h.fakeDb.select).not.toHaveBeenCalled();
  });
});
