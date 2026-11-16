/**
 * Test value: exercises the native maintenance IPC, read-only DB transactions and actual
 * copy/verify/swap/rollback path with synthetic SQLite fixtures. A deleted empty routine
 * is the minimum purge target; new work/references, plan drift or missing backups must
 * reject the entire purge. Inline and file worker transports protect fallback parity.
 * Tier: db (real temporary SQLite files and one production worker bundle).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { tx as runWorkerTransaction } from '../worker/opHandlers/tx';
import { WorkerThreadTransport } from '../client/WorkerThreadTransport';
import { buildDbWorkerBundle } from './dbWorkerTestUtils';
import { scanEmptySessionPurge, purgeEmptySessions } from '../emptySessionPurge';
import { runDbSlimmingMaintenance } from '../dbSlimmingMaintenance';
import {
  readDbSlimmingRequest,
  writeDbSlimmingRequest,
  type DbSlimmingRequestRecord,
} from '../maintenanceStore';
import { createLocalDbMaintenanceIpcHandlers } from '../ipc/maintenance';
import type { DbClient } from '../client/DbClient';

const EMPTY = '11111111-1111-4111-8111-111111111111';
const KEEP = '22222222-2222-4222-8222-222222222222';
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-empty-purge-'));
  file = path.join(dir, 'test.db');
  const db = createBetterSqliteDatabase(file);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, status TEXT, source TEXT, updated_at INTEGER, summary TEXT, sdk_session_id TEXT, total_token_usage INTEGER DEFAULT 0);
    CREATE TABLE bot_session_links(id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, bot_id TEXT, role TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, content TEXT);
    CREATE TABLE schedules(id TEXT PRIMARY KEY, target_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, status TEXT);
    CREATE TABLE bot_profiles(id TEXT PRIMARY KEY, canonical_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL);
    CREATE TABLE evidence(id TEXT PRIMARY KEY, payload TEXT);`);
  db.prepare('INSERT INTO sessions(id,status,source,updated_at) VALUES(?,?,?,1)').run(
    EMPTY,
    'deleted',
    'bot',
  );
  db.prepare('INSERT INTO sessions(id,status,source,updated_at) VALUES(?,?,?,1)').run(
    KEEP,
    'active',
    'bot',
  );
  db.prepare('INSERT INTO bot_session_links VALUES(?,?,?,?)').run(
    'old-link',
    EMPTY,
    'buddy',
    'routine',
  );
  db.prepare('INSERT INTO bot_session_links VALUES(?,?,?,?)').run(
    'main-link',
    KEEP,
    'buddy',
    'canonical',
  );
  db.prepare('INSERT INTO messages VALUES(?,?,?)').run(
    'keep-message',
    KEEP,
    'decision and unfinished work',
  );
  db.prepare('INSERT INTO bot_profiles VALUES(?,?)').run('buddy', KEEP);
  db.prepare('INSERT INTO schedules VALUES(?,?,?)').run('paused-job', KEEP, 'paused');
  db.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function plan() {
  const db = createBetterSqliteDatabase(file);
  try {
    return scanEmptySessionPurge(db, [EMPTY]);
  } finally {
    db.close();
  }
}
function request(): DbSlimmingRequestRecord {
  return {
    version: 1,
    id: '33333333-3333-4333-8333-333333333333',
    ownerId: 'owner',
    createdAt: 2,
    scannedAt: 2,
    archivedBeforeMs: Number.MIN_SAFE_INTEGER,
    includeActiveTasks: false,
    archiveAgeMonths: '7-days',
    deletedTaskCount: 0,
    archivedTaskCount: 0,
    messageCount: 0,
    beforeBytes: 0,
    backupEnabled: true,
    phase: 'scheduled',
    emptySessionPurge: plan(),
  };
}
describe('reviewed empty-session maintenance', () => {
  it('uses the actual copy/transaction/vacuum/verify/swap path with backup; preserves substantive sources and bindings', async () => {
    const pending = request();
    writeDbSlimmingRequest(dir, pending);
    const outcome = await runDbSlimmingMaintenance({
      userDataDir: dir,
      dbFilePath: file,
      request: pending,
      log,
    });
    expect(outcome.result).toMatchObject({
      status: 'completed',
      deletedTaskCount: 1,
      messageCount: 0,
      backupCreated: true,
    });
    const db = createBetterSqliteDatabase(file);
    expect(db.prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual([{ id: KEEP }]);
    expect(db.prepare('SELECT content FROM messages').get()).toEqual({
      content: 'decision and unfinished work',
    });
    expect(db.prepare('SELECT target_session_id,status FROM schedules').get()).toEqual({
      target_session_id: KEEP,
      status: 'paused',
    });
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
    const backup = createBetterSqliteDatabase(file + '.slimming-backup');
    expect(backup.prepare('SELECT count(*) n FROM sessions').get()).toEqual({ n: 2 });
    backup.close();
  });
  it.each(['message', 'canonical', 'schedule', 'json', 'other-session'])(
    'rejects a newly introduced %s reference without deleting anything',
    (kind) => {
      const db = createBetterSqliteDatabase(file);
      const approved = scanEmptySessionPurge(db, [EMPTY]);
      if (kind === 'message')
        db.prepare('INSERT INTO messages VALUES(?,?,?)').run('new', EMPTY, 'new work');
      if (kind === 'canonical')
        db.prepare('UPDATE bot_profiles SET canonical_session_id=?').run(EMPTY);
      if (kind === 'schedule') db.prepare('UPDATE schedules SET target_session_id=?').run(EMPTY);
      if (kind === 'json')
        db.prepare('INSERT INTO evidence VALUES(?,?)').run(
          'json',
          JSON.stringify({ source: 'session:' + EMPTY }),
        );
      if (kind === 'other-session')
        db.prepare('UPDATE sessions SET summary=? WHERE id=?').run(EMPTY, KEEP);
      expect(() => db.transaction(() => purgeEmptySessions(db, approved))()).toThrow();
      expect(db.prepare('SELECT count(*) n FROM sessions').get()).toEqual({ n: 2 });
      db.close();
    },
  );
  it('rejects fingerprint drift even if the record remains empty', () => {
    const db = createBetterSqliteDatabase(file);
    const approved = scanEmptySessionPurge(db, [EMPTY]);
    db.prepare('UPDATE sessions SET updated_at=updated_at+1 WHERE id=?').run(EMPTY);
    expect(() => purgeEmptySessions(db, approved)).toThrow('plan changed');
    db.close();
  });
  it('does not delete an unapproved empty session', () => {
    const db = createBetterSqliteDatabase(file);
    const approved = scanEmptySessionPurge(db, [EMPTY]);
    db.prepare('INSERT INTO sessions(id,status,source,updated_at) VALUES(?,?,?,1)').run(
      '44444444-4444-4444-8444-444444444444',
      'deleted',
      'bot',
    );
    db.transaction(() => purgeEmptySessions(db, approved))();
    expect(db.prepare('SELECT count(*) n FROM sessions').get()).toEqual({ n: 2 });
    db.close();
  });
  it('restores the original DB when replacement rename fails', async () => {
    const pending = request();
    writeDbSlimmingRequest(dir, pending);
    const rename = fs.renameSync.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('.work') && String(to) === file && !failed) {
        failed = true;
        throw new Error('injected replacement failure');
      }
      return rename(from, to);
    });
    const outcome = await runDbSlimmingMaintenance({
      userDataDir: dir,
      dbFilePath: file,
      request: pending,
      log,
    });
    expect(outcome.result).toMatchObject({ status: 'failed', originalDatabaseRestored: true });
    const db = createBetterSqliteDatabase(file);
    expect(db.prepare('SELECT count(*) n FROM sessions').get()).toEqual({ n: 2 });
    db.close();
  });
  it('IPC issues an owner-bound scan grant, rejects no-backup, and writes the validated plan through its normal marker writer', async () => {
    const queryOne = vi.fn();
    const relaunch = vi.fn();
    const handlers = createLocalDbMaintenanceIpcHandlers({
      captureOwner: () => ({ ownerId: 'owner', scopeKey: 'scope' }),
      isOwnerCurrent: () => true,
      getDbClient: () =>
        ({
          queryOne,
          tx: async (name: string, args: unknown) => {
            const db = createBetterSqliteDatabase(file);
            try {
              return runWorkerTransaction(db, { name, args });
            } finally {
              db.close();
            }
          },
        }) as unknown as DbClient,
      getDbClientOwnerId: () => 'owner',
      getCurrentDbPath: () => file,
      getUserDataDir: () => dir,
      canSchedule: () => true,
      selectBackupDirectory: async () => null,
      confirmActiveTaskCleanup: async () => true,
      confirmWithoutBackup: async () => true,
      revealFile: async () => true,
      relaunch,
    });
    const scan = await handlers.scan({ archiveAgeMonths: '7-days', emptySessionIds: [EMPTY] });
    expect(scan).toMatchObject({
      cleanupMode: 'empty-sessions',
      emptySessionCount: 1,
      messageCount: 0,
    });
    expect(queryOne).not.toHaveBeenCalled();
    await expect(handlers.schedule({ scanId: scan.scanId, backupEnabled: false })).rejects.toThrow(
      'requires backup',
    );
    await expect(handlers.schedule({ scanId: scan.scanId, backupEnabled: true })).resolves.toEqual({
      scheduled: true,
    });
    expect(readDbSlimmingRequest(dir)?.emptySessionPurge?.targets).toHaveLength(1);
    expect(readDbSlimmingRequest(dir)?.archivedBeforeMs).toBe(Number.MIN_SAFE_INTEGER);
    expect(relaunch).toHaveBeenCalledOnce();
  });
  it('rejects duplicate, malformed and empty allowlists', () => {
    const db = createBetterSqliteDatabase(file);
    for (const ids of [[], [EMPTY, EMPTY], ['../outside']])
      expect(() => scanEmptySessionPurge(db, ids)).toThrow('allowlist');
    db.close();
  });
});

it.each([true, false])(
  'round trips the read-only scan through the %s inline/file transport',
  async (inline) => {
    const worker = new WorkerThreadTransport(
      inline
        ? { useInlineWorker: true }
        : {
            workerScriptPath: await buildDbWorkerBundle(path.join(dir, 'bundle')),
            betterSqliteModulePath: require.resolve('better-sqlite3'),
          },
    );
    try {
      for (const sql of [
        'CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT,source TEXT,updated_at INTEGER)',
        'CREATE TABLE bot_session_links(id TEXT PRIMARY KEY,session_id TEXT,role TEXT)',
        'CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,content TEXT)',
      ])
        await worker.send('exec', { sql });
      await worker.send('exec', {
        sql: "INSERT INTO sessions VALUES(?, 'deleted', 'bot', 1)",
        params: [EMPTY],
      });
      await worker.send('exec', {
        sql: "INSERT INTO bot_session_links VALUES('link', ?, 'routine')",
        params: [EMPTY],
      });
      const result = await worker.send('tx', {
        name: 'maintenance.scanEmptySessions',
        args: { ids: [EMPTY] },
      });
      expect(result).toMatchObject({ targets: [{ id: EMPTY, fingerprint: expect.any(String) }] });
      expect(await worker.send('query', { sql: 'SELECT count(*) n FROM sessions' })).toEqual([
        { n: 1 },
      ]);
    } finally {
      await worker.close();
    }
  },
  60_000,
);

it.each([
  { version: 2 },
  { backupEnabled: false },
  { includeActiveTasks: true },
  { messageCount: 1 },
])('rejects an incompatible or mixed-scope persisted purge request: %j', (override) => {
  const pending = { ...request(), ...override } as DbSlimmingRequestRecord;
  writeDbSlimmingRequest(dir, pending);
  expect(() => readDbSlimmingRequest(dir)).toThrow('invalid database slimming request marker');
});

it('an older worker ignoring the new field gets an empty message scope and preserves all records', async () => {
  const { emptySessionPurge: _ignored, ...legacyView } = request();
  writeDbSlimmingRequest(dir, legacyView);
  const outcome = await runDbSlimmingMaintenance({
    userDataDir: dir,
    dbFilePath: file,
    request: legacyView,
    log,
  });
  expect(outcome.result).toMatchObject({
    status: 'completed',
    deletedTaskCount: 0,
    messageCount: 0,
  });
  const db = createBetterSqliteDatabase(file);
  expect(db.prepare('SELECT count(*) n FROM sessions').get()).toEqual({ n: 2 });
  expect(db.prepare('SELECT content FROM messages').get()).toEqual({
    content: 'decision and unfinished work',
  });
  db.close();
});
