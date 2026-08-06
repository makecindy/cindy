import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as Database.Database | null,
  client: null as any,
  broadcast: vi.fn(),
  raceOnInsert: false,
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
    exec: vi.fn(async (sql: string, params: unknown[] = []) => {
      // Model /clear winning between the preflight SELECT and the guarded
      // INSERT. The single SQL statement must then insert zero rows.
      if (h.raceOnInsert && sql.startsWith('INSERT INTO messages')) {
        sqlite.prepare('UPDATE sessions SET cleared_at = ? WHERE id = ?').run(200, 's1');
      }
      return sqlite.prepare(sql).run(...params);
    }),
  };
  return sqlite;
}

describe('message persistence clear boundary', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    h.raceOnInsert = false;
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
