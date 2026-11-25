import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DB_SLIMMING_SCAN_TIMEOUT_MS, scanDbSlimmingPreview } from '../dbSlimmingScan';
import { acquireSchemaMigrationWriterLease } from '../schemaMigrationLease';
import { readLeasedDbSlimmingPreview, readDbSlimmingPreview } from '../dbSlimmingScanQuery';
import { DB_SLIMMING_WORKER_TERMINATION_TIMEOUT_MS } from '../dbSlimmingWorkerClient';
const moduleEntry = createRequire(import.meta.url).resolve('better-sqlite3');

// Test value (#11628), db tier: the new read-only worker must read committed WAL data,
// preserve the preview scope/UTF-8 byte counts, and release its connection on failure.
// Existing maintenance handler mocks cannot cover SQLite loading or worker shutdown.
// Minimal fixture: one message per status/age branch, plus an empty task.
let dir: string;
let dbFilePath: string;
let db: Database.Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-scan-'));
  dbFilePath = path.join(dir, 'owner.db');
  db = new Database(dbFilePath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY, status TEXT, updated_at INTEGER);
    CREATE TABLE messages(id TEXT, session_id TEXT, client_id TEXT, role TEXT,
      content TEXT, tool_use_id TEXT, agent_meta TEXT, agent_kind TEXT);
    CREATE INDEX messages_session_id ON messages(session_id);
    INSERT INTO sessions VALUES ('d', 'deleted', 100), ('r', 'archived', 100),
      ('a', 'active', 100), ('new', 'deleted', 101), ('empty', 'archived', 0);
  `);
  const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const id of ['d', 'r', 'a', 'new']) {
    insert.run(id, id, 'client', 'assistant', '中文😀', null, '{"x":1}', 'codex');
  }
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  // Windows also proves the worker no longer holds the database when the call settles.
  fs.rmSync(dir, { recursive: true, force: true });
});

class ScanProcess extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn(() => true);
}

function input() {
  return { ...options(), moduleEntry };
}

function options() {
  return {
    dbFilePath,
    archivedBeforeMs: 100,
    includeActiveTasks: false,
    isOwnerCurrent: () => true,
  };
}

describe('isolated read-only database scan', () => {
  it('excludes a preview while replacement owns the same database and releases its lease afterward', async () => {
    const writer = await acquireSchemaMigrationWriterLease(dbFilePath);
    if (!writer.acquired) throw new Error('fixture could not acquire writer lease');
    try {
      await expect(readLeasedDbSlimmingPreview(input())).rejects.toThrow('lease unavailable');
    } finally {
      writer.lease.release();
    }
    await expect(readLeasedDbSlimmingPreview(input())).resolves.toMatchObject({ messageCount: 2 });
    const nextWriter = await acquireSchemaMigrationWriterLease(dbFilePath);
    expect(nextWriter.acquired).toBe(true);
    if (nextWriter.acquired) nextWriter.lease.release();
  });

  it('delivers a queued corruption report even after cancellation has requested termination', async () => {
    const child = new ScanProcess();
    const controller = new AbortController();
    const onDatabaseError = vi.fn();
    const result = scanDbSlimmingPreview({ ...options(), signal: controller.signal, onDatabaseError }, () => child);
    child.emit('message', { type: 'ready' });
    controller.abort();
    child.emit('message', { type: 'error', error: { code: 'SQLITE_CORRUPT', message: 'bad page' } });
    expect(onDatabaseError).toHaveBeenCalledWith(expect.objectContaining({ code: 'SQLITE_CORRUPT' }));
    child.emit('exit', 0);
    await expect(result).rejects.toThrow('cancelled');
  });

  it('reads committed WAL rows with the original cutoff, task scope and UTF-8 estimates', async () => {
    const bytesPerMessage = ['d', 'client', 'assistant', '中文😀', '{"x":1}', 'codex'].reduce(
      (total, value) => total + Buffer.byteLength(value),
      0,
    );
    expect(readDbSlimmingPreview(input())).toEqual({
      activeTaskCount: 0,
      deletedTaskCount: 1,
      archivedTaskCount: 1,
      messageCount: 2,
      estimatedMessageBytes: bytesPerMessage * 2,
    });
    expect(readDbSlimmingPreview({ ...input(), includeActiveTasks: true })).toEqual({
      activeTaskCount: 1,
      deletedTaskCount: 1,
      archivedTaskCount: 1,
      messageCount: 3,
      estimatedMessageBytes: bytesPerMessage * 3,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 4 });
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('does not create a missing database and releases a connection after SQL failure', async () => {
    const missing = path.join(dir, 'missing.db');
    expect(() => readDbSlimmingPreview({ ...input(), dbFilePath: missing })).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
    db.exec('DROP TABLE messages');
    expect(() => readDbSlimmingPreview(input())).toThrow('no such table: messages');
    // A new request still works after the failed worker, without repairing or migrating the DB.
    db.exec(`CREATE TABLE messages(id TEXT, session_id TEXT, client_id TEXT, role TEXT,
      content TEXT, tool_use_id TEXT, agent_meta TEXT, agent_kind TEXT)`);
    expect(readDbSlimmingPreview(input())).toMatchObject({ messageCount: 0 });
  });

  it('stops an in-flight scan when its captured owner is no longer current', async () => {
    vi.useFakeTimers();
    let current = true;
    const child = new ScanProcess();
    const result = scanDbSlimmingPreview(
      { ...options(), isOwnerCurrent: () => current },
      () => child,
    );
    child.emit('message', { type: 'ready' });
    const failure = expect(result).rejects.toThrow('owner changed');
    current = false;
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('exit', 1);
    await failure;
  });

  it('terminates a scan at its own deadline instead of the ordinary RPC budget', async () => {
    vi.useFakeTimers();
    const child = new ScanProcess();
    const result = scanDbSlimmingPreview(options(), () => child);
    child.emit('message', { type: 'ready' });
    const failure = expect(result).rejects.toThrow('timed out');
    vi.advanceTimersByTime(DB_SLIMMING_SCAN_TIMEOUT_MS);
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('exit', 1);
    await failure;
  });
  it('holds admission until actual exit, even when killing the reader cannot be confirmed', async () => {
    vi.useFakeTimers();
    const child = new ScanProcess();
    const result = scanDbSlimmingPreview(options(), () => child);
    const failure = expect(result).rejects.toThrow('termination was not confirmed');
    child.emit('message', { type: 'ready' });
    vi.advanceTimersByTime(DB_SLIMMING_SCAN_TIMEOUT_MS + DB_SLIMMING_WORKER_TERMINATION_TIMEOUT_MS);
    await failure;
    await expect(scanDbSlimmingPreview(options(), () => new ScanProcess())).rejects.toThrow(
      'still stopping',
    );
    child.emit('exit', 1);
    const retry = new ScanProcess();
    const next = scanDbSlimmingPreview(options(), () => retry);
    retry.emit('message', { type: 'ready' });
    retry.emit('message', { type: 'scan-result', row: { messageCount: 0 } });
    retry.emit('exit', 0);
    await expect(next).resolves.toMatchObject({ messageCount: 0 });
  });

  it('sends only the captured scan scope and waits for reader exit before publishing statistics', async () => {
    const child = new ScanProcess();
    const result = scanDbSlimmingPreview(options(), () => child);
    child.emit('message', { type: 'ready' });
    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'scan',
      input: {
        dbFilePath,
        archivedBeforeMs: 100,
        includeActiveTasks: false,
        moduleEntry,
        nativeBinding: undefined,
      },
    });
    const row = readDbSlimmingPreview(input());
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    child.emit('message', { type: 'scan-result', row });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('exit', 0);
    await expect(result).resolves.toEqual(row);
  });

  it('fails visibly on reader startup or SQL failure and permits a fresh scan after exit', async () => {
    for (const event of ['error', 'exit'] as const) {
      const child = new ScanProcess();
      const result = scanDbSlimmingPreview(options(), () => child);
      const failure = expect(result).rejects.toThrow();
      if (event === 'error') {
        child.emit('message', { type: 'error', error: { message: 'read failed' } });
        expect(child.kill).toHaveBeenCalledTimes(1);
      }
      child.emit('exit', 1);
      await failure;
    }
  });
});
