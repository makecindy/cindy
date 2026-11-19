import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../DbClient.js';
import * as schema from '../../schema.js';
import { createDbClient, createInprocDbClient } from '../DbClient.js';
import { createLifecycleDbClientManager } from '../lifecycleDbClient.js';
import { retainDbClient } from '../pendingOperations.js';

const mainDb = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock('../../index.js', () => ({
  ensureReady: async () => ({ ready: true }),
  getRawDb: () => mainDb.db!,
  getDrizzle: () => drizzle(mainDb.db!, { schema }),
}));

// #9555 review / standard unit tier (tiny native fixture): real Desktop inproc factories and native B-tree
// corruption. Unit lifecycle mocks only proved dispose(), not native closure.
// Exclusive mkdtemp fixture, no profile. Separate file isolates the singleton
// port mock from DbClient's worker tests; both env and missing-worker fallback.
describe('explicit lifecycle recovery', () => {
  it.each(['env', 'fallback'])('keeps quarantine on passive readiness and replaces the native handle only on recovery (%s)', async mode => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-lifecycle-recovery-'));
    const file = path.join(dir, 'synthetic.db');
    const previous = process.env.XDT_DB_INPROC;
    const state = { current: null as DbClient | null };
    const handles: Database.Database[] = [];
    const open = () => {
      if (!mainDb.db) {
        mainDb.db = new Database(file);
        handles.push(mainDb.db);
      }
    };
    const manager = createLifecycleDbClientManager({
      quarantineMainDb: vi.fn(),
      getCurrentDbPath: () => file,
      createWorkerClient: mode === 'env' ? createDbClient : async () => { throw new Error('missing worker bundle'); },
      createInprocClient: createInprocDbClient,
      closeMainDb: () => { mainDb.db?.close(); mainDb.db = null; },
      setCurrentDbClient: client => { state.current = client; },
      clearCurrentDbClient: () => { state.current = null; },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    try {
      if (mode === 'env') process.env.XDT_DB_INPROC = 'true';
      open();
      await manager.ensure('owner-a', {});
      const first = state.current!;
      await first.exec('CREATE TABLE damaged(id INTEGER PRIMARY KEY)');
      await first.exec('INSERT INTO damaged VALUES (1)');
      const root = await first.queryOne<{ rootpage: number }>("SELECT rootpage FROM sqlite_master WHERE name='damaged'");
      const page = await first.queryOne<{ page_size: number }>('PRAGMA page_size');
      await first.exec('PRAGMA shrink_memory');
      const fd = fs.openSync(file, 'r+');
      try { fs.writeSync(fd, Buffer.from([0]), 0, 1, (root!.rootpage - 1) * page!.page_size); }
      finally { fs.closeSync(fd); }
      await expect(first.query('SELECT * FROM damaged')).rejects.toMatchObject({ code: 'SQLITE_CORRUPT' });
      // A catalog-only smoke succeeds on this damaged file. It cannot prove
      // that clearing the boundary or reusing this native handle is recovery.
      expect(handles[0].prepare('SELECT count(*) AS c FROM sqlite_master').get()).toEqual({ c: 1 });
      await expect(manager.ensure('owner-a', {})).rejects.toMatchObject({ code: 'SQLITE_CORRUPT' });
      expect(state.current).toBe(first);
      expect(handles[0].open).toBe(true);
      const release = retainDbClient(first);
      const recovering = manager.prepareForEnsure('owner-a', true);
      await Promise.resolve();
      expect(handles[0].open).toBe(true);
      release();
      await recovering;
      open();
      await manager.ensure('owner-a', {});
      expect(handles).toHaveLength(2);
      expect(handles[0].open).toBe(false);
      expect(state.current).not.toBe(first);
      await expect(first.query('SELECT 1')).rejects.toThrow('disposed');
      expect(await state.current!.queryOne('SELECT 42 AS n')).toEqual({ n: 42 });
      // Reopening does not repair table damage or replay the failed operation.
      await expect(state.current!.query('SELECT * FROM damaged')).rejects.toMatchObject({ code: 'SQLITE_CORRUPT' });
    } finally {
      await manager.dispose('test-end');
      for (const handle of handles) if (handle.open) handle.close();
      mainDb.db = null;
      if (previous === undefined) delete process.env.XDT_DB_INPROC;
      else process.env.XDT_DB_INPROC = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
