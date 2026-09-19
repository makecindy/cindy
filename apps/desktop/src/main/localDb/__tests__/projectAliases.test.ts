import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current.js';
import * as schema from '../schema.js';
import { tx as runDbTx } from '../worker/opHandlers/tx.js';
const send = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
  },
  ipcMain: {
    handle: vi.fn(),
  },
}));

describe('projectAliases localDb helpers', () => {
  let currentClient: DbClient | null = null;
  let rawDb: Database.Database | null = null;

  afterEach(() => {
    send.mockClear();
    if (currentClient) {
      clearCurrentDbClient(currentClient);
      currentClient = null;
    }
    rawDb?.close();
    rawDb = null;
  });

  it('normalizes project keys and trims aliases through the IPC-equivalent path', async () => {
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    const { upsertProjectAlias, listProjectAliases } = await import('../ipc/projectAliases.js');

    const saved = await upsertProjectAlias('local:D:\\repo\\app\\', '  Main App  ');
    const rows = await listProjectAliases();

    expect(saved).toMatchObject({ projectKey: 'local:D:/repo/app', alias: 'Main App' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectKey: 'local:D:/repo/app', alias: 'Main App' });
  });

  it('deletes the alias when the new value is blank', async () => {
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    const { upsertProjectAlias, listProjectAliases } = await import('../ipc/projectAliases.js');

    await upsertProjectAlias('local:/repo/app', 'App');
    await upsertProjectAlias('local:/repo/app', '   ');

    expect(await listProjectAliases()).toEqual([]);
  });

  it('atomically replaces every Unicode Windows casing variant', async () => {
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    rawDb!
      .prepare(
        'INSERT INTO project_aliases (project_key, alias, updated_at) VALUES (?, ?, ?), (?, ?, ?)',
      )
      .run(
        'local:D:/École/Project-A',
        'Newest alias',
        2_000,
        'local:d:/école/project-a',
        'Older alias',
        1_000,
      );
    const { upsertProjectAlias, listProjectAliases } = await import('../ipc/projectAliases.js');

    await upsertProjectAlias('local:D:/ÉCOLE/PROJECT-A', 'Replacement', 'win32');

    expect(await listProjectAliases()).toEqual([
      expect.objectContaining({
        projectKey: 'local:D:/ÉCOLE/PROJECT-A',
        alias: 'Replacement',
      }),
    ]);
  });

  it('clears every Unicode Windows casing variant', async () => {
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    rawDb!
      .prepare(
        'INSERT INTO project_aliases (project_key, alias, updated_at) VALUES (?, ?, ?), (?, ?, ?)',
      )
      .run(
        'local:D:/École/Project-A',
        'Newest alias',
        2_000,
        'local:d:/école/project-a',
        'Older alias',
        1_000,
      );
    const { upsertProjectAlias, listProjectAliases } = await import('../ipc/projectAliases.js');

    await upsertProjectAlias('local:D:/ÉCOLE/PROJECT-A', '', 'win32');

    expect(await listProjectAliases()).toEqual([]);
  });

  it('uses the captured client and checks ownership before writing and broadcasting', async () => {
    const client = createTestDbClient();
    setCurrentDbClient(client, 'test-user');
    const { upsertProjectAlias, listProjectAliases } = await import('../ipc/projectAliases.js');
    const assertCurrent = vi.fn();
    await upsertProjectAlias('local:/repo/app', 'App', process.platform, { client, assertCurrent });
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await listProjectAliases(client)).toEqual([expect.objectContaining({ alias: 'App' })]);
    send.mockClear();
    const stale = () => { throw new Error('owner changed'); };
    await expect(upsertProjectAlias('local:/repo/app', 'Wrong', process.platform, { client, assertCurrent: stale })).rejects.toThrow('owner changed');
    expect((await listProjectAliases(client))[0].alias).toBe('App');
    const changedDuringWrite = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(stale);
    await expect(upsertProjectAlias('local:/repo/app', 'Old account only', process.platform, { client, assertCurrent: changedDuringWrite })).rejects.toThrow('owner changed');
    expect(send).not.toHaveBeenCalled();
  });

  function createTestDbClient(): DbClient {
    const dbHandle = new Database(':memory:');
    rawDb = dbHandle;
    dbHandle.exec(`
      CREATE TABLE project_aliases (
        project_key TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_project_aliases_updated_at ON project_aliases (updated_at);
    `);
    const db = drizzle(dbHandle, { schema });
    const client: DbClient = {
      query: async <T = unknown>(sql: string, params: unknown[] = []) =>
        dbHandle.prepare(sql).all(...params) as T[],
      queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
        dbHandle.prepare(sql).get(...params) as T | undefined,
      exec: async (sql, params = []) => dbHandle.prepare(sql).run(...params),
      tx: (async (name: string, args: unknown) =>
        runDbTx(dbHandle, { name, args })) as DbClient['tx'],
      drizzle: db,
      vecAvailable: false,
      dispose: async () => {},
    };
    currentClient = client;
    return client;
  }
});
