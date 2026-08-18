import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current.js';
import { tx as runInprocTx } from '../worker/opHandlers/tx.js';
import * as schema from '../schema.js';

const h = vi.hoisted(() => ({
  tapWindowBroadcast: vi.fn(),
  notifyAgentIslandSessionPatch: vi.fn(),
  terminalFenceBegin: vi.fn((teamId: string) => ({ teamId, token: Symbol(teamId) })),
  terminalFenceCommit: vi.fn(),
  terminalFenceRollback: vi.fn(),
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
vi.mock('../../orcaTeamTerminalFence.js', () => ({
  orcaTeamTerminalFence: {
    begin: h.terminalFenceBegin,
    commit: h.terminalFenceCommit,
    rollback: h.terminalFenceRollback,
  },
}));

describe('orcaTeamStore', () => {
  let currentClient: DbClient | null = null;
  let rawDb: Database.Database | null = null;

  afterEach(async () => {
    const { setOrcaDuplicateTeamReconciliationHandler } = await import(
      '../orcaTeamStore.js'
    );
    setOrcaDuplicateTeamReconciliationHandler(null);
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

  it('prepares terminal cleanup before committing the team status', async () => {
    const { markTeamEnded } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    await seedOrcaWorkers(client);
    await client.exec(
      'INSERT INTO messages (id, client_id, session_id, role, agent_meta) VALUES (?, ?, ?, ?, ?)',
      [
        'message-pre-vendor',
        'client-pre-vendor',
        'worker-session-1',
        'user',
        JSON.stringify({ orcaPreVendorCleanup: { teamId: 'team-1', phase: 'pre-vendor' } }),
      ],
    );

    const beforeTerminalCommit = vi.fn(async () => {
      await expect(
        client.queryOne<{ status: string }>(
          'SELECT status FROM orca_teams WHERE id = ?',
          ['team-1'],
        ),
      ).resolves.toEqual({ status: 'active' });
      expect(h.terminalFenceBegin).toHaveBeenCalledWith('team-1');
      expect(h.terminalFenceCommit).not.toHaveBeenCalled();
    });

    await expect(
      markTeamEnded('team-1', 'completed', {
        beforeTerminalCommit,
        terminalCleanupSessionIds: ['lead-session-1', 'worker-session-1'],
      }),
    ).resolves.toEqual([
      { sessionId: 'worker-session-1', clientId: 'client-pre-vendor' },
    ]);

    expect(beforeTerminalCommit).toHaveBeenCalledOnce();
    await expect(
      client.queryOne<{ status: string }>(
        'SELECT status FROM orca_teams WHERE id = ?',
        ['team-1'],
      ),
    ).resolves.toEqual({ status: 'completed' });
    await expect(
      client.queryOne<{ rewindAt: number | null }>(
        'SELECT rewind_at AS rewindAt FROM messages WHERE id = ?',
        ['message-pre-vendor'],
      ),
    ).resolves.toEqual({ rewindAt: expect.any(Number) });
    expect(h.terminalFenceCommit).toHaveBeenCalledOnce();
    expect(h.terminalFenceRollback).not.toHaveBeenCalled();
  });

  it('rolls the final pre-vendor sweep back when the terminal status write fails', async () => {
    const { markTeamEnded } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    await seedOrcaWorkers(client);
    await client.exec(
      'INSERT INTO messages (id, client_id, session_id, role, agent_meta) VALUES (?, ?, ?, ?, ?)',
      [
        'message-rollback',
        'client-rollback',
        'worker-session-1',
        'user',
        JSON.stringify({ orcaPreVendorCleanup: { teamId: 'team-1' } }),
      ],
    );
    rawDb?.exec(`
      CREATE TRIGGER fail_orca_team_terminal_update
      BEFORE UPDATE ON orca_teams
      BEGIN
        SELECT RAISE(ABORT, 'terminal write failed');
      END;
    `);

    await expect(
      markTeamEnded('team-1', 'failed', {
        terminalCleanupSessionIds: ['worker-session-1'],
      }),
    ).rejects.toThrow('terminal write failed');

    await expect(
      client.queryOne<{ status: string }>('SELECT status FROM orca_teams WHERE id = ?', [
        'team-1',
      ]),
    ).resolves.toEqual({ status: 'active' });
    await expect(
      client.queryOne<{ rewindAt: number | null }>(
        'SELECT rewind_at AS rewindAt FROM messages WHERE id = ?',
        ['message-rollback'],
      ),
    ).resolves.toEqual({ rewindAt: null });
    expect(h.terminalFenceRollback).toHaveBeenCalledOnce();
    expect(h.terminalFenceCommit).not.toHaveBeenCalled();
  });

  it('settles prepared cleanup before reopening a failed terminal fence', async () => {
    const { markTeamEnded } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    await seedOrcaWorkers(client);

    const onTerminalCommitFailed = vi.fn(async () => {
      await expect(
        client.queryOne<{ status: string }>(
          'SELECT status FROM orca_teams WHERE id = ?',
          ['team-1'],
        ),
      ).resolves.toEqual({ status: 'active' });
      expect(h.terminalFenceRollback).not.toHaveBeenCalled();
    });

    await expect(
      markTeamEnded('team-1', 'completed', {
        beforeTerminalCommit: async () => {
          throw new Error('cleanup snapshot unavailable');
        },
        onTerminalCommitFailed,
      }),
    ).rejects.toThrow('cleanup snapshot unavailable');

    expect(onTerminalCommitFailed).toHaveBeenCalledOnce();
    expect(h.terminalFenceRollback).toHaveBeenCalledOnce();
    expect(h.terminalFenceCommit).not.toHaveBeenCalled();
  });

  it('fences duplicate active teams before committing read-time reconciliation', async () => {
    const {
      getActiveTeamByLead,
      setOrcaDuplicateTeamReconciliationHandler,
    } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    await seedDuplicateActiveTeams(client);
    const staleTransition = { teamId: 'team-stale', token: Symbol('team-stale') };
    h.terminalFenceBegin.mockReturnValueOnce(staleTransition);
    const reconcileInputs = vi.fn(async () => {});
    setOrcaDuplicateTeamReconciliationHandler(reconcileInputs);

    client.tx = (async (name: string, args: unknown) => {
      expect(name).toBe('orca.cancelStaleTeams');
      expect(args).toMatchObject({
        leadSessionId: 'lead-duplicate',
        staleTeamIds: ['team-stale'],
      });
      expect(h.terminalFenceBegin).toHaveBeenCalledWith('team-stale');
      expect(h.terminalFenceCommit).not.toHaveBeenCalled();
      await client.exec(
        "UPDATE orca_teams SET status = 'cancelled' WHERE lead_session_id = ? AND status = 'active' AND id != ?",
        ['lead-duplicate', 'team-latest'],
      );
    }) as DbClient['tx'];

    await expect(getActiveTeamByLead('lead-duplicate')).resolves.toMatchObject({
      id: 'team-latest',
    });
    expect(h.terminalFenceCommit).toHaveBeenCalledWith(staleTransition);
    expect(h.terminalFenceRollback).not.toHaveBeenCalled();
    expect(reconcileInputs).toHaveBeenNthCalledWith(
      1,
      {
        leadSessionId: 'lead-duplicate',
        keptTeamId: 'team-latest',
        staleTeamIds: ['team-stale'],
        staleWorkerSessionIds: ['worker-stale-session'],
      },
      'prepare',
    );
    expect(reconcileInputs).toHaveBeenNthCalledWith(
      2,
      {
        leadSessionId: 'lead-duplicate',
        keptTeamId: 'team-latest',
        staleTeamIds: ['team-stale'],
        staleWorkerSessionIds: ['worker-stale-session'],
      },
      'cleanup',
    );
  });

  it('does not cancel an active team inserted after duplicate reconciliation is captured', async () => {
    const { getActiveTeamByLead } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    await seedDuplicateActiveTeams(client);
    const originalTx = client.tx.bind(client);
    client.tx = (async (name: string, args: unknown) => {
      const now = Date.now() + 1;
      await client.exec(
        'INSERT INTO orca_teams (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ['team-concurrent', 'lead-duplicate', 'active', now, now],
      );
      return originalTx(name, args);
    }) as DbClient['tx'];

    await expect(getActiveTeamByLead('lead-duplicate')).resolves.toMatchObject({
      id: 'team-latest',
    });

    expect(
      await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM orca_teams ORDER BY id',
      ),
    ).toEqual([
      { id: 'team-concurrent', status: 'active' },
      { id: 'team-latest', status: 'active' },
      { id: 'team-stale', status: 'cancelled' },
    ]);
    expect(h.terminalFenceBegin).toHaveBeenCalledTimes(1);
    expect(h.terminalFenceBegin).toHaveBeenCalledWith('team-stale');
  });

  it('rolls back duplicate-team fences when reconciliation persistence fails', async () => {
    const {
      getActiveTeamByLead,
      setOrcaDuplicateTeamReconciliationHandler,
    } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    await seedDuplicateActiveTeams(client);
    const staleTransition = { teamId: 'team-stale', token: Symbol('team-stale') };
    h.terminalFenceBegin.mockReturnValueOnce(staleTransition);
    const reconcileInputs = vi.fn(async () => {});
    setOrcaDuplicateTeamReconciliationHandler(reconcileInputs);
    client.tx = (async () => {
      throw new Error('cancel stale teams failed');
    }) as DbClient['tx'];

    await expect(getActiveTeamByLead('lead-duplicate')).rejects.toThrow(
      'cancel stale teams failed',
    );
    expect(h.terminalFenceRollback).toHaveBeenCalledWith(staleTransition);
    expect(h.terminalFenceCommit).not.toHaveBeenCalled();
    expect(reconcileInputs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ staleTeamIds: ['team-stale'] }),
      'prepare',
    );
    expect(reconcileInputs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ staleTeamIds: ['team-stale'] }),
      'rollback',
    );
  });

  it('retries committed duplicate-team cleanup from persisted cancelled rows', async () => {
    const {
      getActiveTeamByLead,
      setOrcaDuplicateTeamReconciliationHandler,
    } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    await seedDuplicateActiveTeams(client);
    await client.exec(
      'INSERT INTO orca_teams (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['team-stale-2', 'lead-duplicate', 'active', 0, 0],
    );
    await client.exec(
      'INSERT INTO sessions (id, title, agent_kind, orca_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['worker-stale-session-2', 'Stale Worker 2', 'codex', 'worker', 0, 0],
    );
    await client.exec(
      'INSERT INTO orca_workers (id, team_id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['worker-stale-2', 'team-stale-2', 'worker-stale-session-2', 0, 0],
    );
    let cleanupAttempts = 0;
    const reconcileInputs = vi.fn(async (
      _reconciliation: unknown,
      phase: 'prepare' | 'cleanup' | 'rollback',
    ) => {
      if (phase === 'cleanup' && cleanupAttempts++ === 0) {
        throw new Error('cleanup database busy');
      }
    });
    setOrcaDuplicateTeamReconciliationHandler(reconcileInputs);

    await expect(getActiveTeamByLead('lead-duplicate')).rejects.toThrow(
      'cleanup database busy',
    );
    expect(
      await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM orca_teams ORDER BY id',
      ),
    ).toEqual([
      { id: 'team-latest', status: 'active' },
      { id: 'team-stale', status: 'cancelled' },
      { id: 'team-stale-2', status: 'cancelled' },
    ]);

    await expect(getActiveTeamByLead('lead-duplicate')).resolves.toMatchObject({
      id: 'team-latest',
    });
    expect(reconcileInputs).toHaveBeenCalledTimes(3);
    expect(reconcileInputs).toHaveBeenLastCalledWith(
      {
        leadSessionId: 'lead-duplicate',
        keptTeamId: 'team-latest',
        staleTeamIds: ['team-stale', 'team-stale-2'],
        staleWorkerSessionIds: ['worker-stale-session', 'worker-stale-session-2'],
      },
      'cleanup',
    );
  });

  it('replays persisted terminal cleanup when no active team remains', async () => {
    const {
      getActiveTeamByLead,
      setOrcaDuplicateTeamReconciliationHandler,
    } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    await seedDuplicateActiveTeams(client);
    await client.exec(
      "UPDATE orca_teams SET status = 'completed', completed_at = 10, updated_at = 10",
    );
    const reconcileInputs = vi.fn()
      .mockRejectedValueOnce(new Error('terminal cleanup interrupted'))
      .mockResolvedValueOnce(undefined);
    setOrcaDuplicateTeamReconciliationHandler(reconcileInputs);

    await expect(getActiveTeamByLead('lead-duplicate')).rejects.toThrow(
      'terminal cleanup interrupted',
    );
    await expect(getActiveTeamByLead('lead-duplicate')).resolves.toBeNull();

    expect(reconcileInputs).toHaveBeenCalledTimes(2);
    expect(reconcileInputs).toHaveBeenLastCalledWith(
      {
        leadSessionId: 'lead-duplicate',
        keptTeamId: null,
        staleTeamIds: ['team-latest', 'team-stale'],
        staleWorkerSessionIds: ['worker-stale-session'],
      },
      'cleanup',
    );
  });

  it('does not commit duplicate-team cancellation when cleanup scope lookup fails', async () => {
    const { getActiveTeamByLead } = await import('../orcaTeamStore.js');
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    await seedDuplicateActiveTeams(client);
    await client.exec('DROP TABLE orca_workers');
    const txSpy = vi.fn(client.tx);
    client.tx = txSpy as DbClient['tx'];

    await expect(getActiveTeamByLead('lead-duplicate')).rejects.toThrow(/orca_workers/);

    expect(txSpy).not.toHaveBeenCalled();
    expect(h.terminalFenceBegin).not.toHaveBeenCalled();
    expect(
      await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM orca_teams ORDER BY id',
      ),
    ).toEqual([
      { id: 'team-latest', status: 'active' },
      { id: 'team-stale', status: 'active' },
    ]);
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

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        agent_meta TEXT,
        rewind_at INTEGER
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

async function seedDuplicateActiveTeams(client: DbClient): Promise<void> {
  await client.exec(
    'INSERT INTO sessions (id, title, agent_kind, orca_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['lead-duplicate', 'Duplicate Lead', 'codex', 'lead', 1, 2],
  );
  await client.exec(
    'INSERT INTO orca_teams (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['team-stale', 'lead-duplicate', 'active', 1, 1],
  );
  await client.exec(
    'INSERT INTO orca_teams (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['team-latest', 'lead-duplicate', 'active', 2, 2],
  );
  await client.exec(
    'INSERT INTO sessions (id, title, agent_kind, orca_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['worker-stale-session', 'Stale Worker', 'codex', 'worker', 1, 1],
  );
  await client.exec(
    'INSERT INTO orca_workers (id, team_id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['worker-stale', 'team-stale', 'worker-stale-session', 1, 1],
  );
}
