import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';
import { tx as runInprocTx } from '../../worker/opHandlers/tx';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as Database.Database | null,
  client: null as any,
  broadcast: vi.fn(),
  raceOnInsert: false,
  userOnInsert: false,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../session-import/legacy', () => ({
  adoptLegacySessionBeforeOpen: vi.fn(async () => undefined),
}));
vi.mock('../../../embedders/chat-history-embedder', () => ({
  onMessageCreated: vi.fn(async () => undefined),
}));
vi.mock('../../../git-context/prRefsStore', () => ({
  recomputePrRefsForSession: vi.fn(async () => undefined),
  recordPrRefsForMessage: vi.fn(async () => undefined),
}));
vi.mock('../../../cindy-media/chatAttachments', () => ({
  commitMessageMediaRefs: vi.fn(async () => undefined),
  collectCindyMediaHashes: vi.fn(() => []),
}));
vi.mock('../../../cindy-media/ledger', () => ({
  removeRefs: vi.fn(async () => undefined),
  removeSessionAttachmentRefIfUnreferencedByLiveMessage: vi.fn(async () => undefined),
}));
vi.mock('../../../device-link/invoke-context', () => ({
  isDeviceLinkInvoke: vi.fn(() => false),
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: vi.fn(() => null),
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: h.broadcast,
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => h.client,
}));

import { createMessage, rewindPersistedUserMessageAfterClear } from '../messages';

function createDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      list_preview TEXT,
      list_preview_role TEXT,
      list_message_count INTEGER,
      cleared_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active'
    );
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
  sqlite.prepare('INSERT INTO sessions (id, cleared_at, status) VALUES (?, NULL, ?)').run('s1', 'active');
  const db = drizzle(sqlite, { schema: { messages, sessions } });
  h.sqlite = sqlite;
  h.db = db;
  h.client = {
    drizzle: db,
    tx: vi.fn(async (name: string, args: unknown) => {
      if (h.raceOnInsert && name === 'message.insert') {
        sqlite.prepare('UPDATE sessions SET cleared_at = ? WHERE id = ?').run(200, 's1');
      }
      if (h.userOnInsert && name === 'message.insert') {
        sqlite.prepare("INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('user-row', 'user-first', 's1', 'user', 'hello', 100)").run();
        h.userOnInsert = false;
      }
      return runInprocTx(sqlite, { name, args });
    }),
    exec: vi.fn(async (sql: string, params: unknown[] = []) => {
      return sqlite.prepare(sql).run(...params);
    }),
  };
  return sqlite;
}

afterEach(() => { h.sqlite?.close(); });

