import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current.js';
import * as schema from '../schema.js';

const h = vi.hoisted(() => ({
  tapWindowBroadcast: vi.fn(),
  notifyAgentIslandSessionPatch: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: h.tapWindowBroadcast,
}));
vi.mock('../agentIslandSessionPatch.js', () => ({
  notifyAgentIslandSessionPatch: h.notifyAgentIslandSessionPatch,
}));

describe('orcaTeamStore', () => {
  let currentClient: DbClient | null = null;
  let rawDb: Database.Database | null = null;

  afterEach(async () => {
    vi.clearAllMocks();
    if (currentClient) {
      clearCurrentDbClient(currentClient);
      currentClient = null;
    }
    rawDb?.close();
    rawDb = null;
  });

  it('requires workerId and workerSessionId to match the same row when both are supplied', async () => {
    const { getWorkerLink } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');

    await seedOrcaWorkers(client);

    await expect(
      getWorkerLink({
        workerId: 'worker-1',
        workerSessionId: 'worker-session-2',
      }),
    ).resolves.toBeNull();

    await expect(
      getWorkerLink({
        workerId: 'worker-1',
        workerSessionId: 'worker-session-1',
      }),
    ).resolves.toMatchObject({
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-session-1',
      leadSession: {
        providerId: 'openai',
      },
    });
  });

  it('notifies Agent Island when Orca archives worker sessions', async () => {
    const { archiveWorkersByTeam } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');

    await seedOrcaWorkers(client);

    await expect(archiveWorkersByTeam('team-1')).resolves.toEqual([
      'worker-session-1',
      'worker-session-2',
    ]);

    expect(
      await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM sessions WHERE id IN (?, ?) ORDER BY id',
        ['worker-session-1', 'worker-session-2'],
      ),
    ).toEqual([
      { id: 'worker-session-1', status: 'archived' },
      { id: 'worker-session-2', status: 'archived' },
    ]);
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'worker-session-1',
      patch: { status: 'archived' },
    });
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'worker-session-2',
      patch: { status: 'archived' },
    });

    expect(h.notifyAgentIslandSessionPatch).toHaveBeenCalledWith('worker-session-1', {
      status: 'archived',
    });
    expect(h.notifyAgentIslandSessionPatch).toHaveBeenCalledWith('worker-session-2', {
      status: 'archived',
    });
  });

  it('executes worker status CAS updates and only rolls back idle acknowledgements', async () => {
    const {
      markWorkerIdleIfStatus,
      restoreWorkerDoneIfIdle,
      restoreWorkerStatusIfIdle,
    } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');

    await seedOrcaWorkers(client);
    await client.exec('UPDATE orca_workers SET status = ? WHERE id = ?', ['done', 'worker-1']);

    await expect(markWorkerIdleIfStatus('worker-1', 'done')).resolves.toBe(true);
    await expect(markWorkerIdleIfStatus('worker-1', 'done')).resolves.toBe(false);
    await expect(restoreWorkerDoneIfIdle('worker-1')).resolves.toBe(true);
    await expect(restoreWorkerDoneIfIdle('worker-1')).resolves.toBe(false);
    await client.exec('UPDATE orca_workers SET status = ? WHERE id = ?', ['running', 'worker-2']);
    await expect(markWorkerIdleIfStatus('worker-2', 'running')).resolves.toBe(true);
    await expect(restoreWorkerStatusIfIdle('worker-2', 'running')).resolves.toBe(true);
    await expect(restoreWorkerStatusIfIdle('worker-2', 'running')).resolves.toBe(false);

    await expect(
      client.query<{ id: string; status: string; idle_since: number | null }>(
        'SELECT id, status, idle_since FROM orca_workers ORDER BY id',
      ),
    ).resolves.toEqual([
      { id: 'worker-1', status: 'done', idle_since: null },
      { id: 'worker-2', status: 'running', idle_since: null },
    ]);
  });

  it('clears a restored runtime marker and keeps failures eligible for lazy resume', async () => {
    const { clearWorkerIdleReleaseMarker } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');

    await seedOrcaWorkers(client);
    await client.exec(
      'UPDATE orca_workers SET status = ?, idle_since = ? WHERE id = ?',
      ['done', 123_000, 'worker-1'],
    );
    await client.exec(
      'UPDATE orca_workers SET status = ?, idle_since = ? WHERE id = ?',
      ['error', 124_000, 'worker-2'],
    );

    await expect(clearWorkerIdleReleaseMarker('worker-session-1')).resolves.toBe(true);
    await expect(clearWorkerIdleReleaseMarker('worker-session-1')).resolves.toBe(false);
    await expect(clearWorkerIdleReleaseMarker('worker-session-2')).resolves.toBe(true);
    await expect(
      client.query<{ id: string; status: string; idle_since: number | null }>(
        'SELECT id, status, idle_since FROM orca_workers ORDER BY id',
      ),
    ).resolves.toEqual([
      { id: 'worker-1', status: 'done', idle_since: null },
      { id: 'worker-2', status: 'idle', idle_since: null },
    ]);
  });

  it('persists a runtime release after a terminal status update races the close', async () => {
    const {
      markWorkerRuntimeReleaseIntent,
      restoreWorkerRuntimeRelease,
    } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');

    await seedOrcaWorkers(client);
    await client.exec(
      'UPDATE orca_workers SET status = ?, updated_at = ? WHERE id = ?',
      ['error', 99_000, 'worker-1'],
    );

    await expect(
      markWorkerRuntimeReleaseIntent('worker-1', 'wrong-session', 123_000),
    ).resolves.toBe(false);
    await expect(
      markWorkerRuntimeReleaseIntent('worker-1', 'worker-session-1', 123_000),
    ).resolves.toBe(true);
    await expect(
      markWorkerRuntimeReleaseIntent('worker-1', 'worker-session-1', 124_000),
    ).resolves.toBe(false);
    await expect(
      client.queryOne<{ status: string; idle_since: number | null; updated_at: number }>(
        'SELECT status, idle_since, updated_at FROM orca_workers WHERE id = ?',
        ['worker-1'],
      ),
    ).resolves.toEqual({ status: 'idle', idle_since: 123_000, updated_at: 123_000 });

    await client.exec('UPDATE orca_workers SET status = ? WHERE id = ?', ['error', 'worker-1']);
    await expect(
      restoreWorkerRuntimeRelease(
        'worker-1',
        'worker-session-1',
        123_000,
        'done',
        125_000,
      ),
    ).resolves.toBe(true);
    await expect(
      client.queryOne<{ status: string; idle_since: number | null; updated_at: number }>(
        'SELECT status, idle_since, updated_at FROM orca_workers WHERE id = ?',
        ['worker-1'],
      ),
    ).resolves.toEqual({ status: 'error', idle_since: null, updated_at: 125_000 });
  });

  it('restores the previous worker status when a runtime release is rolled back', async () => {
    const {
      markWorkerRuntimeReleaseIntent,
      restoreWorkerRuntimeRelease,
    } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');

    await seedOrcaWorkers(client);
    await client.exec('UPDATE orca_workers SET status = ? WHERE id = ?', ['done', 'worker-1']);

    await expect(
      markWorkerRuntimeReleaseIntent('worker-1', 'worker-session-1', 123_000),
    ).resolves.toBe(true);
    await expect(
      restoreWorkerRuntimeRelease(
        'worker-1',
        'worker-session-1',
        123_000,
        'done',
        124_000,
      ),
    ).resolves.toBe(true);
    await expect(
      restoreWorkerRuntimeRelease(
        'worker-1',
        'worker-session-1',
        123_000,
        'done',
        125_000,
      ),
    ).resolves.toBe(false);
    await expect(
      client.queryOne<{ status: string; idle_since: number | null; updated_at: number }>(
        'SELECT status, idle_since, updated_at FROM orca_workers WHERE id = ?',
        ['worker-1'],
      ),
    ).resolves.toEqual({ status: 'done', idle_since: null, updated_at: 124_000 });
  });

  it('rejects a stale runtime release candidate after another instance updates it', async () => {
    const { markWorkerRuntimeReleaseIntent } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');

    await seedOrcaWorkers(client);
    const scannedUpdatedAt = 100_000;
    await client.exec(
      'UPDATE orca_workers SET status = ?, idle_since = NULL, updated_at = ? WHERE id = ?',
      ['done', scannedUpdatedAt, 'worker-1'],
    );
    await client.exec(
      'UPDATE orca_workers SET status = ?, idle_since = NULL, updated_at = ? WHERE id = ?',
      ['running', 120_000, 'worker-1'],
    );

    await expect(
      markWorkerRuntimeReleaseIntent(
        'worker-1',
        'worker-session-1',
        123_000,
        scannedUpdatedAt,
      ),
    ).resolves.toBe(false);
    await expect(
      client.queryOne<{ status: string; idle_since: number | null; updated_at: number }>(
        'SELECT status, idle_since, updated_at FROM orca_workers WHERE id = ?',
        ['worker-1'],
      ),
    ).resolves.toEqual({ status: 'running', idle_since: null, updated_at: 120_000 });
  });

  function createTestDbClient(): DbClient {
    const dbHandle = new Database(':memory:');
    rawDb = dbHandle;
    dbHandle.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New Maker',
        working_dir TEXT,
        workspace_kind TEXT NOT NULL DEFAULT 'project',
        model TEXT NOT NULL DEFAULT 'gpt-5.4',
        effort TEXT NOT NULL DEFAULT 'high',
        permission_mode TEXT NOT NULL DEFAULT 'ask',
        status TEXT NOT NULL DEFAULT 'active',
        sdk_session_id TEXT,
        total_token_usage INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        total_cost_amount REAL NOT NULL DEFAULT 0,
        total_cost_currency TEXT,
        total_cost_is_approximate INTEGER NOT NULL DEFAULT 0,
        context_tokens INTEGER NOT NULL DEFAULT 0,
        context_window INTEGER NOT NULL DEFAULT 0,
        fast_mode INTEGER NOT NULL DEFAULT 0,
        plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
        cleared_at INTEGER,
        pinned_at INTEGER,
        summary TEXT,
        user_send_at INTEGER,
        agent_kind TEXT NOT NULL DEFAULT 'codex',
        orca_role TEXT,
        parent_session_id TEXT,
        forked_at_message_id TEXT,
        worktree_path TEXT,
        source TEXT NOT NULL DEFAULT 'desktop',
        feishu_open_id TEXT,
        feishu_bot_app_id TEXT,
        im_bot_context_id TEXT,
        im_user_id TEXT,
        used_project_context INTEGER NOT NULL DEFAULT 0,
        codex_history_has_product_prompt INTEGER,
        extra_dirs TEXT NOT NULL DEFAULT '[]',
        remote_host_id TEXT,
        provider_id TEXT,
        active_turn_started_at INTEGER,
        active_turn_pid INTEGER,
        last_turn_ended_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE orca_teams (
        id TEXT PRIMARY KEY,
        lead_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE orca_workers (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        label TEXT,
        worktree_branch TEXT,
        role TEXT NOT NULL DEFAULT 'developer',
        focused INTEGER NOT NULL DEFAULT 0,
        idle_since INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const db = drizzle(dbHandle, { schema });
    const client: DbClient = {
      query: async <T = unknown>(sql: string, params: unknown[] = []) =>
        dbHandle.prepare(sql).all(...params) as T[],
      queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
        dbHandle.prepare(sql).get(...params) as T | undefined,
      exec: async (sql, params = []) => dbHandle.prepare(sql).run(...params),
      tx: async () => {
        throw new Error('tx is not used by this test');
      },
      drizzle: db,
      vecAvailable: false,
      dispose: async () => {},
    };
    currentClient = client;
    return client;
  }
});

async function seedOrcaWorkers(client: DbClient): Promise<void> {
  const now = Date.now();
  await client.exec(
    'INSERT INTO sessions (id, title, agent_kind, orca_role, provider_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['lead-session-1', 'Lead', 'codex', 'lead', 'openai', now, now],
  );
  await client.exec(
    'INSERT INTO sessions (id, title, agent_kind, orca_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['worker-session-1', 'Worker 1', 'codex', 'worker', now, now],
  );
  await client.exec(
    'INSERT INTO sessions (id, title, agent_kind, orca_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['worker-session-2', 'Worker 2', 'codex', 'worker', now, now],
  );
  await client.exec(
    'INSERT INTO orca_teams (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['team-1', 'lead-session-1', 'active', now, now],
  );
  await client.exec(
    'INSERT INTO orca_workers (id, team_id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['worker-1', 'team-1', 'worker-session-1', now, now],
  );
  await client.exec(
    'INSERT INTO orca_workers (id, team_id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['worker-2', 'team-1', 'worker-session-2', now, now],
  );
}
