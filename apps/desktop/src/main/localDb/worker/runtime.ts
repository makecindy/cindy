import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type {
  LogEvent,
  VecStatusEvent,
} from '../client/DbTransport.js';
import {
  listPendingMigrations,
  readSchemaVersion,
} from '../migrationRunner.js';
import { detectSchemaDriftInDir } from '../schemaDriftCore.js';
import { assertCjkSegRegistered, registerCjkSeg } from '../registerCjkSeg.js';

export interface DbWorkerRuntimeOptions {
  userId?: string;
  dbPath?: string;
  drizzleDir?: string;
  sqliteVecExtPath?: string;
  nativeBinding?: string;
}

export type DatabaseConstructor = new (
  filename: string,
  options?: Database.Options,
) => Database.Database;

export interface DbWorkerRuntimeEvents {
  postLog(event: LogEvent): void;
  postVecStatus(event: VecStatusEvent): void;
}

export function createWorkerDatabase(
  DatabaseCtor: DatabaseConstructor,
  opts: DbWorkerRuntimeOptions,
  events: DbWorkerRuntimeEvents,
): Database.Database {
  const dbPath = typeof opts.dbPath === 'string' && opts.dbPath
    ? opts.dbPath
    : ':memory:';
  const dbOpts = opts.nativeBinding ? { nativeBinding: opts.nativeBinding } : {};
  const db = new DatabaseCtor(dbPath, dbOpts);
  try {
    registerCjkSeg(db);
    assertCjkSegRegistered(db);
    applyPragmas(db);

    if (dbPath !== ':memory:') {
      const vec = loadSqliteVecAtPath(db, opts.sqliteVecExtPath);
      events.postLog({
        level: vec.loaded ? 'info' : 'warn',
        scope: 'db-worker',
        payload: { event: 'dbWorker.sqliteVec', dbPath, ...vec },
      });
      events.postVecStatus(vec);
      assertNoPendingMigrations(db, dbPath, opts.drizzleDir, events);
      reportSchemaDrift(db, dbPath, opts.drizzleDir, events);
    }

    events.postLog({
      level: 'info',
      scope: 'db-worker',
      payload: { event: 'dbWorker.init.ok', runtimeMode: 'file', userId: opts.userId, dbPath },
    });
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // 初始化失败后关闭连接是 best-effort，原始错误更重要。
    }
    throw err;
  }
}

export function applyPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');
  db.pragma('cache_size = -65536');
  db.pragma('busy_timeout = 5000');
}

export function loadSqliteVecAtPath(
  db: Database.Database,
  sqliteVecExtPath: string | undefined,
): VecStatusEvent & { expectedPath?: string } {
  if (!sqliteVecExtPath) {
    return { loaded: false, error: 'sqlite-vec path not provided' };
  }
  if (!fs.existsSync(sqliteVecExtPath)) {
    return {
      loaded: false,
      error: 'sqlite-vec binary not found at expected path',
      expectedPath: sqliteVecExtPath,
    };
  }
  try {
    db.loadExtension(sqliteVecExtPath);
    const row = db.prepare('SELECT vec_version() as v').get() as
      | { v?: string }
      | undefined;
    return { loaded: true, version: row?.v ?? 'unknown' };
  } catch (err) {
    return {
      loaded: false,
      error: err instanceof Error ? err.message : String(err),
      expectedPath: sqliteVecExtPath,
    };
  }
}

function assertNoPendingMigrations(
  db: Database.Database,
  dbPath: string,
  drizzleDir: string | undefined,
  events: DbWorkerRuntimeEvents,
): void {
  if (!drizzleDir || !fs.existsSync(drizzleDir)) {
    throw Object.assign(new Error(`drizzle dir not found for db worker: ${drizzleDir}`), {
      code: 'MIGRATION_DIR_MISSING',
    });
  }

  const currentVersion = readSchemaVersion(db);
  const pending = listPendingMigrations(drizzleDir, currentVersion);
  events.postLog({
    level: 'info',
    scope: 'db-worker',
    payload: {
      event: 'dbWorker.migrate.scan',
      dbPath,
      drizzleDir,
      currentVersion,
      pendingCount: pending.length,
    },
  });
  if (pending.length === 0) return;
  throw Object.assign(
    new Error(
      `db worker found ${pending.length} pending migration(s); call localDb.ensureReady before createDbClient`,
    ),
    {
      code: 'MIGRATION_REQUIRED',
      pending: pending.map((migration) => ({
        seq: migration.seq,
        fileName: migration.fileName,
      })),
    },
  );
}

function reportSchemaDrift(
  db: Database.Database,
  dbPath: string,
  drizzleDir: string | undefined,
  events: DbWorkerRuntimeEvents,
): void {
  if (!drizzleDir || !fs.existsSync(drizzleDir)) {
    return;
  }
  const drift = detectSchemaDriftInDir(db, drizzleDir, (warning) => {
    events.postLog({
      level: 'warn',
      scope: 'db-worker',
      payload: {
        event: `dbWorker.schemaDrift.${warning.kind}`,
        fileName: warning.kind === 'hashFailed' ? warning.fileName : undefined,
        error: warning.error instanceof Error
          ? warning.error.message
          : String(warning.error),
      },
    });
  });
  events.postLog({
    level: drift.status === 'clean' ? 'info' : 'warn',
    scope: 'db-worker',
    payload: {
      event: 'dbWorker.schemaDrift',
      dbPath,
      status: drift.status,
      entryCount: drift.entries.length,
    },
  });
}
