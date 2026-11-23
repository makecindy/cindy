import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { sql } from 'drizzle-orm';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../schema.js';
import { createDbClientForHandle } from '../createDbClientForHandle.js';
import { WorkerThreadTransport } from '../WorkerThreadTransport.js';
import type { DbClient } from '../DbClient.js';
import { buildDbWorkerBundle } from '../../__tests__/dbWorkerTestUtils.js';

import { createDbClient } from '../DbClient.js';

describe('DbClient', () => {
  it('runs query/exec and disposes idempotently with the inline worker contract', async () => {
    const client = await createDbClient({ useInlineWorker: true });
    try {
      await client.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
      const inserted = await client.exec('INSERT INTO t (name) VALUES (?)', ['alice']);
      expect(inserted.changes).toBe(1);

      const rows = await client.query<{ id: number; name: string }>(
        'SELECT id, name FROM t WHERE name = ?',
        ['alice'],
      );
      expect(rows).toEqual([{ id: 1, name: 'alice' }]);

      const row = await client.queryOne<{ id: number; name: string }>(
        'SELECT id, name FROM t WHERE id = ?',
        [1],
      );
      expect(row).toEqual({ id: 1, name: 'alice' });
    } finally {
      await client.dispose();
      await client.dispose();
    }
  });

  // #11628 db tier: a sibling reader reports corruption before this worker touches the bad page.
  it('blocks an already-built Drizzle write after the maintenance reader reports corruption', async () => {
    const client = await createDbClient({ useInlineWorker: true });
    try {
      const write = client.drizzle.delete(schema.sessions);
      client.observeCorruption?.(Object.assign(new Error('damaged page'), { code: 'SQLITE_CORRUPT' }));
      await expect(write.run()).rejects.toMatchObject({ code: 'DB_TRANSPORT_NOT_SENT' });
    } finally {
      await client.dispose();
    }
  });

  it('falls back to worker-thread when utility-process is requested', async () => {
    const client = await createDbClient({ transport: 'utility-process', useInlineWorker: true });
    try {
      // Should not throw — utility-process falls back to worker-thread
      await client.exec('CREATE TABLE fallback_test (id INTEGER PRIMARY KEY)');
      const rows = await client.query<{ id: number }>('SELECT id FROM fallback_test');
      expect(rows).toEqual([]);
    } finally {
      await client.dispose();
    }
  });

  it('falls back to worker-thread when XDT_DB_TRANSPORT=utility-process', async () => {
    const previous = process.env.XDT_DB_TRANSPORT;
    process.env.XDT_DB_TRANSPORT = 'utility-process';
    try {
      const client = await createDbClient({ useInlineWorker: true });
      try {
        await client.exec('CREATE TABLE env_fallback_test (id INTEGER PRIMARY KEY)');
        const rows = await client.query<{ id: number }>('SELECT id FROM env_fallback_test');
        expect(rows).toEqual([]);
      } finally {
        await client.dispose();
      }
    } finally {
      if (previous === undefined) {
        delete process.env.XDT_DB_TRANSPORT;
      } else {
        process.env.XDT_DB_TRANSPORT = previous;
      }
    }
  });
});