describe('message persistence clear boundary', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    h.raceOnInsert = false;
    h.userOnInsert = false;
    sqlite = createDb();
  });

  it('uses an atomic clear-token guard for optimistic inserts', async () => {
    await expect(
      createMessage(
        's1',
        { clientId: 'client-ok', role: 'user', content: 'hello' },
        { expectedClearBoundaryMs: null },
      ),
    ).resolves.toMatchObject({ clientId: 'client-ok', content: 'hello' });

    h.raceOnInsert = true;
    await expect(
      createMessage(
        's1',
        { clientId: 'client-raced', role: 'user', content: 'stale' },
        { expectedClearBoundaryMs: null },
      ),
    ).rejects.toMatchObject({ code: 'REMOTE_OPTIMISTIC_INPUT_CLEARED' });

    expect(
      sqlite
        .prepare('SELECT 1 FROM messages WHERE session_id = ? AND client_id = ?')
        .get('s1', 'client-raced'),
    ).toBeUndefined();
  });

  // PR #6425: unit coverage through createMessage + the real SQLite transaction.
  // Existing clear-token tests do not cover a user write after the idempotency read.
  it('omits an opening when a user message wins the insert race, without broadcasting it', async () => {
    h.userOnInsert = true;
    await expect(createMessage('s1', {
      clientId: 'opening', role: 'assistant', content: 'Welcome',
    }, { requireNoUserMessage: true })).rejects.toMatchObject({ code: 'MESSAGE_USER_ALREADY_SPOKE' });
    expect(sqlite.prepare('SELECT client_id FROM messages').all()).toEqual([{ client_id: 'user-first' }]);
    expect(h.broadcast).not.toHaveBeenCalled();

    // The same guard admits an empty chat and retains clientId idempotency.
    sqlite.prepare('DELETE FROM messages').run();
    const body = { clientId: 'opening', role: 'assistant' as const, content: 'Welcome' };
    const first = await createMessage('s1', body, { requireNoUserMessage: true });
    expect(await createMessage('s1', body, { requireNoUserMessage: true })).toEqual(first);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 });
  });

  it('rewinds a row that lost the clear race and is idempotent', async () => {
    sqlite
      .prepare(
        `INSERT INTO messages
          (id, client_id, session_id, role, content, created_at, rewind_at)
         VALUES (?, ?, ?, 'user', ?, ?, NULL)`,
      )
      .run('row-1', 'client-1', 's1', 'attachment', 100);

    await rewindPersistedUserMessageAfterClear('s1', 'client-1');

    const row = sqlite
      .prepare('SELECT rewind_at AS rewindAt FROM messages WHERE session_id = ? AND client_id = ?')
      .get('s1', 'client-1') as { rewindAt: number | null };
    expect(row.rewindAt).toEqual(expect.any(Number));
    expect(h.broadcast).toHaveBeenCalledWith('local-db:messages:deleted', {
      sessionId: 's1',
      clientId: 'client-1',
      clientIds: ['client-1'],
    });
    h.broadcast.mockClear();
    await rewindPersistedUserMessageAfterClear('s1', 'client-1');
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  // A routine that keeps deferring used to leave one hidden prompt per attempt
  // (thousands of rows / hundreds of MB in one teammate chat).
  it('discards an undispatched scheduled row instead of keeping a tombstone', async () => {
    // Vector cleanup only fires on the rewind UPDATE (drizzle/0034); a bare DELETE
    // would orphan the vectors. A plain table stands in for the vec0 virtual table.
    sqlite.exec(`
      CREATE TABLE embedding_jobs (source TEXT NOT NULL, source_id TEXT NOT NULL);
      CREATE TABLE chat_messages_vec_v1 (embedding BLOB);
      CREATE TRIGGER trg_chat_rewind_clean_vec
      AFTER UPDATE OF rewind_at ON messages
      WHEN NEW.rewind_at IS NOT NULL AND OLD.rewind_at IS NULL
      BEGIN
        DELETE FROM chat_messages_vec_v1 WHERE rowid IN (
          SELECT rowid FROM embedding_jobs WHERE source = 'chat' AND source_id = NEW.id
        );
        DELETE FROM embedding_jobs WHERE source = 'chat' AND source_id = NEW.id;
      END;
    `);
    const insert = sqlite.prepare(
      `INSERT INTO messages
        (id, client_id, session_id, role, content, created_at, rewind_at)
       VALUES (?, ?, ?, 'user', ?, ?, NULL)`,
    );
    insert.run('row-owner', 'owner-1', 's1', 'owner message', 100);
    insert.run('row-scheduled', 'scheduled-1', 's1', '[UI_ACTION_TRIGGER]check tasks', 200);
    for (const [rowid, sourceId] of [[1, 'row-owner'], [2, 'row-scheduled']] as const) {
      sqlite.prepare("INSERT INTO embedding_jobs (rowid, source, source_id) VALUES (?, 'chat', ?)").run(rowid, sourceId);
      sqlite.prepare("INSERT INTO chat_messages_vec_v1 (rowid, embedding) VALUES (?, x'00')").run(rowid);
    }
    sqlite
      .prepare('UPDATE sessions SET list_preview = ?, list_preview_role = ?, list_message_count = ? WHERE id = ?')
      .run('check tasks', 'user', 2, 's1');

    await rewindPersistedUserMessageAfterClear('s1', 'scheduled-1', { discard: true });

    expect(sqlite.prepare('SELECT client_id AS clientId, rewind_at AS rewindAt FROM messages').all())
      .toEqual([{ clientId: 'owner-1', rewindAt: null }]);
    expect(sqlite.prepare('SELECT source_id AS sourceId FROM embedding_jobs').all())
      .toEqual([{ sourceId: 'row-owner' }]);
    expect(sqlite.prepare('SELECT rowid FROM chat_messages_vec_v1').all()).toEqual([{ rowid: 1 }]);
    expect(
      sqlite
        .prepare('SELECT list_preview AS preview, list_preview_role AS role, list_message_count AS count FROM sessions WHERE id = ?')
        .get('s1'),
    ).toEqual({ preview: null, role: null, count: null });
    expect(h.broadcast).toHaveBeenCalledWith('local-db:messages:deleted', {
      sessionId: 's1',
      clientId: 'scheduled-1',
      clientIds: ['scheduled-1'],
    });
    h.broadcast.mockClear();
    await rewindPersistedUserMessageAfterClear('s1', 'scheduled-1', { discard: true });
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('reconciles session attachment refs for a rewound user row', async () => {
    const { collectCindyMediaHashes } = await import('../../../cindy-media/chatAttachments');
    const { removeSessionAttachmentRefIfUnreferencedByLiveMessage } = await import(
      '../../../cindy-media/ledger',
    );
    const hash = 'a'.repeat(64);
    vi.mocked(collectCindyMediaHashes).mockReturnValue([hash]);
    sqlite
      .prepare(
        `INSERT INTO messages
          (id, client_id, session_id, role, content, created_at, rewind_at)
         VALUES (?, ?, ?, 'user', ?, ?, NULL)`,
      )
      .run('row-media', 'client-media', 's1', `cindy-media://blobs/${hash}.png`, 100);

    await rewindPersistedUserMessageAfterClear('s1', 'client-media');

    expect(removeSessionAttachmentRefIfUnreferencedByLiveMessage).toHaveBeenCalledWith({
      sessionId: 's1',
      hash,
    });
  });
});
