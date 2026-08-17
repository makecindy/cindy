import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkerDbClient, type DbClient } from '../localDb/client/DbClient.js';
import {
  createIsolatedSqliteClient,
  type IsolatedSqliteClient,
} from '../localDb/client/IsolatedSqliteClient.js';
import { OrcaTeamDispatchLeaseCoordinator } from '../orcaTeamDispatchLease.js';

describe('OrcaTeamDispatchLeaseCoordinator', () => {
  const disposables: Array<Pick<DbClient, 'dispose'>> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(disposables.splice(0).map((client) => client.dispose()));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createClientOptions(): Promise<{
    dbPath: string;
    drizzleDir: string;
    useInlineWorker: true;
  }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-orca-dispatch-lease-'));
    const drizzleDir = path.join(root, 'drizzle');
    await mkdir(drizzleDir);
    tempDirs.push(root);
    return { dbPath: path.join(root, 'test.db'), drizzleDir, useInlineWorker: true };
  }

  async function trackedClient(options: Awaited<ReturnType<typeof createClientOptions>>): Promise<DbClient> {
    const client = await createWorkerDbClient(options);
    disposables.push(client);
    return client;
  }

  async function trackedLeaseClient(
    options: Awaited<ReturnType<typeof createClientOptions>>,
  ): Promise<IsolatedSqliteClient> {
    const client = await createIsolatedSqliteClient(options);
    disposables.push(client);
    return client;
  }

  it('blocks a legacy terminal UPDATE until provider dispatch releases the SQLite lease', async () => {
    const options = await createClientOptions();
    const setup = await trackedClient(options);
    await setup.exec('CREATE TABLE orca_teams (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    await setup.exec("INSERT INTO orca_teams (id, status) VALUES ('team-1', 'active')");

    const leaseClient = await trackedLeaseClient(options);
    const legacyClient = await trackedClient(options);
    const coordinator = new OrcaTeamDispatchLeaseCoordinator({
      resolveScope: () => ({ key: 'owner-1', options }),
      createClient: async () => leaseClient,
      getTerminalFenceState: () => 'open',
    });

    const release = await coordinator.acquire('team-1');
    let legacyWriteSettled = false;
    const legacyTerminalWrite = legacyClient
      .exec("UPDATE orca_teams SET status = 'completed' WHERE id = 'team-1'")
      .then(() => {
        legacyWriteSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(legacyWriteSettled).toBe(false);

    await release();
    await legacyTerminalWrite;
    expect(
      await legacyClient.queryOne<{ status: string }>(
        'SELECT status FROM orca_teams WHERE id = ?',
        ['team-1'],
      ),
    ).toEqual({ status: 'completed' });
  });

  it('durably rewinds a confirmed-undispatched row before a terminal writer can commit', async () => {
    const options = await createClientOptions();
    const setup = await trackedClient(options);
    await setup.exec('CREATE TABLE orca_teams (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    await setup.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        role TEXT NOT NULL,
        agent_meta TEXT,
        rewind_at INTEGER
      )
    `);
    await setup.exec("INSERT INTO orca_teams (id, status) VALUES ('team-failed', 'active')");
    await setup.exec(`
      INSERT INTO messages (id, session_id, client_id, role, agent_meta, rewind_at)
      VALUES (
        'row-failed', 'session-1', 'client-failed', 'user',
        '{"orcaPreVendorCleanup":{"teamId":"team-failed"}}', NULL
      )
    `);

    const leaseClient = await trackedLeaseClient(options);
    const terminalClient = await trackedClient(options);
    const coordinator = new OrcaTeamDispatchLeaseCoordinator({
      resolveScope: () => ({ key: 'owner-1', options }),
      createClient: async () => leaseClient,
      getTerminalFenceState: () => 'open',
    });

    const release = await coordinator.acquire('team-failed', {
      sessionId: 'session-1',
      clientId: 'client-failed',
    });
    let terminalSettled = false;
    const terminalWrite = terminalClient
      .exec("UPDATE orca_teams SET status = 'completed' WHERE id = 'team-failed'")
      .then(() => {
        terminalSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(terminalSettled).toBe(false);

    await release('confirmed-undispatched');
    await terminalWrite;

    expect(
      await terminalClient.queryOne<{ rewindAt: number | null }>(
        'SELECT rewind_at AS rewindAt FROM messages WHERE id = ?',
        ['row-failed'],
      ),
    ).toEqual({ rewindAt: expect.any(Number) });
    expect(terminalSettled).toBe(true);
  });

  it('persists submitted state until provider acceptance clears the marker', async () => {
    const options = await createClientOptions();
    const setup = await trackedClient(options);
    await setup.exec('CREATE TABLE orca_teams (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    await setup.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        role TEXT NOT NULL,
        agent_meta TEXT,
        rewind_at INTEGER
      )
    `);
    await setup.exec("INSERT INTO orca_teams (id, status) VALUES ('team-sent', 'active')");
    await setup.exec(`
      INSERT INTO messages (id, session_id, client_id, role, agent_meta, rewind_at)
      VALUES (
        'row-sent', 'session-1', 'client-sent', 'user',
        '{"uuid":"u1","orcaPreVendorCleanup":{"teamId":"team-sent"}}', NULL
      )
    `);
    const leaseClient = await trackedLeaseClient(options);
    const coordinator = new OrcaTeamDispatchLeaseCoordinator({
      resolveScope: () => ({ key: 'owner-1', options }),
      createClient: async () => leaseClient,
      getTerminalFenceState: () => 'open',
    });

    const release = await coordinator.acquire('team-sent', {
      sessionId: 'session-1',
      clientId: 'client-sent',
    });
    await release('submitted');

    expect(await setup.queryOne(
      `SELECT rewind_at AS rewindAt,
              json_extract(agent_meta, '$.orcaPreVendorCleanup.teamId') AS teamId,
              json_extract(agent_meta, '$.orcaPreVendorCleanup.phase') AS phase,
              json_extract(agent_meta, '$.uuid') AS uuid
         FROM messages WHERE id = 'row-sent'`,
    )).toEqual({ rewindAt: null, teamId: 'team-sent', phase: 'submitted', uuid: 'u1' });

    await expect(coordinator.acquire('team-sent', {
      sessionId: 'session-1',
      clientId: 'client-sent',
    })).rejects.toMatchObject({
      code: 'TURN_DISPATCH_UNCONFIRMED',
      message: expect.stringContaining('ORCA_MESSAGE_ALREADY_SUBMITTED'),
    });

    const retryRelease = await coordinator.acquire('team-sent', {
      sessionId: 'session-1',
      clientId: 'client-sent',
    }, 'retry-after-confirmed-rejection');
    await retryRelease('submitted');
    await retryRelease('accepted');

    expect(await setup.queryOne(
      `SELECT rewind_at AS rewindAt,
              json_extract(agent_meta, '$.orcaPreVendorCleanup.teamId') AS teamId,
              json_extract(agent_meta, '$.uuid') AS uuid
         FROM messages WHERE id = 'row-sent'`,
    )).toEqual({ rewindAt: null, teamId: null, uuid: 'u1' });
  });

  it('tombstones a submitted row when the provider later explicitly rejects it', async () => {
    const options = await createClientOptions();
    const setup = await trackedClient(options);
    await setup.exec('CREATE TABLE orca_teams (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    await setup.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        role TEXT NOT NULL,
        agent_meta TEXT,
        rewind_at INTEGER
      )
    `);
    await setup.exec("INSERT INTO orca_teams (id, status) VALUES ('team-rejected', 'active')");
    await setup.exec(`
      INSERT INTO messages (id, session_id, client_id, role, agent_meta, rewind_at)
      VALUES (
        'row-rejected', 'session-1', 'client-rejected', 'user',
        '{"orcaPreVendorCleanup":{"teamId":"team-rejected"}}', NULL
      )
    `);
    const leaseClient = await trackedLeaseClient(options);
    const coordinator = new OrcaTeamDispatchLeaseCoordinator({
      resolveScope: () => ({ key: 'owner-1', options }),
      createClient: async () => leaseClient,
      getTerminalFenceState: () => 'open',
    });

    const release = await coordinator.acquire('team-rejected', {
      sessionId: 'session-1',
      clientId: 'client-rejected',
    });
    await release('submitted');
    await release('confirmed-undispatched');

    expect(await setup.queryOne(
      `SELECT rewind_at AS rewindAt,
              json_extract(agent_meta, '$.orcaPreVendorCleanup.phase') AS phase
         FROM messages WHERE id = 'row-rejected'`,
    )).toEqual({ rewindAt: expect.any(Number), phase: 'submitted' });
  });

  it('retries the whole submitted-row settlement before surfacing a cleanup failure', async () => {
    const options = await createClientOptions();
    const transient = new Error('isolated client write failed once');
    let tombstoneAttempts = 0;
    const client: IsolatedSqliteClient = {
      queryOne: async <T = unknown>(sql: string): Promise<T | undefined> => {
        if (sql.includes('SELECT status FROM orca_teams')) {
          return { status: 'active' } as T;
        }
        if (sql.includes("json_extract(agent_meta, '$.orcaPreVendorCleanup.teamId')")) {
          return { teamId: 'team-settle-retry', phase: 'pre-vendor' } as T;
        }
        return { ok: 1 } as T;
      },
      exec: vi.fn(async (sql: string) => {
        if (sql.includes('SET rewind_at = ?')) {
          tombstoneAttempts += 1;
          if (tombstoneAttempts === 1) throw transient;
        }
        return { changes: 1, lastInsertRowid: 0 };
      }),
      dispose: vi.fn(async () => {}),
    };
    const coordinator = new OrcaTeamDispatchLeaseCoordinator({
      resolveScope: () => ({ key: 'owner-1', options }),
      createClient: async () => client,
      getTerminalFenceState: () => 'open',
    });

    const release = await coordinator.acquire('team-settle-retry', {
      sessionId: 'session-1',
      clientId: 'client-settle-retry',
    });
    await release('submitted');
    await release('confirmed-undispatched');

    expect(tombstoneAttempts).toBe(2);
    expect(client.exec).toHaveBeenCalledWith('ROLLBACK');
  });

  it('retries transient SQLite contention while committing submitted state', async () => {
    const options = await createClientOptions();
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    let markerAttempts = 0;
    let commitAttempts = 0;
    const client: IsolatedSqliteClient = {
      queryOne: async <T = unknown>(sql: string): Promise<T | undefined> => {
        if (sql.includes('SELECT status FROM orca_teams')) {
          return { status: 'active' } as T;
        }
        if (sql.includes("json_extract(agent_meta, '$.orcaPreVendorCleanup.teamId')")) {
          return { teamId: 'team-retry' } as T;
        }
        return { ok: 1 } as T;
      },
      exec: vi.fn(async (sql: string) => {
        if (sql.includes("SET agent_meta = json_set")) {
          markerAttempts += 1;
          if (markerAttempts === 1) throw busy;
        }
        if (sql === 'COMMIT') {
          commitAttempts += 1;
          if (commitAttempts === 1) throw busy;
        }
        return { changes: 1, lastInsertRowid: 0 };
      }),
      dispose: vi.fn(async () => {}),
    };
    const coordinator = new OrcaTeamDispatchLeaseCoordinator({
      resolveScope: () => ({ key: 'owner-1', options }),
      createClient: async () => client,
      getTerminalFenceState: () => 'open',
    });

    const release = await coordinator.acquire('team-retry', {
      sessionId: 'session-1',
      clientId: 'client-retry',
    });
    await release('submitted');

    expect(markerAttempts).toBe(2);
    expect(commitAttempts).toBe(2);
  });

  it('tombstones a marked row when another instance already ended the team', async () => {
    const options = await createClientOptions();
    const setup = await trackedClient(options);
    await setup.exec('CREATE TABLE orca_teams (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    await setup.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        role TEXT NOT NULL,
        agent_meta TEXT,
        rewind_at INTEGER
      )
    `);
    await setup.exec("INSERT INTO orca_teams (id, status) VALUES ('team-ended', 'completed')");
    await setup.exec(`
      INSERT INTO messages (id, session_id, client_id, role, agent_meta, rewind_at)
      VALUES (
        'row-late', 'session-1', 'client-late', 'user',
        '{"orcaPreVendorCleanup":{"teamId":"team-ended"}}', NULL
      )
    `);
    const leaseClient = await trackedLeaseClient(options);
    const coordinator = new OrcaTeamDispatchLeaseCoordinator({
      resolveScope: () => ({ key: 'owner-1', options }),
      createClient: async () => leaseClient,
      getTerminalFenceState: () => 'open',
    });

    await expect(coordinator.acquire('team-ended', {
      sessionId: 'session-1',
      clientId: 'client-late',
    })).rejects.toThrow('ORCA_TEAM_INACTIVE: team team-ended has already ended');
    expect(await setup.queryOne(
      'SELECT rewind_at AS rewindAt FROM messages WHERE id = ?',
      ['row-late'],
    )).toEqual({ rewindAt: expect.any(Number) });
  });

  it('tombstones a marked row when the local terminal fence already won', async () => {
    const options = await createClientOptions();
    const setup = await trackedClient(options);
    await setup.exec('CREATE TABLE orca_teams (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    await setup.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        role TEXT NOT NULL,
        agent_meta TEXT,
        rewind_at INTEGER
      )
    `);
    await setup.exec("INSERT INTO orca_teams (id, status) VALUES ('team-local-ended', 'active')");
    await setup.exec(`
      INSERT INTO messages (id, session_id, client_id, role, agent_meta, rewind_at)
      VALUES (
        'row-local-late', 'session-1', 'client-local-late', 'user',
        '{"orcaPreVendorCleanup":{"teamId":"team-local-ended"}}', NULL
      )
    `);
    const leaseClient = await trackedLeaseClient(options);
    const coordinator = new OrcaTeamDispatchLeaseCoordinator({
      resolveScope: () => ({ key: 'owner-1', options }),
      createClient: async () => leaseClient,
      getTerminalFenceState: () => 'terminal',
    });

    await expect(coordinator.acquire('team-local-ended', {
      sessionId: 'session-1',
      clientId: 'client-local-late',
    })).rejects.toThrow('ORCA_TEAM_INACTIVE: team team-local-ended has already ended');
    expect(await setup.queryOne(
      'SELECT rewind_at AS rewindAt FROM messages WHERE id = ?',
      ['row-local-late'],
    )).toEqual({ rewindAt: expect.any(Number) });
  });

  it('fails closed before provider dispatch when the durable team is no longer active', async () => {
    const options = await createClientOptions();
    const setup = await trackedClient(options);
    await setup.exec('CREATE TABLE orca_teams (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    await setup.exec("INSERT INTO orca_teams (id, status) VALUES ('team-ended', 'completed')");
    const leaseClient = await trackedLeaseClient(options);
    const coordinator = new OrcaTeamDispatchLeaseCoordinator({
      resolveScope: () => ({ key: 'owner-1', options }),
      createClient: async () => leaseClient,
      getTerminalFenceState: () => 'open',
    });

    await expect(coordinator.acquire('team-ended')).rejects.toThrow(
      'ORCA_TEAM_INACTIVE: team team-ended has already ended',
    );

    await setup.exec("UPDATE orca_teams SET status = 'active' WHERE id = 'team-ended'");
    const release = await coordinator.acquire('team-ended');
    expect(release).toBeTypeOf('function');
    await release();
  });

  it('rejects a locally pending terminal transition after the durable active check', async () => {
    const options = await createClientOptions();
    const setup = await trackedClient(options);
    await setup.exec('CREATE TABLE orca_teams (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    await setup.exec("INSERT INTO orca_teams (id, status) VALUES ('team-pending', 'active')");
    const leaseClient = await trackedLeaseClient(options);
    const getTerminalFenceState = vi.fn<() => 'open' | 'pending' | 'terminal'>(
      () => 'pending',
    );
    const coordinator = new OrcaTeamDispatchLeaseCoordinator({
      resolveScope: () => ({ key: 'owner-1', options }),
      createClient: async () => leaseClient,
      getTerminalFenceState,
    });

    await expect(coordinator.acquire('team-pending')).rejects.toThrow(
      'ORCA_TEAM_TERMINATING: team team-pending terminal transition is still pending',
    );
    expect(getTerminalFenceState).toHaveBeenCalledWith('team-pending');

    getTerminalFenceState.mockReturnValue('open');
    const release = await coordinator.acquire('team-pending');
    await release();
  });
});
