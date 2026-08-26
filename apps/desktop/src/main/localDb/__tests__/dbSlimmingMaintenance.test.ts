import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import {
  discardCancelledDbSlimmingMaintenance,
  estimateDbFilesBytes,
  runDbSlimmingMaintenance,
} from '../dbSlimmingMaintenance';
import {
  adoptDbSlimmingBackup,
  dbSlimmingRequestPath,
  readDbSlimmingRequest,
  type DbSlimmingRequestRecord,
  writeDbSlimmingRequest,
  writeDbSlimmingResult,
} from '../maintenanceStore';

const REQUEST_ID = '9c5c7e99-6a6a-4d21-9152-4034a4959490';

let tmpDir: string;
let dbFilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-slimming-'));
  dbFilePath = path.join(tmpDir, 'cindy-owner.db');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function request(overrides: Partial<DbSlimmingRequestRecord> = {}): DbSlimmingRequestRecord {
  return {
    version: 1,
    id: REQUEST_ID,
    ownerId: 'owner-1',
    createdAt: 2_000,
    scannedAt: 2_000,
    archivedBeforeMs: 1_000,
    archiveAgeMonths: 3,
    deletedTaskCount: 0,
    archivedTaskCount: 0,
    messageCount: 0,
    beforeBytes: fs.existsSync(dbFilePath) ? estimateDbFilesBytes(dbFilePath) : 0,
    backupEnabled: false,
    phase: 'scheduled',
    ...overrides,
  };
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createCleanupFixture(): void {
  const db = createBetterSqliteDatabase(dbFilePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      total_token_usage INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      sdk_session_id TEXT,
      list_preview TEXT,
      list_preview_role TEXT,
      list_message_count INTEGER,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      summary TEXT,
      codex_plan_json TEXT,
      codex_history_has_product_prompt INTEGER,
      active_turn_started_at INTEGER,
      last_turn_ended_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      content TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      message_id UNINDEXED,
      session_id UNINDEXED,
      role UNINDEXED,
      content
    );
    CREATE TABLE messages_fts_rows (
      fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      message_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX messages_fts_rows_message_id_idx ON messages_fts_rows(message_id);
    CREATE TABLE messages_fts_delete_audit (message_id TEXT NOT NULL);
    CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts_delete_audit (message_id) VALUES (old.id);
      DELETE FROM messages_fts
        WHERE rowid = (
          SELECT fts_rowid FROM messages_fts_rows WHERE message_id = old.id
        );
      DELETE FROM messages_fts_rows WHERE message_id = old.id;
    END;
    CREATE TABLE subagent_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE subagent_run_aliases (
      run_id TEXT NOT NULL REFERENCES subagent_runs(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      PRIMARY KEY (run_id, alias)
    );
    CREATE TABLE session_pr_refs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    CREATE TABLE session_goals (session_id TEXT PRIMARY KEY);
    CREATE TABLE agent_input_queue_snapshots (session_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE ghost_cards (call_id TEXT PRIMARY KEY, session_id TEXT, html TEXT NOT NULL);
    CREATE TABLE skill_usage_sources (
      raw_file_path TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE skill_usage_exposures (
      id TEXT PRIMARY KEY,
      raw_file_path TEXT NOT NULL REFERENCES skill_usage_sources(raw_file_path) ON DELETE CASCADE
    );
    CREATE TABLE media_refs (id TEXT PRIMARY KEY, origin_session_id TEXT, label TEXT);
  `);
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, title, status, updated_at, total_token_usage, total_cost_usd,
      sdk_session_id, list_preview, list_preview_role, list_message_count,
      context_tokens, context_window, summary, codex_plan_json,
      codex_history_has_product_prompt, active_turn_started_at, last_turn_ended_at
    ) VALUES (
      ?, ?, ?, ?, 7, 1.5, 'native-id', 'stale preview', 'assistant', 1,
      100, 200, 'summary', '{}', 1, 10, 20
    )
  `);
  for (const [id, status, updatedAt] of [
    ['deleted-old', 'deleted', 500],
    ['deleted-new', 'deleted', 2_500],
    ['archived-boundary', 'archived', 1_000],
    ['archived-new', 'archived', 1_001],
    ['active-old', 'active', 100],
  ] as const) {
    insertSession.run(id, `title-${id}`, status, updatedAt);
    db.prepare('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)').run(
      `message-${id}`,
      id,
      'x'.repeat(32 * 1024),
    );
    const ftsRowid = Number(
      db
        .prepare('INSERT INTO messages_fts_rows (message_id) VALUES (?)')
        .run(`message-${id}`).lastInsertRowid,
    );
    db.prepare(
      'INSERT INTO messages_fts (rowid, message_id, session_id, role, content) VALUES (?, ?, ?, ?, ?)',
    ).run(
      ftsRowid,
      `message-${id}`,
      id,
      'user',
      `content-${id}`,
    );
  }
  insertSession.run('archived-empty', 'title-archived-empty', 'archived', 500);
  for (const sessionId of ['deleted-old', 'archived-boundary']) {
    db.prepare('INSERT INTO subagent_runs (id, session_id) VALUES (?, ?)').run(
      `run-${sessionId}`,
      sessionId,
    );
    db.prepare('INSERT INTO subagent_run_aliases (run_id, alias) VALUES (?, ?)').run(
      `run-${sessionId}`,
      'alias',
    );
    db.prepare('INSERT INTO session_pr_refs (id, session_id) VALUES (?, ?)').run(
      `pr-${sessionId}`,
      sessionId,
    );
    db.prepare('INSERT INTO session_goals (session_id) VALUES (?)').run(sessionId);
    db.prepare('INSERT INTO agent_input_queue_snapshots (session_id, payload) VALUES (?, ?)').run(
      sessionId,
      '[]',
    );
    db.prepare('INSERT INTO ghost_cards (call_id, session_id, html) VALUES (?, ?, ?)').run(
      `card-${sessionId}`,
      sessionId,
      '<p>history</p>',
    );
    db.prepare('INSERT INTO skill_usage_sources (raw_file_path, session_id) VALUES (?, ?)').run(
      `source-${sessionId}`,
      sessionId,
    );
    db.prepare('INSERT INTO skill_usage_exposures (id, raw_file_path) VALUES (?, ?)').run(
      `exposure-${sessionId}`,
      `source-${sessionId}`,
    );
    db.prepare('INSERT INTO media_refs (id, origin_session_id, label) VALUES (?, ?, ?)').run(
      `media-${sessionId}`,
      sessionId,
      'keep the external-file ownership ledger intact',
    );
  }
  db.pragma('journal_mode = WAL');
  db.close();
}

function createLegacyCleanupFixture(): void {
  const db = createBetterSqliteDatabase(dbFilePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      content TEXT NOT NULL
    );
    INSERT INTO sessions (id, status, updated_at) VALUES ('archived-old', 'archived', 500);
    INSERT INTO messages (id, session_id, content) VALUES ('message-old', 'archived-old', 'old');
  `);
  db.close();
}

function createMarkerDatabase(filePath: string, marker: string): void {
  const db = createBetterSqliteDatabase(filePath);
  db.exec('CREATE TABLE marker (value TEXT NOT NULL)');
  db.prepare('INSERT INTO marker (value) VALUES (?)').run(marker);
  db.close();
}

function readMarker(filePath: string): string {
  const db = createBetterSqliteDatabase(filePath, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT value FROM marker').get() as { value: string }).value;
  } finally {
    db.close();
  }
}

describe('runDbSlimmingMaintenance', () => {
  it('cleans only messages and their derived indexes in the frozen inactive-task scope', async () => {
    createCleanupFixture();
    const beforeBytes = estimateDbFilesBytes(dbFilePath);
    const onProgress = vi.fn();
    const beforeReplacement = vi.fn(async () => {});

    const outcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: request({ beforeBytes }),
      now: () => 3_000,
      log,
      onProgress,
      beforeReplacement,
    });

    expect(outcome.originalDatabaseReady).toBe(true);
    expect(outcome.result).toMatchObject({
      status: 'completed',
      deletedTaskCount: 1,
      archivedTaskCount: 1,
      messageCount: 2,
      backupCreated: false,
    });
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'copying', cancellable: true }),
    );
    expect(onProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'backing-up' }),
    );
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'finalizing',
      progress: 96,
      cancellable: false,
    });
    expect(beforeReplacement).toHaveBeenCalledTimes(1);
    const db = createBetterSqliteDatabase(dbFilePath, { fileMustExist: true });
    try {
      expect(
        db.prepare('SELECT id FROM messages ORDER BY id').all().map((row) => (row as { id: string }).id),
      ).toEqual([
        'message-active-old',
        'message-archived-new',
        'message-deleted-new',
      ]);
      expect(db.prepare('SELECT count(*) AS count FROM messages_fts').get()).toEqual({ count: 3 });
      expect(
        db.prepare('SELECT message_id FROM messages_fts_rows ORDER BY message_id').all(),
      ).toEqual([
        { message_id: 'message-active-old' },
        { message_id: 'message-archived-new' },
        { message_id: 'message-deleted-new' },
      ]);
      expect(db.prepare('SELECT count(*) AS count FROM messages_fts_delete_audit').get()).toEqual({
        count: 0,
      });
      db.prepare("DELETE FROM messages WHERE id = 'message-active-old'").run();
      expect(db.prepare('SELECT message_id FROM messages_fts_delete_audit').all()).toEqual([
        { message_id: 'message-active-old' },
      ]);
      expect(
        db.prepare('SELECT message_id FROM messages_fts_rows ORDER BY message_id').all(),
      ).toEqual([
        { message_id: 'message-archived-new' },
        { message_id: 'message-deleted-new' },
      ]);
      expect(db.prepare('SELECT count(*) AS count FROM subagent_runs').get()).toEqual({ count: 2 });
      expect(db.prepare('SELECT count(*) AS count FROM subagent_run_aliases').get()).toEqual({ count: 2 });
      expect(db.prepare('SELECT count(*) AS count FROM session_pr_refs').get()).toEqual({ count: 2 });
      expect(db.prepare('SELECT count(*) AS count FROM session_goals').get()).toEqual({ count: 2 });
      expect(db.prepare('SELECT count(*) AS count FROM agent_input_queue_snapshots').get()).toEqual({ count: 2 });
      expect(db.prepare('SELECT count(*) AS count FROM ghost_cards').get()).toEqual({ count: 2 });
      expect(db.prepare('SELECT count(*) AS count FROM skill_usage_sources').get()).toEqual({ count: 2 });
      expect(db.prepare('SELECT count(*) AS count FROM skill_usage_exposures').get()).toEqual({ count: 2 });
      expect(db.prepare('SELECT count(*) AS count FROM media_refs').get()).toEqual({ count: 2 });
      expect(
        db.prepare(`
          SELECT title, status, updated_at, total_token_usage, total_cost_usd,
                 sdk_session_id, list_preview, list_preview_role, list_message_count,
                 context_tokens, context_window, cleared_at,
                 summary, codex_plan_json, codex_history_has_product_prompt,
                 active_turn_started_at, last_turn_ended_at
            FROM sessions WHERE id = 'archived-boundary'
        `).get(),
      ).toEqual({
        title: 'title-archived-boundary',
        status: 'archived',
        updated_at: 1_000,
        total_token_usage: 7,
        total_cost_usd: 1.5,
        sdk_session_id: 'native-id',
        list_preview: null,
        list_preview_role: null,
        list_message_count: null,
        context_tokens: 100,
        context_window: 200,
        cleared_at: null,
        summary: 'summary',
        codex_plan_json: '{}',
        codex_history_has_product_prompt: 1,
        active_turn_started_at: 10,
        last_turn_ended_at: 20,
      });
      expect(
        db.prepare(`
          SELECT list_preview, list_preview_role, list_message_count
            FROM sessions WHERE id = 'active-old'
        `).get(),
      ).toEqual({
        list_preview: 'stale preview',
        list_preview_role: 'assistant',
        list_message_count: 1,
      });
    } finally {
      db.close();
    }
  });

  it('cleans a pre-0097 database before list projection columns are migrated', async () => {
    createLegacyCleanupFixture();
    const beforeBytes = estimateDbFilesBytes(dbFilePath);

    const outcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: request({ beforeBytes }),
      now: () => 3_000,
      log,
    });

    expect(outcome.result).toMatchObject({
      status: 'completed',
      archivedTaskCount: 1,
      messageCount: 1,
    });
    const db = createBetterSqliteDatabase(dbFilePath, { fileMustExist: true });
    try {
      expect(db.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 0 });
      expect(
        (db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      ).not.toContain('list_preview');
    } finally {
      db.close();
    }
  });

  it('keeps the untouched original as the latest default-directory slimming backup', async () => {
    createCleanupFixture();
    const beforeBytes = estimateDbFilesBytes(dbFilePath);

    const outcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: request({ beforeBytes, backupEnabled: true }),
      now: () => 3_000,
      log,
    });

    expect(outcome.result).toMatchObject({
      status: 'completed',
      backupCreated: true,
      backupLocation: 'database-directory',
    });
    const backupPath = `${dbFilePath}.slimming-backup`;
    const backup = createBetterSqliteDatabase(backupPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(backup.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 5 });
    } finally {
      backup.close();
    }
    expect(fs.existsSync(`${backupPath}.${REQUEST_ID}.previous`)).toBe(false);
  });

  it('rolls back a failed installed replacement exactly once', async () => {
    const backupPath = `${dbFilePath}.slimming-backup`;
    const previousPath = `${backupPath}.${REQUEST_ID}.previous`;
    createMarkerDatabase(backupPath, 'original');
    createMarkerDatabase(previousPath, 'older-slimming-backup');
    fs.writeFileSync(dbFilePath, 'not a sqlite database');

    const outcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: request({
        phase: 'replacement-installed',
        backupEnabled: true,
        beforeBytes: fs.statSync(dbFilePath).size,
      }),
      now: () => 3_000,
      log,
    });

    expect(outcome.result).toMatchObject({
      status: 'failed',
      reason: 'integrity-check-failed',
      originalDatabaseRestored: true,
    });
    expect(readMarker(dbFilePath)).toBe('original');
    expect(readMarker(backupPath)).toBe('older-slimming-backup');
  });

  it('does not reapply an older backup after rollback completes but marker cleanup fails', async () => {
    const backupPath = `${dbFilePath}.slimming-backup`;
    const previousPath = `${backupPath}.${REQUEST_ID}.previous`;
    createMarkerDatabase(backupPath, 'original');
    createMarkerDatabase(previousPath, 'older-slimming-backup');
    fs.writeFileSync(dbFilePath, 'not a sqlite database');
    const pending = request({
      phase: 'replacement-installed',
      backupEnabled: true,
      beforeBytes: fs.statSync(dbFilePath).size,
    });
    writeDbSlimmingRequest(tmpDir, pending);

    const requestPath = dbSlimmingRequestPath(tmpDir);
    const originalRmSync = fs.rmSync.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((candidate, options) => {
      if ([requestPath, `${requestPath}.bak`].includes(String(candidate))) {
        throw Object.assign(new Error('request marker is busy'), { code: 'EBUSY' });
      }
      return originalRmSync(candidate, options);
    });

    const firstOutcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: pending,
      now: () => 3_000,
      log,
    });

    expect(firstOutcome.result).toMatchObject({
      status: 'failed',
      reason: 'integrity-check-failed',
      originalDatabaseRestored: true,
    });
    const persisted = readDbSlimmingRequest(tmpDir);
    expect(persisted).toMatchObject({
      phase: 'rollback-completed',
      rollbackFailureReason: 'integrity-check-failed',
    });
    expect(readMarker(dbFilePath)).toBe('original');
    expect(readMarker(backupPath)).toBe('older-slimming-backup');

    rmSpy.mockRestore();
    const secondOutcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: persisted!,
      now: () => 4_000,
      log,
    });

    expect(secondOutcome.result).toMatchObject({
      status: 'failed',
      reason: 'integrity-check-failed',
      originalDatabaseRestored: true,
    });
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
    expect(readMarker(dbFilePath)).toBe('original');
    expect(readMarker(backupPath)).toBe('older-slimming-backup');
  });

  it('fails closed until a completed physical rollback can be persisted', async () => {
    const rollbackPath = `${dbFilePath}.slimming-${REQUEST_ID}.rollback`;
    const workPath = `${dbFilePath}.slimming-${REQUEST_ID}.work`;
    createMarkerDatabase(rollbackPath, 'original');
    fs.writeFileSync(dbFilePath, 'not a sqlite database');
    const pending = request({
      phase: 'replacement-installed',
      beforeBytes: fs.statSync(dbFilePath).size,
    });
    writeDbSlimmingRequest(tmpDir, pending);

    const requestPathPrefix = `${dbSlimmingRequestPath(tmpDir)}.`;
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((candidate, data, options) => {
      if (
        String(candidate).startsWith(requestPathPrefix) &&
        String(data).includes('"phase":"rollback-completed"')
      ) {
        throw Object.assign(new Error('rollback marker is unavailable'), { code: 'EACCES' });
      }
      return originalWriteFileSync(candidate, data, options);
    });

    const firstOutcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: pending,
      now: () => 3_000,
      log,
    });

    expect(firstOutcome).toMatchObject({
      originalDatabaseReady: false,
      result: {
        status: 'failed',
        reason: 'integrity-check-failed',
        originalDatabaseRestored: true,
      },
    });
    expect(readDbSlimmingRequest(tmpDir)).toMatchObject({ phase: 'replacement-installed' });
    expect(readMarker(dbFilePath)).toBe('original');
    expect(fs.existsSync(workPath)).toBe(true);

    writeSpy.mockRestore();
    const persisted = readDbSlimmingRequest(tmpDir)!;
    const secondOutcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: persisted,
      now: () => 4_000,
      log,
    });

    expect(secondOutcome).toMatchObject({
      originalDatabaseReady: true,
      result: {
        status: 'failed',
        reason: 'recovery-failed',
        originalDatabaseRestored: true,
      },
    });
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
    expect(readMarker(dbFilePath)).toBe('original');
    expect(fs.existsSync(workPath)).toBe(false);
  });

  it('keeps the rollback marker until occupied maintenance artifacts are removed', async () => {
    const rollbackPath = `${dbFilePath}.slimming-${REQUEST_ID}.rollback`;
    const workPath = `${dbFilePath}.slimming-${REQUEST_ID}.work`;
    createMarkerDatabase(rollbackPath, 'original');
    fs.writeFileSync(dbFilePath, 'not a sqlite database');
    const pending = request({
      phase: 'replacement-installed',
      beforeBytes: fs.statSync(dbFilePath).size,
    });
    writeDbSlimmingRequest(tmpDir, pending);

    const originalRmSync = fs.rmSync.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((candidate, options) => {
      if (String(candidate) === workPath) {
        throw Object.assign(new Error('rollback artifact is busy'), { code: 'EBUSY' });
      }
      return originalRmSync(candidate, options);
    });

    const firstOutcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: pending,
      now: () => 3_000,
      log,
    });

    expect(firstOutcome.result).toMatchObject({
      status: 'failed',
      reason: 'integrity-check-failed',
      originalDatabaseRestored: true,
    });
    expect(readDbSlimmingRequest(tmpDir)).toMatchObject({
      phase: 'rollback-completed',
      rollbackFailureReason: 'integrity-check-failed',
    });
    expect(fs.existsSync(workPath)).toBe(true);
    expect(readMarker(dbFilePath)).toBe('original');

    rmSpy.mockRestore();
    const persisted = readDbSlimmingRequest(tmpDir)!;
    const secondOutcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: persisted,
      now: () => 4_000,
      log,
    });

    expect(secondOutcome.result).toMatchObject({
      status: 'failed',
      reason: 'integrity-check-failed',
      originalDatabaseRestored: true,
    });
    expect(fs.existsSync(workPath)).toBe(false);
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
    expect(readMarker(dbFilePath)).toBe('original');
  });

  it('keeps a pre-replacement request until occupied working artifacts are removed', async () => {
    createLegacyCleanupFixture();
    const pending = request({ beforeBytes: estimateDbFilesBytes(dbFilePath) });
    writeDbSlimmingRequest(tmpDir, pending);
    const workPath = `${dbFilePath}.slimming-${REQUEST_ID}.work`;
    const originalRmSync = fs.rmSync.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((candidate, options) => {
      if (String(candidate) === workPath) {
        throw Object.assign(new Error('working artifact is busy'), { code: 'EBUSY' });
      }
      return originalRmSync(candidate, options);
    });

    const firstOutcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: pending,
      now: () => 3_000,
      log,
      beforeReplacement: vi.fn(async () => {
        throw new Error('stop before replacement');
      }),
    });

    expect(firstOutcome.result).toMatchObject({
      status: 'failed',
      reason: 'cleanup-failed',
      originalDatabaseRestored: true,
    });
    expect(readDbSlimmingRequest(tmpDir)).toMatchObject({ id: pending.id, phase: 'scheduled' });
    expect(fs.existsSync(workPath)).toBe(true);

    rmSpy.mockRestore();
    const persisted = readDbSlimmingRequest(tmpDir)!;
    const secondOutcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: persisted,
      now: () => 4_000,
      log,
    });

    expect(secondOutcome.result.status).toBe('completed');
    expect(fs.existsSync(workPath)).toBe(false);
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
  });

  it('fails closed when the scheduled source database is missing', async () => {
    const pending = request();
    writeDbSlimmingRequest(tmpDir, pending);

    const outcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: pending,
      now: () => 3_000,
      log,
    });

    expect(outcome).toMatchObject({
      originalDatabaseReady: false,
      result: {
        status: 'failed',
        reason: 'recovery-failed',
        originalDatabaseRestored: false,
      },
    });
    expect(fs.existsSync(dbFilePath)).toBe(false);
    expect(readDbSlimmingRequest(tmpDir)).toMatchObject({ id: pending.id, phase: 'scheduled' });
  });

  it('fails closed when an installed replacement has lost its original backup', async () => {
    createMarkerDatabase(dbFilePath, 'compacted-replacement');

    const outcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: request({
        phase: 'replacement-installed',
        backupEnabled: true,
        beforeBytes: fs.statSync(dbFilePath).size,
      }),
      now: () => 3_000,
      log,
    });

    expect(outcome).toMatchObject({
      originalDatabaseReady: false,
      result: {
        status: 'failed',
        reason: 'recovery-failed',
        originalDatabaseRestored: false,
      },
    });
    expect(readMarker(dbFilePath)).toBe('compacted-replacement');
  });

  it('rebuilds a missing result after the commit marker is durable', async () => {
    createMarkerDatabase(dbFilePath, 'committed-replacement');

    const outcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: request({
        phase: 'committed',
        beforeBytes: fs.statSync(dbFilePath).size,
      }),
      now: () => 3_000,
      log,
    });

    expect(outcome).toMatchObject({
      originalDatabaseReady: true,
      result: {
        status: 'completed',
        finishedAt: 3_000,
        backupCreated: false,
      },
    });
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
    expect(readMarker(dbFilePath)).toBe('committed-replacement');
  });

  it('keeps the rollback when a committed database is invalid despite a completed result', async () => {
    const rollbackPath = `${dbFilePath}.slimming-${REQUEST_ID}.rollback`;
    createMarkerDatabase(rollbackPath, 'original');
    fs.writeFileSync(dbFilePath, 'not a sqlite database');
    const pending = request({
      phase: 'committed',
      beforeBytes: fs.statSync(dbFilePath).size,
    });
    writeDbSlimmingRequest(tmpDir, pending);
    writeDbSlimmingResult(tmpDir, {
      id: pending.id,
      ownerId: pending.ownerId,
      status: 'completed',
      finishedAt: 2_500,
      archiveAgeMonths: pending.archiveAgeMonths,
      deletedTaskCount: 1,
      archivedTaskCount: 1,
      messageCount: 1,
      beforeBytes: pending.beforeBytes,
      afterBytes: pending.beforeBytes,
      reclaimedBytes: 0,
      backupCreated: false,
    });

    const outcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: pending,
      now: () => 3_000,
      log,
    });

    expect(outcome).toMatchObject({
      originalDatabaseReady: false,
      result: {
        status: 'failed',
        reason: 'recovery-failed',
        originalDatabaseRestored: false,
      },
    });
    expect(readDbSlimmingRequest(tmpDir)).toMatchObject({ phase: 'committed' });
    expect(readMarker(rollbackPath)).toBe('original');
  });

  it('keeps the committed marker until occupied maintenance artifacts are removed', async () => {
    createMarkerDatabase(dbFilePath, 'committed-replacement');
    const pending = request({
      phase: 'committed',
      beforeBytes: fs.statSync(dbFilePath).size,
    });
    writeDbSlimmingRequest(tmpDir, pending);
    const workPath = `${dbFilePath}.slimming-${REQUEST_ID}.work`;
    fs.writeFileSync(workPath, 'occupied maintenance artifact');

    const originalRmSync = fs.rmSync.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((candidate, options) => {
      if (String(candidate) === workPath) {
        throw Object.assign(new Error('maintenance artifact is busy'), { code: 'EBUSY' });
      }
      return originalRmSync(candidate, options);
    });

    const firstOutcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: pending,
      now: () => 3_000,
      log,
    });

    expect(firstOutcome.result.status).toBe('completed');
    expect(readDbSlimmingRequest(tmpDir)).toMatchObject({ phase: 'committed' });
    expect(fs.existsSync(workPath)).toBe(true);

    rmSpy.mockRestore();
    const persisted = readDbSlimmingRequest(tmpDir)!;
    const secondOutcome = await runDbSlimmingMaintenance({
      userDataDir: tmpDir,
      dbFilePath,
      request: persisted,
      now: () => 4_000,
      log,
    });

    expect(secondOutcome.result.status).toBe('completed');
    expect(fs.existsSync(workPath)).toBe(false);
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
  });
});

describe('discardCancelledDbSlimmingMaintenance', () => {
  it('does not complete cancellation while the request marker is occupied', () => {
    const pending = request();
    writeDbSlimmingRequest(tmpDir, pending);
    const requestPath = dbSlimmingRequestPath(tmpDir);
    const originalRmSync = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'rmSync').mockImplementation((candidate, options) => {
      if (String(candidate) === requestPath) {
        throw Object.assign(new Error('request marker is busy'), { code: 'EBUSY' });
      }
      return originalRmSync(candidate, options);
    });

    expect(() => discardCancelledDbSlimmingMaintenance(tmpDir, dbFilePath, pending)).toThrow(
      'database slimming request marker could not be cleared',
    );
    expect(readDbSlimmingRequest(tmpDir)).toMatchObject({ id: pending.id, phase: 'scheduled' });
  });
});

describe('adoptDbSlimmingBackup', () => {
  it('keeps only the latest slimming backup even when the user changes folders', () => {
    const firstDir = path.join(tmpDir, 'first');
    const secondDir = path.join(tmpDir, 'second');
    fs.mkdirSync(firstDir);
    fs.mkdirSync(secondDir);
    const first = path.join(firstDir, 'cindy-owner.db.slimming-backup');
    const second = path.join(secondDir, 'cindy-owner.db.slimming-backup');
    const migrationBackup = path.join(firstDir, 'cindy-owner.db.bak.2026-08-26T00-00-00-000Z');
    fs.writeFileSync(first, 'first');
    fs.writeFileSync(second, 'second');
    fs.writeFileSync(migrationBackup, 'migration');

    adoptDbSlimmingBackup(tmpDir, 'owner-1', first);
    adoptDbSlimmingBackup(tmpDir, 'owner-1', second);

    expect(fs.existsSync(first)).toBe(false);
    expect(fs.readFileSync(second, 'utf8')).toBe('second');
    expect(fs.readFileSync(migrationBackup, 'utf8')).toBe('migration');
  });
});
