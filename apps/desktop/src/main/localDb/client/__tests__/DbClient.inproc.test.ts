import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app.getPath(${name})`);
      const dir = process.env.XDT_INPROC_TEST_USER_DATA;
      if (!dir) throw new Error('XDT_INPROC_TEST_USER_DATA is not set');
      return dir;
    },
    isPackaged: true,
    exit: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  dialog: {
    showMessageBoxSync: vi.fn(),
  },
}));

const INIT_SQL = `
CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE migration_history (
  seq INTEGER PRIMARY KEY,
  file_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
CREATE TABLE embedding_jobs (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  model_id TEXT NOT NULL,
  vec_table TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  scheduled_at INTEGER NOT NULL,
  locked_at INTEGER,
  UNIQUE(source, source_id, chunk_index, model_id)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  status TEXT,
  working_dir TEXT,
  worktree_path TEXT,
  source TEXT NOT NULL DEFAULT 'desktop',
  remote_host_id TEXT
);
`;

describe('DbClient in-proc fallback', () => {
  let previousResourcesPath: string | undefined;

  afterEach(async () => {
    const { closeDb } = await import('../../index.js');
    closeDb();
    if (previousResourcesPath === undefined) {
      Reflect.deleteProperty(process, 'resourcesPath');
    } else {
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: previousResourcesPath,
      });
    }
    previousResourcesPath = undefined;
    delete process.env.XDT_DB_INPROC;
    const userDataDir = process.env.XDT_INPROC_TEST_USER_DATA;
    delete process.env.XDT_INPROC_TEST_USER_DATA;
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('routes query/queryOne/exec/tx through the legacy localDb handle', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-inproc-'));
    const drizzleDir = path.join(userDataDir, 'drizzle');
    fs.mkdirSync(drizzleDir);
    fs.writeFileSync(path.join(drizzleDir, '0000_init.sql'), INIT_SQL, 'utf-8');
    process.env.XDT_INPROC_TEST_USER_DATA = userDataDir;
    process.env.XDT_DB_INPROC = 'true';
    previousResourcesPath = process.resourcesPath;
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: userDataDir,
    });

    const { createDbClient } = await import('../DbClient.js');
    const client = await createDbClient({ userId: `inproc-test-${Date.now()}` });

    await client.exec('CREATE TEMP TABLE inproc_fallback_test (id INTEGER PRIMARY KEY, name TEXT)');
    const inserted = await client.exec('INSERT INTO inproc_fallback_test (name) VALUES (?)', [
      'alice',
    ]);
    expect(inserted.changes).toBe(1);

    await expect(
      client.query<{ id: number; name: string }>(
        'SELECT id, name FROM inproc_fallback_test WHERE name = ?',
        ['alice'],
      ),
    ).resolves.toEqual([{ id: 1, name: 'alice' }]);
    await expect(
      client.queryOne<{ id: number; name: string }>(
        'SELECT id, name FROM inproc_fallback_test WHERE id = ?',
        [1],
      ),
    ).resolves.toEqual({ id: 1, name: 'alice' });

    await client.exec(
      'INSERT INTO sessions (id, status, working_dir, worktree_path) VALUES (?, ?, ?, ?)',
      ['inproc-session', 'active', userDataDir, path.join(userDataDir, 'worktree')],
    );
    await expect(client.readLocalWorktreeReferences?.()).resolves.toEqual([
      expect.objectContaining({
        id: 'inproc-session',
        status: 'active',
        currentDatabase: true,
      }),
    ]);

    const sourceId = `inproc-source-${Date.now()}`;
    await expect(
      client.tx('embedding.enqueue', {
        source: 'chat',
        now: Date.now(),
        items: [{ sourceId, modelId: 'test-model', vecTable: 'chat_vec' }],
      }),
    ).resolves.toEqual({ inserted: 1, skipped: 0 });
  }, 60_000);
});
