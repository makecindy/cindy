import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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

  it('fails closed before provider dispatch when the durable team is no longer active', async () => {
    const options = await createClientOptions();
    const setup = await trackedClient(options);
    await setup.exec('CREATE TABLE orca_teams (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    await setup.exec("INSERT INTO orca_teams (id, status) VALUES ('team-ended', 'completed')");
    const leaseClient = await trackedLeaseClient(options);
    const coordinator = new OrcaTeamDispatchLeaseCoordinator({
      resolveScope: () => ({ key: 'owner-1', options }),
      createClient: async () => leaseClient,
    });

    await expect(coordinator.acquire('team-ended')).rejects.toThrow(
      'ORCA_TEAM_INACTIVE: team team-ended has already ended',
    );

    await setup.exec("UPDATE orca_teams SET status = 'active' WHERE id = 'team-ended'");
    const release = await coordinator.acquire('team-ended');
    expect(release).toBeTypeOf('function');
    await release();
  });
});
