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
  endOrcaTeamOnInsert: false,
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

import {
  createMessage,
  rewindOrcaPreVendorCleanupRows,
  rewindPersistedUserMessageAfterClear,
} from '../messages';

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
    CREATE TABLE orca_teams (id TEXT PRIMARY KEY, status TEXT NOT NULL);
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
      if (h.endOrcaTeamOnInsert && sql.startsWith('INSERT INTO messages')) {
        sqlite.prepare("UPDATE orca_teams SET status = 'completed' WHERE id = ?").run('team-1');
      }
      return sqlite.prepare(sql).run(...params);
    }),
    query: vi.fn(async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).all(...params)),
    queryOne: vi.fn(async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).get(...params)),
  };
  return sqlite;
}

describe('message persistence clear boundary', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    h.raceOnInsert = false;
    h.endOrcaTeamOnInsert = false;
    sqlite = createDb();
  });

  it('atomically rejects an Orca row when another instance ends the team', async () => {
    sqlite.prepare("INSERT INTO orca_teams (id, status) VALUES (?, 'active')").run('team-1');
    await expect(createMessage('s1', {
      clientId: 'orca-ok', role: 'user', content: 'first',
      agentMeta: { orcaPreVendorCleanup: { teamId: 'team-1' } },
    }, { expectedOrcaTeamId: 'team-1' })).resolves.toMatchObject({ clientId: 'orca-ok' });

    h.endOrcaTeamOnInsert = true;
    await expect(createMessage('s1', {
      clientId: 'orca-raced', role: 'user', content: 'late',
      agentMeta: { orcaPreVendorCleanup: { teamId: 'team-1' } },
    }, { expectedOrcaTeamId: 'team-1' })).rejects.toThrow('ORCA_TEAM_INACTIVE');
    expect(sqlite.prepare(
      'SELECT 1 FROM messages WHERE session_id = ? AND client_id = ?',
    ).get('s1', 'orca-raced')).toBeUndefined();
  });

  it('rewinds only rows that still carry the matching pre-vendor marker', async () => {
    const insert = sqlite.prepare(
      `INSERT INTO messages
        (id, client_id, session_id, role, content, agent_meta, created_at, rewind_at)
       VALUES (?, ?, 's1', 'user', ?, ?, 100, NULL)`,
    );
    insert.run('pending-row', 'pending-client', 'pending', JSON.stringify({
      orcaPreVendorCleanup: { teamId: 'team-1' },
    }));
    insert.run('submitted-row', 'submitted-client', 'submitted', JSON.stringify({}));

    await expect(rewindOrcaPreVendorCleanupRows('team-1', ['s1'])).resolves.toEqual([
      { sessionId: 's1', clientId: 'pending-client' },
    ]);
    expect(sqlite.prepare(
      'SELECT client_id AS clientId, rewind_at AS rewindAt FROM messages ORDER BY client_id',
    ).all()).toEqual([
      { clientId: 'pending-client', rewindAt: expect.any(Number) },
      { clientId: 'submitted-client', rewindAt: null },
    ]);
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
