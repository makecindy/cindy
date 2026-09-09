import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { transpileModule, ScriptTarget } from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';
import type { DbClient } from '../../client/DbClient';
import { tx as runInprocTx } from '../../worker/opHandlers/tx';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as Database.Database | null,
  client: null as unknown as DbClient,
  broadcast: vi.fn(),
  warn: vi.fn(),
  raceOnInsert: false,
  endOrcaTeamOnInsert: false,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() }),
}));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() }),
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
  finalizeRewoundOrcaPreVendorCleanupRows,
  rewindOrcaPreVendorCleanupRows,
  rewindPersistedUserMessageAfterClear,
} from '../messages';

// Exercise the real terminal/disable closure while retaining the real finalizer
// and SQLite-backed message reads. Runtime-only host actions are observable stubs.
const registerSource = readFileSync(
  new URL('../../../maker-ipc/register.ts', import.meta.url), 'utf8',
).replace(/\r\n/g, '\n');
const cleanupStart = registerSource.indexOf('  type OrcaTeamCleanupScope =');
const cleanupEnd = registerSource.indexOf('  function enableOrcaWithLeadLifecycleLock(', cleanupStart);
expect(cleanupStart).toBeGreaterThanOrEqual(0);
expect(cleanupEnd).toBeGreaterThan(cleanupStart);
const disableCleanupJs = transpileModule(
  `${registerSource.slice(cleanupStart, cleanupEnd)}\nreturn disableOrcaInternal;`,
  { compilerOptions: { target: ScriptTarget.ES2022 } },
).outputText;

function postCommitDisableHarness(sqlite: Database.Database, onCommitted: () => void) {
  const abort = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const archive = vi.fn(async () => ['worker-1']);
  const clearLead = vi.fn(async () => undefined);
  const discard = vi.fn(async () => undefined);
  const deps = {
    getDbClient: () => h.client,
    getActiveTeamByLead: async () => ({ id: 'team-1' }),
    listWorkersByLead: async () => [{ teamId: 'team-1', sessionId: 'worker-1' }],
    markTeamEnded: async (_teamId: string, _status: string, hooks: {
      beforeTerminalCommit(): Promise<void>;
    }) => {
      await hooks.beforeTerminalCommit();
      sqlite.exec("UPDATE orca_teams SET status = 'completed' WHERE id = 'team-1'");
      sqlite.exec("UPDATE messages SET rewind_at = 200 WHERE client_id = 'postcommit'");
      onCommitted();
      return [{ sessionId: 's1', clientId: 'postcommit' }];
    },
    finalizeRewoundOrcaPreVendorCleanupRows,
    rewindOrcaPreVendorCleanupRows: async () => [],
    inputCoordinator: {
      discardQueuedItemsWhere: discard,
      persistOrcaCleanupIntentWhere: async () => undefined,
    },
    resolveOrcaQueueItemTeamId: () => 'team-1',
    persistedOrcaPreVendorInputsForTeam: () => new Map(),
    orcaInterAgentDispatcher: { waitForTeamDispatchSettlements: async () => undefined },
    orcaTeamService: { clearAutoBridgeState: vi.fn() },
    cancelIOSSimulatorSessionOperations: async () => undefined,
    maker: { getSession: () => ({ isTurnRunning: () => true, abort }), closeSession: close },
    cleanupPendingInteractionsForSession: vi.fn(),
    forgetKnownOrcaWorkerSession: vi.fn(),
    markWorkersStatusByTeam: async () => undefined,
    captureSessionRecycleScope: vi.fn(),
    archiveWorkersByTeam: archive,
    recycleSessionWorktreeForStatusChange: async () => undefined,
    clearLeadOrcaRoleState: clearLead,
    log: { info: vi.fn(), warn: h.warn },
  };
  const run = new Function(...Object.keys(deps), disableCleanupJs)(...Object.values(deps)) as (
    leadSessionId: string,
  ) => Promise<{ ok: true }>;
  return { run, abort, close, archive, clearLead, discard };
}

function createDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cleared_at INTEGER,
      list_preview TEXT,
      list_preview_role TEXT,
      list_message_count INTEGER,
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
    tx: vi.fn(async (name: string, args: unknown) => {
      // Model /clear winning between the preflight SELECT and the guarded
      // INSERT. The single SQL statement must then insert zero rows.
      if (h.raceOnInsert && name === 'message.insert') {
        sqlite.prepare('UPDATE sessions SET cleared_at = ? WHERE id = ?').run(200, 's1');
      }
      if (h.endOrcaTeamOnInsert && name === 'message.insert') {
        sqlite.prepare("UPDATE orca_teams SET status = 'completed' WHERE id = ?").run('team-1');
      }
      return runInprocTx(sqlite, { name, args });
    }),
    exec: vi.fn(async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).run(...params)),
    query: vi.fn(async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).all(...params)),
    queryOne: vi.fn(async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).get(...params)),
  } as unknown as DbClient;
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

  afterEach(() => sqlite.close());

  it('invalidates the list projection only when an Orca insert succeeds', async () => {
    sqlite.prepare("INSERT INTO orca_teams (id, status) VALUES (?, 'active')").run('team-1');
    const cachePreview = () => sqlite.prepare(
      "UPDATE sessions SET list_preview = 'cached', list_preview_role = 'user', list_message_count = 1 WHERE id = 's1'",
    ).run();
    const readProjection = () => sqlite.prepare(
      "SELECT list_preview, list_preview_role, list_message_count FROM sessions WHERE id = 's1'",
    ).get();
    cachePreview();
    await createMessage('s1', {
      clientId: 'orca-projection', role: 'user', content: 'first',
      agentMeta: { orcaPreVendorCleanup: { teamId: 'team-1' } },
    }, { expectedOrcaTeamId: 'team-1', expectedClearBoundaryMs: null });
    expect(readProjection()).toEqual({
      list_preview: null, list_preview_role: null, list_message_count: null,
    });

    cachePreview();
    h.endOrcaTeamOnInsert = true;
    await expect(createMessage('s1', {
      clientId: 'orca-projection-rejected', role: 'user', content: 'late',
      agentMeta: { orcaPreVendorCleanup: { teamId: 'team-1' } },
    }, { expectedOrcaTeamId: 'team-1', expectedClearBoundaryMs: null }))
      .rejects.toThrow('ORCA_TEAM_INACTIVE');
    expect(readProjection()).toEqual({
      list_preview: 'cached', list_preview_role: 'user', list_message_count: 1,
    });
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
    insert.run('submitted-row', 'submitted-client', 'submitted', JSON.stringify({
      orcaPreVendorCleanup: { teamId: 'team-1', phase: 'submitted' },
    }));

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

  it('does not redispatch an idempotent Orca row already marked submitted', async () => {
    sqlite.prepare("INSERT INTO orca_teams (id, status) VALUES (?, 'active')").run('team-1');
    sqlite.prepare(
      `INSERT INTO messages
        (id, client_id, session_id, role, content, agent_meta, created_at, rewind_at)
       VALUES (?, ?, 's1', 'user', ?, ?, 100, NULL)`,
    ).run(
      'submitted-row',
      'submitted-client',
      'submitted',
      JSON.stringify({
        orcaPreVendorCleanup: { teamId: 'team-1', phase: 'submitted' },
      }),
    );

    await expect(createMessage('s1', {
      clientId: 'submitted-client',
      role: 'user',
      content: 'retry',
      agentMeta: { orcaPreVendorCleanup: { teamId: 'team-1' } },
    }, { expectedOrcaTeamId: 'team-1' })).rejects.toMatchObject({
      code: 'TURN_DISPATCH_UNCONFIRMED',
      message: expect.stringContaining('ORCA_MESSAGE_ALREADY_SUBMITTED'),
    });
    expect(sqlite.prepare(
      'SELECT rewind_at AS rewindAt FROM messages WHERE id = ?',
    ).get('submitted-row')).toEqual({ rewindAt: null });
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

  it('atomically preserves a submitted Orca row during selective invalidation', async () => {
    const insert = sqlite.prepare(
      `INSERT INTO messages
        (id, client_id, session_id, role, content, agent_meta, created_at, rewind_at)
       VALUES (?, ?, 's1', 'user', ?, ?, 100, NULL)`,
    );
    insert.run('pending-row', 'pending-client', 'pending', JSON.stringify({
      orcaPreVendorCleanup: { teamId: 'team-1' },
    }));
    insert.run('submitted-row', 'submitted-client', 'submitted', JSON.stringify({
      orcaPreVendorCleanup: { teamId: 'team-1', phase: 'submitted' },
    }));

    await expect(
      rewindPersistedUserMessageAfterClear('s1', 'pending-client', {
        preserveSubmittedOrca: true,
      }),
    ).resolves.toBe(true);
    await expect(
      rewindPersistedUserMessageAfterClear('s1', 'submitted-client', {
        preserveSubmittedOrca: true,
      }),
    ).resolves.toBe(false);

    expect(sqlite.prepare(
      'SELECT client_id AS clientId, rewind_at AS rewindAt FROM messages ORDER BY client_id',
    ).all()).toEqual([
      { clientId: 'pending-client', rewindAt: expect.any(Number) },
      { clientId: 'submitted-client', rewindAt: null },
    ]);
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

    expect(removeSessionAttachmentRefIfUnreferencedByLiveMessage).toHaveBeenCalledWith(
      { sessionId: 's1', hash }, h.db,
    );
  });

  it.each(['transient', 'persistent'] as const)(
    'finishes disabling Orca after a %s post-commit row-query failure',
    async (failure) => {
      sqlite.prepare("INSERT INTO orca_teams (id, status) VALUES ('team-1', 'active')").run();
      sqlite.prepare(
        "INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('postcommit-row', 'postcommit', 's1', 'user', 'queued', 100)",
      ).run();
      const queryError = new Error('post-commit row query failed');
      const select = vi.spyOn(h.client.drizzle, 'select');
      const disable = postCommitDisableHarness(sqlite, () => {
        if (failure === 'transient') select.mockImplementationOnce(() => { throw queryError; });
        else select.mockImplementation(() => { throw queryError; });
      });

      await expect(disable.run('lead-1')).resolves.toEqual({ ok: true });

      expect(sqlite.prepare("SELECT status FROM orca_teams WHERE id = 'team-1'").get())
        .toEqual({ status: 'completed' });
      expect(sqlite.prepare("SELECT rewind_at FROM messages WHERE client_id = 'postcommit'").get())
        .toEqual({ rewind_at: 200 });
      expect(select).toHaveBeenCalledTimes(failure === 'transient' ? 2 : 3);
      expect(disable.discard).toHaveBeenCalledTimes(2);
      expect(disable.abort).toHaveBeenCalledOnce();
      expect(disable.close).toHaveBeenCalledWith('worker-1');
      expect(disable.archive).toHaveBeenCalledWith('team-1');
      expect(disable.clearLead).toHaveBeenCalledWith('lead-1');
      if (failure === 'persistent') {
        expect(h.warn).toHaveBeenCalledWith('post-commit Orca row finalization failed', {
          sessionId: 's1', clientId: 'postcommit', attempts: 3, error: queryError.message,
        });
      } else {
        expect(h.broadcast).toHaveBeenCalled();
        expect(h.warn).not.toHaveBeenCalled();
      }
    },
  );

  it('stops terminal cleanup if owner changes during a failed post-commit row query', async () => {
    sqlite.prepare("INSERT INTO orca_teams (id, status) VALUES ('team-1', 'active')").run();
    const select = vi.spyOn(h.client.drizzle, 'select');
    const disable = postCommitDisableHarness(sqlite, () => {
      select.mockImplementationOnce(() => {
        h.client = { ...h.client, tx: vi.fn() };
        throw new Error('old database connection closed');
      });
    });

    await expect(disable.run('lead-1')).rejects.toThrow('ORCA_CLEANUP_OWNER_CHANGED');

    expect(select).toHaveBeenCalledOnce();
    expect(h.client.tx).not.toHaveBeenCalled();
    expect(disable.discard).not.toHaveBeenCalled();
    expect(disable.abort).not.toHaveBeenCalled();
    expect(disable.close).not.toHaveBeenCalled();
    expect(disable.archive).not.toHaveBeenCalled();
    expect(disable.clearLead).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('does not apply an old cleanup receipt to matching IDs in the next owner database', async () => {
    const previousClient = h.client;
    const nextOwnerDb = createDb();
    try {
      nextOwnerDb.prepare(
        "INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('shared-id', 'shared-client', 's1', 'user', 'next owner', 1)",
      ).run();
      await finalizeRewoundOrcaPreVendorCleanupRows([
        { sessionId: 's1', clientId: 'shared-client' },
      ], previousClient);
      expect(nextOwnerDb.prepare(
        "SELECT rewind_at FROM messages WHERE client_id = 'shared-client'",
      ).get()).toEqual({ rewind_at: null });
      expect(h.broadcast).not.toHaveBeenCalled();
      const { removeRefs } = await import('../../../cindy-media/ledger');
      expect(removeRefs).not.toHaveBeenCalled();
    } finally {
      nextOwnerDb.close();
    }
  });

  it('stops finalizing a durable recovery sweep when its database owner changes', async () => {
    sqlite.prepare(
      "INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at) VALUES ('pending', 'pending', 's1', 'user', 'pending', ?, 1)",
    ).run(JSON.stringify({ orcaPreVendorCleanup: { teamId: 'team-1' } }));
    vi.mocked(h.client.tx).mockImplementationOnce((async (name: string, args: unknown) => {
      const result = runInprocTx(sqlite, { name, args });
      h.client = { ...h.client };
      return result;
    }) as DbClient['tx']);
    await expect(rewindOrcaPreVendorCleanupRows('team-1', ['s1'])).resolves.toEqual([
      { sessionId: 's1', clientId: 'pending' },
    ]);
    const { removeRefs } = await import('../../../cindy-media/ledger');
    expect(removeRefs).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('rejects a stale recovery scope before issuing any transaction', async () => {
    const previousClient = h.client;
    h.client = { ...h.client, tx: vi.fn() };
    await expect(rewindOrcaPreVendorCleanupRows('team-1', ['s1'], previousClient))
      .rejects.toThrow('ORCA_CLEANUP_OWNER_CHANGED');
    expect(previousClient.tx).not.toHaveBeenCalled();
    expect(h.client.tx).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('pins media cleanup to the original database and stops after an owner change', async () => {
    sqlite.prepare(
      "INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('pending', 'pending', 's1', 'user', 'pending', 1)",
    ).run();
    const originalDb = h.db;
    const { removeRefs, removeSessionAttachmentRefIfUnreferencedByLiveMessage } = await import(
      '../../../cindy-media/ledger',
    );
    vi.mocked(removeRefs).mockImplementationOnce(async () => {
      h.client = { ...h.client };
      return 1;
    });
    await rewindPersistedUserMessageAfterClear('s1', 'pending');
    expect(removeRefs).toHaveBeenCalledWith({ refKind: 'message', refId: 'pending' }, originalDb);
    expect(removeSessionAttachmentRefIfUnreferencedByLiveMessage).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });
});
