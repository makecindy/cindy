import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import * as schema from '../../localDb/schema.js';
import { PluginRegistry } from '../../maker-host/plugins/plugin-registry.js';
import { SettingsReader } from '../../maker-host/plugins/settings-reader.js';
import { MAKER_INVOKE } from '../channels.js';
import { registerProjectPluginPolicyHandlers } from '../projectPluginPolicyHandlers.js';
import { IpcHarness } from './helpers/ipcHarness.js';

/** Lifecycle rows that must remain unchanged after a project policy toggle. */
interface OrcaLifecycleSnapshot {
  sessions: Array<{ id: string; status: string; orca_role: string | null }>;
  teams: Array<{ id: string; status: string; completed_at: number | null }>;
  workers: Array<{ id: string; status: string }>;
}

describe('project plugin policy handlers', () => {
  let currentClient: DbClient | null = null;
  let rawDb: Database.Database | null = null;
  let workingDir: string | null = null;

  afterEach(() => {
    if (currentClient) {
      clearCurrentDbClient(currentClient);
      currentClient = null;
    }
    rawDb?.close();
    rawDb = null;
    if (workingDir) {
      fs.rmSync(workingDir, { recursive: true, force: true });
      workingDir = null;
    }
  });

  it('disables future collab sessions without ending the active team or worker', async () => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-collab-policy-'));
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    await seedActiveCollaboration(client);

    const pluginRegistry = new PluginRegistry({
      settingsReader: new SettingsReader({
        userDataPath: workingDir,
        logger: { warn: () => undefined },
      }),
    });
    const harness = new IpcHarness();
    registerProjectPluginPolicyHandlers(harness, {
      getPluginRegistry: () => pluginRegistry,
    });
    const before = await readLifecycleSnapshot(client);

    await harness.invoke(MAKER_INVOKE.PLUGINS_SET_PROJECT_ENABLED, workingDir, 'collab', false);

    expect(pluginRegistry.isEnabled('collab', workingDir)).toBe(false);
    await expect(readLifecycleSnapshot(client)).resolves.toEqual(before);
    expect(before).toEqual({
      sessions: [
        { id: 'lead-session', status: 'active', orca_role: 'lead' },
        { id: 'worker-session', status: 'active', orca_role: 'worker' },
      ],
      teams: [{ id: 'team-1', status: 'active', completed_at: null }],
      workers: [{ id: 'worker-1', status: 'running' }],
    });
  });

  function createTestDbClient(): DbClient {
    const dbHandle = new Database(':memory:');
    rawDb = dbHandle;
    dbHandle.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        orca_role TEXT
      );
      CREATE TABLE orca_teams (
        id TEXT PRIMARY KEY,
        lead_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        completed_at INTEGER
      );
      CREATE TABLE orca_workers (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle'
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
      dispose: async () => undefined,
    };
    currentClient = client;
    return client;
  }
});

async function seedActiveCollaboration(client: DbClient): Promise<void> {
  await client.exec('INSERT INTO sessions (id, status, orca_role) VALUES (?, ?, ?), (?, ?, ?)', [
    'lead-session',
    'active',
    'lead',
    'worker-session',
    'active',
    'worker',
  ]);
  await client.exec('INSERT INTO orca_teams (id, lead_session_id, status) VALUES (?, ?, ?)', [
    'team-1',
    'lead-session',
    'active',
  ]);
  await client.exec(
    'INSERT INTO orca_workers (id, team_id, session_id, status) VALUES (?, ?, ?, ?)',
    ['worker-1', 'team-1', 'worker-session', 'running'],
  );
}

async function readLifecycleSnapshot(client: DbClient): Promise<OrcaLifecycleSnapshot> {
  return {
    sessions: await client.query('SELECT id, status, orca_role FROM sessions ORDER BY id'),
    teams: await client.query('SELECT id, status, completed_at FROM orca_teams ORDER BY id'),
    workers: await client.query('SELECT id, status FROM orca_workers ORDER BY id'),
  };
}
