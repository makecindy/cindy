/**
 * retry-supersede:supersedeRetriedUserTurn 的窗口定位、守卫与广播契约。
 *
 * 场景背景:零产出失败 turn 被「重试」克隆重发后,历史里会留下两条一模一样的
 * user 行(旧行 + 克隆行)与夹在中间的 error 行。本函数把旧 user 行与窗口内的
 * error 行软删(置 rewind_at),经 messages:deleted 广播让各端移除。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  tapWindowBroadcast: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../maker-host/codex-local-sessions', () => ({
  importExternalCodexMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../maker-host/claude-local-sessions', () => ({
  importExternalClaudeCodeMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../embedders/chat-history-embedder', () => ({
  onMessageCreated: vi.fn(async () => undefined),
}));
vi.mock('../../../git-context/prRefsStore', () => ({
  recomputePrRefsForSession: vi.fn(async () => undefined),
  recordPrRefsForMessage: vi.fn(async () => undefined),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  tapWindowBroadcast: h.tapWindowBroadcast,
}));

import { supersedeRetriedUserTurn } from '../messages';

const SESSION = 'session-1';

function createDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      agent_kind TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
    CREATE UNIQUE INDEX uniq_messages_session_client ON messages(session_id, client_id);
  `);
  h.db = drizzle(sqlite, { schema: { messages, sessions } });
  return sqlite;
}

function insertRow(
  sqlite: Database.Database,
  input: {
    clientId: string;
    role: string;
    createdAt: number;
    sessionId?: string;
    rewindAt?: number | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO messages (id, client_id, session_id, role, content, created_at, rewind_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `id-${input.clientId}`,
      input.clientId,
      input.sessionId ?? SESSION,
      input.role,
      JSON.stringify({ text: input.clientId }),
      input.createdAt,
      input.rewindAt ?? null,
    );
}

function rewindAtOf(sqlite: Database.Database, clientId: string): number | null {
  const row = sqlite
    .prepare('SELECT rewind_at AS rewindAt FROM messages WHERE session_id = ? AND client_id = ?')
    .get(SESSION, clientId) as { rewindAt: number | null } | undefined;
  if (!row) throw new Error(`row not found: ${clientId}`);
  return row.rewindAt;
}

describe('supersedeRetriedUserTurn', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = createDb();
  });

  it('soft-deletes the superseded user row and the error rows inside the window', async () => {
    insertRow(sqlite, { clientId: 'user-0', role: 'user', createdAt: 100 });
    insertRow(sqlite, { clientId: 'error-0', role: 'error', createdAt: 101 });
    insertRow(sqlite, { clientId: 'user-1', role: 'user', createdAt: 200 });

    const removed = await supersedeRetriedUserTurn(SESSION, {
      supersededUserClientId: 'user-0',
      retryUserClientId: 'user-1',
    });

    expect(removed).toEqual(['user-0', 'error-0']);
    expect(rewindAtOf(sqlite, 'user-0')).toEqual(expect.any(Number));
    expect(rewindAtOf(sqlite, 'error-0')).toEqual(expect.any(Number));
    expect(rewindAtOf(sqlite, 'user-1')).toBeNull();
    // 广播复用消息删除通道:本机窗口(mock 为空)之外,device-link 转发必须带上
    // 单值兼容位(clientId)与整批 clientIds。
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:messages:deleted', {
      sessionId: SESSION,
      clientId: 'user-0',
      clientIds: ['user-0', 'error-0'],
    });
  });

  it('keeps rows outside the (created_at, rowid) window and non-error rows inside it', async () => {
    insertRow(sqlite, { clientId: 'error-before', role: 'error', createdAt: 50 });
    insertRow(sqlite, { clientId: 'user-0', role: 'user', createdAt: 100 });
    // 防御:窗口内非 error 行绝不触碰(零产出场景本不该有,误闯的产出行也要保住)。
    insertRow(sqlite, { clientId: 'assistant-mid', role: 'assistant', createdAt: 150 });
    insertRow(sqlite, { clientId: 'error-mid', role: 'error', createdAt: 160 });
    insertRow(sqlite, { clientId: 'user-1', role: 'user', createdAt: 200 });
    insertRow(sqlite, { clientId: 'error-after', role: 'error', createdAt: 300 });

    const removed = await supersedeRetriedUserTurn(SESSION, {
      supersededUserClientId: 'user-0',
      retryUserClientId: 'user-1',
    });

    expect(removed).toEqual(['user-0', 'error-mid']);
    expect(rewindAtOf(sqlite, 'error-before')).toBeNull();
    expect(rewindAtOf(sqlite, 'assistant-mid')).toBeNull();
    expect(rewindAtOf(sqlite, 'error-after')).toBeNull();
  });

  it('breaks created_at ties with rowid on both window edges', async () => {
    // error 行的 createdAt 被设计成"本轮最后行 + 1",但历史数据/时钟边缘仍可能
    // 与相邻 user 行同毫秒 —— 窗口两端都必须退回 rowid 比插入序。
    insertRow(sqlite, { clientId: 'user-0', role: 'user', createdAt: 100 });
    insertRow(sqlite, { clientId: 'error-0', role: 'error', createdAt: 100 });
    insertRow(sqlite, { clientId: 'user-1', role: 'user', createdAt: 100 });
    insertRow(sqlite, { clientId: 'error-late', role: 'error', createdAt: 100 });

    const removed = await supersedeRetriedUserTurn(SESSION, {
      supersededUserClientId: 'user-0',
      retryUserClientId: 'user-1',
    });

    expect(removed).toEqual(['user-0', 'error-0']);
    expect(rewindAtOf(sqlite, 'error-late')).toBeNull();
  });

  it('is a no-op when the superseded row is missing, already hidden, or not a user row', async () => {
    insertRow(sqlite, { clientId: 'user-1', role: 'user', createdAt: 200 });

    await expect(
      supersedeRetriedUserTurn(SESSION, {
        supersededUserClientId: 'missing',
        retryUserClientId: 'user-1',
      }),
    ).resolves.toEqual([]);

    insertRow(sqlite, { clientId: 'user-0', role: 'user', createdAt: 100, rewindAt: 90 });
    await expect(
      supersedeRetriedUserTurn(SESSION, {
        supersededUserClientId: 'user-0',
        retryUserClientId: 'user-1',
      }),
    ).resolves.toEqual([]);

    insertRow(sqlite, { clientId: 'error-x', role: 'error', createdAt: 110 });
    await expect(
      supersedeRetriedUserTurn(SESSION, {
        supersededUserClientId: 'error-x',
        retryUserClientId: 'user-1',
      }),
    ).resolves.toEqual([]);

    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  it('is a no-op when the retry row has not been persisted (deferred error race guard)', async () => {
    insertRow(sqlite, { clientId: 'user-0', role: 'user', createdAt: 100 });

    await expect(
      supersedeRetriedUserTurn(SESSION, {
        supersededUserClientId: 'user-0',
        retryUserClientId: 'not-persisted-yet',
      }),
    ).resolves.toEqual([]);

    expect(rewindAtOf(sqlite, 'user-0')).toBeNull();
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  it('is idempotent: a second call after success is a no-op', async () => {
    insertRow(sqlite, { clientId: 'user-0', role: 'user', createdAt: 100 });
    insertRow(sqlite, { clientId: 'error-0', role: 'error', createdAt: 101 });
    insertRow(sqlite, { clientId: 'user-1', role: 'user', createdAt: 200 });

    await supersedeRetriedUserTurn(SESSION, {
      supersededUserClientId: 'user-0',
      retryUserClientId: 'user-1',
    });
    h.tapWindowBroadcast.mockClear();

    await expect(
      supersedeRetriedUserTurn(SESSION, {
        supersededUserClientId: 'user-0',
        retryUserClientId: 'user-1',
      }),
    ).resolves.toEqual([]);
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  it('never crosses session boundaries', async () => {
    insertRow(sqlite, { clientId: 'user-0', role: 'user', createdAt: 100 });
    insertRow(sqlite, { clientId: 'error-other', role: 'error', createdAt: 150, sessionId: 'other' });
    insertRow(sqlite, { clientId: 'user-1', role: 'user', createdAt: 200 });

    const removed = await supersedeRetriedUserTurn(SESSION, {
      supersededUserClientId: 'user-0',
      retryUserClientId: 'user-1',
    });

    expect(removed).toEqual(['user-0']);
    const other = sqlite
      .prepare("SELECT rewind_at AS rewindAt FROM messages WHERE session_id = 'other'")
      .get() as { rewindAt: number | null };
    expect(other.rewindAt).toBeNull();
  });
});
