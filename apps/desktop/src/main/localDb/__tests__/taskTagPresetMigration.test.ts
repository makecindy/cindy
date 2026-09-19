import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runMigrations } from '../migrate';
import { readSchemaVersion, runMigrationReplay } from '../migrationRunner';
import type Database from 'better-sqlite3';

vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../backup', () => ({
  backupDb: vi.fn(async () => ({ noDb: true })),
  estimateDbSizeBytes: () => 0,
  getFreeDiskBytes: () => null,
  isoBackupTotalBudgetBytes: () => 0,
  pruneIsoBackupsToBudget: () => [],
}));
let db: Database.Database;
let dir: string;
const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tag-migration-'));
  mkdirSync(path.join(dir, 'drizzle'));
  for (const file of [
    '0110_abandoned_scarlet_witch.sql',
    '0111_messy_newton_destine.sql',
    '0112_backfill_task_tag_order.sql',
  ]) {
    copyFileSync(
      fileURLToPath(new URL(`../../../../drizzle/${file}`, import.meta.url)),
      path.join(dir, 'drizzle', file),
    );
  }
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: dir });
  db = createBetterSqliteDatabase(':memory:');
  db.exec(
    "CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE migration_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO migration_meta VALUES('schema_version','109');",
  );
  db.exec(
    'CREATE TABLE migration_history(seq INTEGER PRIMARY KEY,file_name TEXT,content_hash TEXT,applied_at INTEGER)',
  );
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor);
  else delete (process as any).resourcesPath;
});
it('rolls back schema and catalog if first preset initialization fails, then retries', async () => {
  // Fail during preset insertion, after every pending migration has executed.
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    if (sql === 'INSERT INTO task_tags(id,name,color,favorite_order,sort_order) VALUES(?,?,?,?,?)')
      throw new Error('seed failure');
    return prepare(sql);
  });
  await expect(runMigrations(db, path.join(dir, 'test.db'))).rejects.toThrow('seed failure');
  expect(readSchemaVersion(db)).toBe(109);
  expect(prepare('SELECT count(*) AS n FROM migration_history').get()).toEqual({ n: 0 });
  expect(prepare("SELECT name FROM sqlite_master WHERE name='task_tags'").get()).toBeUndefined();
  spy.mockRestore();
  await runMigrations(db, path.join(dir, 'test.db'));
  expect(readSchemaVersion(db)).toBe(112);
  expect(db.prepare('SELECT seq FROM migration_history ORDER BY seq').all()).toEqual([
    { seq: 110 },
    { seq: 111 },
    { seq: 112 },
  ]);
  expect(db.prepare('SELECT id FROM task_tags ORDER BY sort_order').all()).toEqual([
    ...['red', 'orange', 'yellow', 'green', 'blue', 'purple'].map((id) => ({
      id: `default:${id}`,
    })),
    ...['important', 'follow-up', 'work', 'life', 'ideas', 'reference'].map((id) => ({
      id: `preset:${id}`,
    })),
  ]);
  expect(
    db.prepare('SELECT sort_order, favorite_order FROM task_tags ORDER BY sort_order').all(),
  ).toEqual(
    Array.from({ length: 12 }, (_, index) => ({ sort_order: index, favorite_order: index })),
  );
  db.prepare("DELETE FROM task_tags WHERE id='default:red'").run();
  await runMigrations(db, path.join(dir, 'test.db'));
  expect(db.prepare('SELECT count(*) AS n FROM task_tags').get()).toEqual({ n: 11 });
});
it('preserves an existing tag catalog when upgrading from the tag schema', async () => {
  runMigrationReplay(db, { drizzleDir: path.join(dir, 'drizzle'), currentVersion: 109 });
  db.exec(
    "UPDATE migration_meta SET value='111' WHERE key='schema_version'; UPDATE task_tags SET name='Custom',revision=2 WHERE id='default:red';",
  );
  await runMigrations(db, path.join(dir, 'test.db'));
  expect(db.prepare("SELECT name FROM task_tags WHERE id='default:red'").get()).toEqual({
    name: 'Custom',
  });
  expect(db.prepare('SELECT count(*) AS n FROM task_tags').get()).toEqual({ n: 7 });
});
