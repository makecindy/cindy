import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  LogEvent,
  VecStatusEvent,
} from '../../client/DbTransport.js';
import type { DbWorkerRuntimeEvents } from '../runtime.js';
import { createWorkerDatabase } from '../runtime.js';

describe('db worker runtime', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps startup alive when schema drift history query fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-worker-runtime-'));
    tempDirs.push(dir);
    const drizzleDir = path.join(dir, 'drizzle');
    const dbPath = path.join(dir, 'xdt-maker-test-user.db');
    fs.mkdirSync(drizzleDir);
    fs.writeFileSync(
      path.join(drizzleDir, '0000_init.sql'),
      [
        'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
        'CREATE TABLE migration_history (seq INTEGER PRIMARY KEY);',
        'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      ].join('\n'),
      'utf-8',
    );
    createMigratedSmokeDb(dbPath, { malformedHistory: true });

    const logs: LogEvent[] = [];
    const vecStatus: VecStatusEvent[] = [];
    const db = createWorkerDatabase(Database, {
      userId: 'test-user',
      dbPath,
      drizzleDir,
    }, {
      postLog: (event) => logs.push(event),
      postVecStatus: (event) => vecStatus.push(event),
    });

    try {
      expect(db
        .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
        .all('table', 'worker_smoke')).toEqual([{ name: 'worker_smoke' }]);
      expect(db
        .prepare("SELECT value FROM migration_meta WHERE key='schema_version'")
        .get()).toEqual({ value: '0' });
      expect(vecStatus).toEqual([{
        loaded: false,
        error: 'sqlite-vec path not provided',
      }]);
      expect(logs.some((event) => (
        event.payload as { event?: string }
      ).event === 'dbWorker.schemaDrift.queryFailed')).toBe(true);
      expect(findLogPayload(logs, 'dbWorker.schemaDrift')).toMatchObject({
        status: 'unknown',
      });
      expect(db.prepare('SELECT cjk_seg(?) AS v').get('探针')).toEqual({ v: '探 针' });
    } finally {
      db.close();
    }
  });

  it('rejects pending migrations because ensureReady owns migration rollback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-worker-pending-'));
    tempDirs.push(dir);
    const drizzleDir = path.join(dir, 'drizzle');
    const dbPath = path.join(dir, 'xdt-maker-test-user.db');
    fs.mkdirSync(drizzleDir);
    fs.writeFileSync(
      path.join(drizzleDir, '0000_init.sql'),
      [
        'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
        'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      ].join('\n'),
      'utf-8',
    );

    expect(() => createWorkerDatabase(Database, {
      userId: 'test-user',
      dbPath,
      drizzleDir,
    }, makeEvents())).toThrow(/pending migration/i);
  });

  it('reports drifted and missing migration history entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-worker-drift-'));
    tempDirs.push(dir);
    const drizzleDir = path.join(dir, 'drizzle');
    const dbPath = path.join(dir, 'xdt-maker-test-user.db');
    fs.mkdirSync(drizzleDir);
    fs.writeFileSync(
      path.join(drizzleDir, '0000_init.sql'),
      [
        'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
        'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      ].join('\n'),
      'utf-8',
    );
    createMigratedSmokeDb(dbPath);
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(0, '0000_init.sql', 'wrong-hash', Date.now());
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(1, '0001_missing.sql', 'missing-hash', Date.now());
    } finally {
      db.close();
    }

    const logs: LogEvent[] = [];
    const workerDb = createWorkerDatabase(Database, {
      userId: 'test-user',
      dbPath,
      drizzleDir,
    }, {
      ...makeEvents(),
      postLog: (event) => logs.push(event),
    });

    try {
      expect(findLogPayload(logs, 'dbWorker.schemaDrift')).toMatchObject({
        status: 'drifted',
        entryCount: 2,
      });
    } finally {
      workerDb.close();
    }
  });

  it('createWorkerDatabase 挂 TEMP 触发器并按字写入 FTS（#3841 生产入口）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-worker-cjk-'));
    tempDirs.push(dir);
    const drizzleDir = path.join(dir, 'drizzle');
    const dbPath = path.join(dir, 'xdt-maker-test-user.db');
    fs.mkdirSync(drizzleDir);
    fs.writeFileSync(
      path.join(drizzleDir, '0000_init.sql'),
      [
        'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
        'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      ].join('\n'),
      'utf-8',
    );
    const seed = new Database(dbPath);
    try {
      seed.exec(`
        CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          rewind_at INTEGER
        );
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          message_id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content,
          tokenize='porter unicode61'
        );
        CREATE TABLE messages_fts_rows (
          fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          message_id TEXT NOT NULL
        );
        CREATE UNIQUE INDEX messages_fts_rows_message_id_idx ON messages_fts_rows(message_id);
      `);
      seed.prepare("INSERT INTO migration_meta (key, value) VALUES ('schema_version', '0')").run();
    } finally {
      seed.close();
    }

    const workerDb = createWorkerDatabase(Database, {
      userId: 'test-user',
      dbPath,
      drizzleDir,
    }, makeEvents());
    try {
      const installed = workerDb.prepare(
        "SELECT count(*) AS n FROM temp.sqlite_master WHERE type='trigger' AND name IN ('messages_fts_insert_cjk','messages_fts_update_cjk')",
      ).get() as { n: number };
      expect(installed.n).toBe(2);
      workerDb.prepare(
        "INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('m1', 'c', 's', 'user', '登录报错了', 1)",
      ).run();
      expect(
        (workerDb.prepare('SELECT content FROM messages_fts WHERE message_id = ?').get('m1') as { content: string }).content,
      ).toBe('登 录 报 错 了');
    } finally {
      workerDb.close();
    }
  });

  it('keeps startup alive when sqlite-vec load fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-worker-vec-'));
    tempDirs.push(dir);
    const drizzleDir = path.join(dir, 'drizzle');
    const dbPath = path.join(dir, 'xdt-maker-test-user.db');
    const invalidVecPath = path.join(dir, 'vec0.dll');
    fs.mkdirSync(drizzleDir);
    fs.writeFileSync(
      path.join(drizzleDir, '0000_init.sql'),
      [
        'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
        'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(invalidVecPath, 'not a sqlite extension', 'utf-8');
    createMigratedSmokeDb(dbPath);

    const vecStatus: VecStatusEvent[] = [];
    const workerDb = createWorkerDatabase(Database, {
      userId: 'test-user',
      dbPath,
      drizzleDir,
      sqliteVecExtPath: invalidVecPath,
    }, {
      ...makeEvents(),
      postVecStatus: (event) => vecStatus.push(event),
    });

    try {
      expect(workerDb
        .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
        .all('table', 'worker_smoke')).toEqual([{ name: 'worker_smoke' }]);
      expect(vecStatus[0]).toMatchObject({
        loaded: false,
        expectedPath: invalidVecPath,
      });
      expect(vecStatus[0].error).toBeTruthy();
    } finally {
      workerDb.close();
    }
  });
});

function makeEvents(): DbWorkerRuntimeEvents {
  return {
    postLog: () => {},
    postVecStatus: () => {},
  };
}

function findLogPayload(logs: LogEvent[], eventName: string): Record<string, unknown> | undefined {
  return logs
    .map((event) => event.payload as Record<string, unknown>)
    .find((payload) => payload.event === eventName);
}

function createMigratedSmokeDb(
  dbPath: string,
  opts: { malformedHistory?: boolean } = {},
): void {
  const db = new Database(dbPath);
  try {
    db.exec(
      [
        'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
        opts.malformedHistory
          ? 'CREATE TABLE migration_history (seq INTEGER PRIMARY KEY);'
          : 'CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL);',
        'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      ].join('\n'),
    );
    db.prepare(
      "INSERT INTO migration_meta (key, value) VALUES ('schema_version', '0')",
    ).run();
  } finally {
    db.close();
  }
}
