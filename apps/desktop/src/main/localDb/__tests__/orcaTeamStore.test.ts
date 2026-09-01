import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current.js';
import { tx as runInprocTx } from '../worker/opHandlers/tx.js';
import { setSessionRouteLockImplementation } from '../sessionRouteLock.js';
import { setSessionRuntimeCleanup } from '../sessionRuntimeCleanup.js';
import * as schema from '../schema.js';

const h = vi.hoisted(() => ({
  tapWindowBroadcast: vi.fn(),
  notifyAgentIslandSessionPatch: vi.fn(),
  runtimeCleanup: vi.fn(),
  compactSessionToolResultsBestEffort: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: h.tapWindowBroadcast,
}));
vi.mock('../agentIslandSessionPatch.js', () => ({
  notifyAgentIslandSessionPatch: h.notifyAgentIslandSessionPatch,
}));
vi.mock('../toolResultCompaction.js', () => ({
  compactSessionToolResultsBestEffort: h.compactSessionToolResultsBestEffort,
}));

describe('orcaTeamStore', () => {
  let currentClient: DbClient | null = null;
  let rawDb: Database.Database | null = null;

  beforeEach(() => {
    setSessionRuntimeCleanup(h.runtimeCleanup);
    setSessionRouteLockImplementation(null);
  });

  afterEach(async () => {
    setSessionRuntimeCleanup(null);
    setSessionRouteLockImplementation(null);
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
    expect(h.runtimeCleanup).toHaveBeenCalledTimes(2);
    expect(h.runtimeCleanup).toHaveBeenCalledWith('worker-session-1');
    expect(h.runtimeCleanup).toHaveBeenCalledWith('worker-session-2');
    expect(h.compactSessionToolResultsBestEffort).toHaveBeenCalledTimes(2);
    expect(h.compactSessionToolResultsBestEffort).toHaveBeenCalledWith({
      client,
      sessionId: 'worker-session-1',
    });
    expect(h.compactSessionToolResultsBestEffort).toHaveBeenCalledWith({
      client,
      sessionId: 'worker-session-2',
    });
  });

  it('never archives or broadcasts a worker task that is already deleted', async () => {
    const { archiveWorkersByTeam } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');

    await seedOrcaWorkers(client);
    await client.exec('UPDATE sessions SET status = ? WHERE id = ?', [
      'deleted',
      'worker-session-2',
    ]);

    await expect(archiveWorkersByTeam('team-1')).resolves.toEqual(['worker-session-1']);
    await expect(
      client.queryOne<{ status: string }>('SELECT status FROM sessions WHERE id = ?', [
        'worker-session-2',
      ]),
    ).resolves.toEqual({ status: 'deleted' });
    expect(h.tapWindowBroadcast).not.toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'worker-session-2',
      patch: { status: 'archived' },
    });
    expect(h.runtimeCleanup).not.toHaveBeenCalledWith('worker-session-2');
    expect(h.compactSessionToolResultsBestEffort).toHaveBeenCalledTimes(1);
  });

  it('reconciles only still-active workers from inactive teams', async () => {
    const { reconcileInactiveTeamWorkersForLead } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');

    await seedOrcaWorkers(client);
    await client.exec('UPDATE orca_teams SET status = ? WHERE id = ?', ['completed', 'team-1']);
    await client.exec('UPDATE sessions SET status = ? WHERE id = ?', [
      'deleted',
      'worker-session-2',
    ]);

    await expect(reconcileInactiveTeamWorkersForLead('lead-session-1')).resolves.toEqual([
      'worker-session-1',
    ]);
    await expect(
      client.query<{ id: string; status: string }>(
        'SELECT id, status FROM sessions WHERE id IN (?, ?) ORDER BY id',
        ['worker-session-1', 'worker-session-2'],
      ),
    ).resolves.toEqual([
      { id: 'worker-session-1', status: 'archived' },
      { id: 'worker-session-2', status: 'deleted' },
    ]);
    expect(h.runtimeCleanup).toHaveBeenCalledTimes(1);
    expect(h.runtimeCleanup).toHaveBeenCalledWith('worker-session-1');
    expect(h.compactSessionToolResultsBestEffort).toHaveBeenCalledWith({
      client,
      sessionId: 'worker-session-1',
    });
  });

  it('cleans archived worker runtime state before releasing route locks and broadcasting', async () => {
    const { archiveWorkersByTeam } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    await seedOrcaWorkers(client);

    const events: string[] = [];
    setSessionRuntimeCleanup((sessionId) => events.push(`cleanup:${sessionId}`));
    setSessionRouteLockImplementation(async (sessionId, task) => {
      events.push(`lock:${sessionId}:start`);
      const result = await task();
      events.push(`lock:${sessionId}:end`);
      return result;
    });
    h.tapWindowBroadcast.mockImplementation(() => {
      events.push('broadcast');
    });

    await archiveWorkersByTeam('team-1');

    expect(events).toEqual([
      'lock:worker-session-1:start',
      'lock:worker-session-2:start',
      'cleanup:worker-session-1',
      'cleanup:worker-session-2',
      'lock:worker-session-2:end',
      'lock:worker-session-1:end',
      'broadcast',
      'broadcast',
    ]);
  });

  it('cleans runtime state when a single worker is archived and skips deleted workers', async () => {
    const { archiveSingleWorkerSession } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    await seedOrcaWorkers(client);

    await archiveSingleWorkerSession('worker-session-1');
    expect(h.runtimeCleanup).toHaveBeenCalledWith('worker-session-1');
    expect(h.compactSessionToolResultsBestEffort).toHaveBeenCalledWith({
      client,
      sessionId: 'worker-session-1',
    });

    h.runtimeCleanup.mockClear();
    h.compactSessionToolResultsBestEffort.mockClear();
    await client.exec('UPDATE sessions SET status = ? WHERE id = ?', [
      'deleted',
      'worker-session-2',
    ]);
    await archiveSingleWorkerSession('worker-session-2');
    expect(h.runtimeCleanup).not.toHaveBeenCalled();
    expect(h.compactSessionToolResultsBestEffort).not.toHaveBeenCalled();
  });

  it('compacts a worker task after removeWorker archives it', async () => {
    const { removeWorker } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    await seedOrcaWorkers(client);

    await removeWorker('worker-1');

    expect(h.compactSessionToolResultsBestEffort).toHaveBeenCalledWith({
      client,
      sessionId: 'worker-session-1',
    });
  });

  it('preserves Pi worker identity in Orca projections', async () => {
    const { listWorkersByLead } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');

    await seedOrcaWorkers(client);
    const workers = await listWorkersByLead('lead-session-1');

    expect(
      workers.find((worker) => worker.sessionId === 'worker-session-2')?.session.agentKind,
    ).toBe('pi');
  });

  it('returns complete active worker projections grouped by lead in one batch', async () => {
    const { listWorkersByLeads } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');

    await seedOrcaWorkers(client);
    const now = Date.now();
    await client.exec(
      'INSERT INTO sessions (id, title, agent_kind, orca_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['lead-session-2', 'Lead 2', 'codex', 'lead', now, now],
    );
    await client.exec(
      'INSERT INTO sessions (id, title, agent_kind, orca_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['worker-session-3', 'Worker 3', 'claude-code', 'worker', now, now],
    );
    await client.exec(
      'INSERT INTO orca_teams (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['team-2', 'lead-session-2', 'active', now, now],
    );
    await client.exec(
      'INSERT INTO orca_workers (id, team_id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['worker-3', 'team-2', 'worker-session-3', now, now],
    );

    const grouped = await listWorkersByLeads(['lead-session-1', 'lead-session-2', 'lead-empty']);

    expect(grouped['lead-session-1'].map((worker) => worker.id).sort()).toEqual([
      'worker-1',
      'worker-2',
    ]);
    expect(grouped['lead-session-2'].map((worker) => worker.id)).toEqual(['worker-3']);
    expect(grouped['lead-empty']).toEqual([]);
  });

  it('executes worker status CAS updates and only rolls back idle acknowledgements', async () => {
    const { markWorkerIdleIfStatus, restoreWorkerDoneIfIdle } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');

    await seedOrcaWorkers(client);
    await client.exec('UPDATE orca_workers SET status = ? WHERE id = ?', ['done', 'worker-1']);

    await expect(markWorkerIdleIfStatus('worker-1', 'done')).resolves.toBe(true);
    await expect(markWorkerIdleIfStatus('worker-1', 'done')).resolves.toBe(false);
    await expect(restoreWorkerDoneIfIdle('worker-1')).resolves.toBe(true);
    await expect(restoreWorkerDoneIfIdle('worker-1')).resolves.toBe(false);
    await client.exec('UPDATE orca_workers SET status = ? WHERE id = ?', ['running', 'worker-2']);
    await expect(restoreWorkerDoneIfIdle('worker-2')).resolves.toBe(false);

    await expect(
      client.query<{ id: string; status: string; idle_since: number | null }>(
        'SELECT id, status, idle_since FROM orca_workers ORDER BY id',
      ),
    ).resolves.toEqual([
      { id: 'worker-1', status: 'done', idle_since: null },
      { id: 'worker-2', status: 'running', idle_since: null },
    ]);
  });

  it('isOrphanedTeamInit:零 worker 且无存活 reservation 判孤儿;活租约或任意 worker 行则不判 (#3555)', async () => {
    const { isOrphanedTeamInit } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    const now = Date.now();
    // 年龄地板(review 反馈):刚创建的 team 可能仍在别处初始化,不判孤儿。
    const staleCreatedAt = now - 120_000;
    await client.exec(
      'INSERT INTO orca_teams (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['team-young', 'lead-1', 'active', now, now],
    );
    await expect(isOrphanedTeamInit('team-young')).resolves.toBe(false);
    await client.exec(
      'INSERT INTO orca_teams (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['team-orphan', 'lead-1', 'active', staleCreatedAt, staleCreatedAt],
    );
    await expect(isOrphanedTeamInit('team-orphan')).resolves.toBe(true);

    await client.exec(
      'INSERT INTO orca_worker_creation_reservations (id, team_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      ['resv-1', 'team-orphan', 'dev', now, now + 60_000],
    );
    await expect(isOrphanedTeamInit('team-orphan')).resolves.toBe(false);
    await client.exec(
      'UPDATE orca_worker_creation_reservations SET expires_at = ? WHERE id = ?',
      [now - 1, 'resv-1'],
    );
    await expect(isOrphanedTeamInit('team-orphan')).resolves.toBe(true);

    await client.exec(
      'INSERT INTO sessions (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ['ws-1', 'archived', now, now],
    );
    await client.exec(
      'INSERT INTO orca_workers (id, team_id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['worker-1', 'team-orphan', 'ws-1', now, now],
    );
    await expect(isOrphanedTeamInit('team-orphan')).resolves.toBe(false);
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
        codex_plan_json TEXT,
        extra_dirs TEXT NOT NULL DEFAULT '[]',
        remote_host_id TEXT,
        provider_id TEXT,
        active_turn_started_at INTEGER,
        active_turn_pid INTEGER,
        last_turn_ended_at INTEGER,
        list_preview TEXT,
        list_preview_role TEXT,
        list_message_count INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE orca_worker_creation_reservations (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
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
      tx: (async (name: string, args: unknown) =>
        runInprocTx(dbHandle, { name, args })) as DbClient['tx'],
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
    ['worker-session-2', 'Worker 2', 'pi', 'worker', now, now],
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
