/**
 * loadCodexRewindNativeBoundary 的真实 SQLite 回归 (#4994 review P2)。
 *
 * rewind.test.ts 按队列喂查询结果,不会执行 /clear 截断与 context_rebuild
 * rewind_at 豁免。这里用 drizzle + better-sqlite3 跑同一条 SQL,确认旧线程
 * 边界不会漏进第一轮判定。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import type { DbClient } from '../localDb/client/DbClient';
import { clearCurrentDbClient, setCurrentDbClient } from '../localDb/client/current';
import { messages, sessions } from '../localDb/schema';

const commitRewindFilesMock = vi.fn();
const isTurnRunningMock = vi.fn(() => false);
const recomputePrRefsForSessionMock = vi.fn();
const executeCodexFileRewindPlanWithThreadRollbackMock = vi.fn();
const executeCodexFileRestorePlanWithThreadRollbackMock = vi.fn();
const detectCwdMock = vi.fn();

type FakeSession = {
  agentKind: 'codex';
  sdkSessionId: string;
  workDir: string;
  remoteHostId: string | null;
  isTurnRunning: () => boolean;
  commitRewindFiles: typeof commitRewindFilesMock;
};

const fakeSession: FakeSession = {
  agentKind: 'codex',
  sdkSessionId: 'codex-thread-live',
  workDir: '/work',
  remoteHostId: null,
  isTurnRunning: isTurnRunningMock,
  commitRewindFiles: commitRewindFilesMock,
};

vi.mock('../maker-host/index.js', () => ({
  getMaker: () => ({
    getSession: () => fakeSession,
    getSessionMeta: async () => ({ sdkSessionId: fakeSession.sdkSessionId }),
  }),
}));

vi.mock('../git-context/prRefsStore.js', () => ({
  recomputePrRefsForSession: recomputePrRefsForSessionMock,
}));

vi.mock('../git-snapshot/codexFileRewindExecutor', () => ({
  executeCodexFileRewindPlanWithThreadRollback: executeCodexFileRewindPlanWithThreadRollbackMock,
}));

vi.mock('../git-snapshot/codexFileRestoreExecutor', () => ({
  executeCodexFileRestorePlanWithThreadRollback: executeCodexFileRestorePlanWithThreadRollbackMock,
}));

vi.mock('../worktree/WorktreeManager.js', () => ({
  detectCwd: detectCwdMock,
}));

vi.mock('../messagePersistBroadcaster.js', () => ({
  setLastAssistantTranscriptUuid: vi.fn(),
}));

const txMock = vi.fn(async () => ({}));

let sqlite: Database.Database;
let client: DbClient;
let commitRewindAtMessage: typeof import('../maker-orchestration/rewind').commitRewindAtMessage;

function insertSession(over: { clearedAt?: number | null } = {}): void {
  client.drizzle
    .insert(sessions)
    .values({
      id: 'sess-1',
      title: 'demo',
      workingDir: '/work',
      model: 'gpt-5.4',
      agentKind: 'codex',
      sdkSessionId: 'codex-thread-live',
      createdAt: 1,
      updatedAt: 1,
      clearedAt: over.clearedAt ?? null,
    })
    .run();
}

function insertMessage(row: {
  id: string;
  role: 'user' | 'assistant' | 'context_rebuild' | 'agent_switch';
  createdAt: number;
  rewindAt?: number | null;
  content?: string;
  agentMeta?: string | null;
}): void {
  client.drizzle
    .insert(messages)
    .values({
      id: row.id,
      clientId: row.id,
      sessionId: 'sess-1',
      role: row.role,
      content: row.content ?? '"hi"',
      agentMeta: row.agentMeta ?? null,
      createdAt: row.createdAt,
      rewindAt: row.rewindAt ?? null,
    })
    .run();
}

const oldAnchorMeta = JSON.stringify({
  turnCompleted: true,
  nativeForkAnchor: {
    agentKind: 'codex',
    kind: 'turn',
    sdkSessionId: 'codex-thread-old',
    id: 'turn-old',
  },
});

beforeEach(async () => {
  sqlite = new Database(':memory:');
  for (const table of [sessions, messages]) {
    const { name, columns } = getTableConfig(table);
    sqlite.exec(
      `CREATE TABLE "${name}" (${columns.map((column) => `"${column.name}" ${column.getSQLType()}`).join(', ')})`,
    );
  }
  const db = drizzle(sqlite);
  client = {
    drizzle: db,
    tx: txMock,
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).get(...params) as T | undefined,
  } as unknown as DbClient;
  setCurrentDbClient(client, 'test-user');
  txMock.mockClear();
  txMock.mockResolvedValue({});
  commitRewindFilesMock.mockReset();
  commitRewindFilesMock.mockResolvedValue({ sdkSessionId: 'fresh-thread' });
  executeCodexFileRewindPlanWithThreadRollbackMock.mockReset();
  executeCodexFileRewindPlanWithThreadRollbackMock.mockImplementation(
    async (
      _plan: unknown,
      _sessionId: string,
      hooks: { commitThreadRollback: (execution: unknown) => Promise<unknown> },
    ) => ({
      fileRewind: null,
      threadRollback: await hooks.commitThreadRollback(null),
    }),
  );
  executeCodexFileRestorePlanWithThreadRollbackMock.mockReset();
  executeCodexFileRestorePlanWithThreadRollbackMock.mockImplementation(
    async (
      _plan: unknown,
      _sessionId: string,
      hooks: { commitThreadRollback: (execution: unknown) => Promise<unknown> },
    ) => ({
      fileRestore: null,
      threadRollback: await hooks.commitThreadRollback(null),
    }),
  );
  isTurnRunningMock.mockReturnValue(false);
  recomputePrRefsForSessionMock.mockResolvedValue(undefined);
  detectCwdMock.mockResolvedValue({
    gitInstalled: false,
    isGitRepo: false,
    isInsideWorktree: false,
  });
  if (!commitRewindAtMessage) {
    ({ commitRewindAtMessage } = await import('../maker-orchestration/rewind'));
  }
});

afterEach(() => {
  clearCurrentDbClient(client);
  sqlite.close();
});

describe('Codex rewind native boundary SQL (#4994)', () => {
  it('does not borrow a native turn from history before /clear', async () => {
    insertSession({ clearedAt: 2500 });
    insertMessage({ id: 'old-user', role: 'user', createdAt: 1000 });
    insertMessage({
      id: 'old-asst',
      role: 'assistant',
      createdAt: 2000,
      agentMeta: oldAnchorMeta,
    });
    insertMessage({ id: 'target', role: 'user', createdAt: 3000 });

    await commitRewindAtMessage('sess-1', 'target');

    expect(commitRewindFilesMock).toHaveBeenCalledWith('', '', {
      tailTurnsToDrop: 1,
      rewindsToNativeThreadStart: true,
    });
  });

  it('keeps a hidden context_rebuild marker as the native-thread cutoff', async () => {
    insertSession();
    insertMessage({ id: 'old-user', role: 'user', createdAt: 1000 });
    insertMessage({
      id: 'old-asst',
      role: 'assistant',
      createdAt: 2000,
      agentMeta: oldAnchorMeta,
    });
    insertMessage({
      id: 'rebuild',
      role: 'context_rebuild',
      createdAt: 2500,
      rewindAt: 2501,
      content: JSON.stringify({ reason: 'context-overflow' }),
    });
    insertMessage({ id: 'target', role: 'user', createdAt: 3000 });

    await commitRewindAtMessage('sess-1', 'target');

    expect(commitRewindFilesMock).toHaveBeenCalledWith('', '', {
      tailTurnsToDrop: 1,
      rewindsToNativeThreadStart: true,
    });
  });

  it('refuses a target at or before /clear instead of treating it as the native thread start', async () => {
    insertSession({ clearedAt: 2500 });
    insertMessage({ id: 'old-user', role: 'user', createdAt: 1000 });
    insertMessage({
      id: 'old-asst',
      role: 'assistant',
      createdAt: 2000,
      agentMeta: oldAnchorMeta,
    });
    insertMessage({ id: 'post-clear', role: 'user', createdAt: 3000 });

    await expect(commitRewindAtMessage('sess-1', 'old-user')).rejects.toMatchObject({
      code: 'REWIND_UNSUPPORTED_HISTORY',
    });
    expect(commitRewindFilesMock).not.toHaveBeenCalled();
  });
});