// #9555: production DbClient + native SQLite, not injected error responses.
// Existing tests only cover healthy databases. The unique synthetic WAL fixture
// invalidates one B-tree page after checkpoint/cache eviction; no user data.
// Tier: db (existing localDb client tests); inline and default file-worker paths.
describe('runtime SQLite corruption containment', () => {
  it.each(['inline', 'file', 'handle'])('isolates a damaged instance and preserves other databases (%s)', async (mode) => {
    const useInlineWorker = mode === 'inline';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-corrupt-'));
    const dbPath = path.join(dir, 'synthetic.db');
    const drizzleDir = path.join(dir, 'migrations');
    fs.mkdirSync(drizzleDir);
    let client: Awaited<ReturnType<typeof createDbClient>> | undefined;
    let healthy: Awaited<ReturnType<typeof createDbClient>> | undefined;
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    try {
      const workerScriptPath = mode === 'file' ? await buildDbWorkerBundle(path.join(dir, 'bundle')) : undefined;
      const notify = vi.fn();
      const handle = mode === 'handle' ? new Database(dbPath) : null;
      client = handle ? createDbClientForHandle({ db: handle, drizzle: drizzle(handle, { schema }),
        dispose: async () => { handle.close(); }, onCorruption: notify }) : await createDbClient({ useInlineWorker, workerScriptPath, dbPath, drizzleDir, onCorruption: notify,
        betterSqliteModulePath: require.resolve('better-sqlite3'),
        sqliteVecExtPath: path.join(dir, 'no-vector') });
      // Catalog scans also read other owners' read-only databases. Their
      // corruption must fail the scan, without quarantining this healthy client.
      await client.exec('CREATE TABLE sessions(id TEXT, status TEXT, working_dir TEXT)');
      const catalogPath = path.join(dir, 'cindy-current.db');
      // The reader requires the production basename; use a separate isolated
      // client below rather than renaming an open SQLite database.
      const otherPath = path.join(dir, 'cindy-other.db');
      const other = new Database(otherPath);
      other.exec('CREATE TABLE sessions(id TEXT, status TEXT, working_dir TEXT)');
      other.close();
      const bytes = fs.readFileSync(otherPath);
      bytes[100] = 0;
      fs.writeFileSync(otherPath, bytes);
      const catalogHandle = mode === 'handle' ? new Database(catalogPath) : null;
      const catalog = catalogHandle ? createDbClientForHandle({ db: catalogHandle, drizzle: drizzle(catalogHandle, { schema }),
        dispose: async () => { catalogHandle.close(); } }) : await createDbClient({ useInlineWorker, workerScriptPath,
        dbPath: catalogPath, drizzleDir, betterSqliteModulePath: require.resolve('better-sqlite3') });
      try {
        await catalog.exec('CREATE TABLE sessions(id TEXT, status TEXT, working_dir TEXT)');
        await expect(catalog.readLocalWorktreeReferences!()).rejects.toMatchObject({ code: 'DB_REFERENCE_SOURCE_CORRUPT' });
        expect(await catalog.queryOne('SELECT 9 AS n')).toEqual({ n: 9 });
        expect(catalog.corruptionError).toBeNull();
      } finally {
        await catalog.dispose();
        fs.rmSync(otherPath, { force: true });
      }
      await damageFixture(client, dbPath);
      if (mode === 'handle') {
        let nativeFailure: unknown;
        expect(() => client!.drizzle.transaction((tx) => {
          try { tx.get(sql`SELECT count(*) AS n FROM damaged`); } catch (error) { nativeFailure = error; }
          // Even a caller swallowing the native failure cannot commit the
          // remainder of the transaction or continue through a cached builder.
          return 'must not commit';
        }, { behavior: 'immediate' })).toThrow(expect.objectContaining({ code: 'DB_TRANSPORT_NOT_SENT' }));
        expect(nativeFailure).toMatchObject({ code: 'SQLITE_CORRUPT' });
      } else if (mode === 'file') {
        await expect(client.drizzle.select({ n: sql<number>`count(*)` }).from(sql`damaged`)).rejects.toMatchObject({ code: 'SQLITE_CORRUPT' });
      } else {
        await expect(client.queryOne('SELECT count(*) AS n FROM damaged')).rejects.toMatchObject({ code: 'SQLITE_CORRUPT' });
      }
      const sent = post.mock.calls.length;
      await expect(client.queryOne('SELECT 1 AS n')).rejects.toMatchObject({ code: 'DB_TRANSPORT_NOT_SENT' });
      const drizzleFailure = client.drizzle.select({ n: sql<number>`1` }).from(sql`damaged`);
      await expect(drizzleFailure).rejects.toMatchObject({ code: 'DB_TRANSPORT_NOT_SENT' });
      expect(notify).toHaveBeenCalledOnce();
      await expect(client.exec('CREATE TABLE must_not_exist(id INTEGER)')).rejects.toMatchObject({ code: 'DB_TRANSPORT_NOT_SENT' });
      await expect(client.tx('unsupported', {})).rejects.toMatchObject({ code: 'DB_TRANSPORT_NOT_SENT' });
      expect(post.mock.calls).toHaveLength(sent);
      healthy = await createDbClient({ useInlineWorker: true });
      expect(await healthy.queryOne('SELECT 42 AS n')).toEqual({ n: 42 });
      await client.dispose();
      await client.dispose();
      // A new instance has no inherited corruption latch.
      expect(await healthy.queryOne('SELECT 43 AS n')).toEqual({ n: 43 });
    } finally {
      post.mockRestore();
      await client?.dispose();
      await healthy?.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

/** Shared real-WAL failure input; caller owns the exclusively synthetic path. */
async function damageFixture(client: Pick<DbClient, 'query' | 'queryOne' | 'exec'>, dbPath: string): Promise<void> {
  await client.query('PRAGMA journal_mode = WAL');
  await client.exec('CREATE TABLE damaged(id INTEGER PRIMARY KEY, payload TEXT)');
  await client.exec("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO damaged SELECT x, printf('%0500d',x) FROM n");
  expect(await client.queryOne('SELECT count(*) AS n FROM damaged')).toEqual({ n: 1000 });
  // A syntax error containing 'malformed' is recoverable, never corruption.
  await expect(client.query('malformed SQL')).rejects.toMatchObject({ code: 'SQLITE_ERROR' });
  expect(await client.queryOne('SELECT 7 AS n')).toEqual({ n: 7 });
  const root = await client.queryOne<{ rootpage: number }>("SELECT rootpage FROM sqlite_master WHERE name='damaged'");
  const page = await client.queryOne<{ page_size: number }>('PRAGMA page_size');
  await client.query('PRAGMA wal_checkpoint(TRUNCATE)');
  await client.exec('PRAGMA shrink_memory');
  const fd = fs.openSync(dbPath, 'r+');
  try {
    fs.writeSync(fd, Buffer.from([0]), 0, 1, (root!.rootpage - 1) * page!.page_size);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}


// Same worker entry as the shipped client; backpressure only changes whether
// follow-up work has crossed postMessage when the first corrupt response arrives.
it.each([1, 128])('does not execute queued/posted writes after corruption (capacity=%s)', async (maxInFlightRpcs) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-corrupt-queue-'));
  const dbPath = path.join(dir, 'synthetic.db');
  const drizzleDir = path.join(dir, 'migrations');
  fs.mkdirSync(drizzleDir);
  const transport = new WorkerThreadTransport({ useInlineWorker: true, dbPath, drizzleDir, maxInFlightRpcs });
  const adapter = {
    query: <T>(sql: string) => transport.send<T[]>('query', { sql }),
    queryOne: <T>(sql: string) => transport.send<T | undefined>('queryOne', { sql }),
    exec: (sql: string) => transport.send<{ changes: number; lastInsertRowid: number }>('exec', { sql }),
  };
  try {
    await adapter.exec('CREATE TABLE committed_log(id INTEGER)');
    await damageFixture(adapter, dbPath);
    const results = await Promise.allSettled([
      adapter.exec('INSERT INTO committed_log VALUES (1)'),
      adapter.queryOne('SELECT count(*) FROM damaged'),
      adapter.exec('CREATE TABLE must_not_exist(id INTEGER)'),
    ]);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { changes: 1 } });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'SQLITE_CORRUPT' } });
    expect(results[2]).toMatchObject({ status: 'rejected', reason: { code: 'DB_TRANSPORT_NOT_SENT' } });
    await expect(transport.send('query', { sql: 'SELECT 1' })).rejects.toMatchObject({ code: 'DB_TRANSPORT_NOT_SENT' });
  } finally {
    await transport.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
