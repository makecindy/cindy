import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbClient } from '../client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current.js';
import {
  claimOwnedProvisionalSession,
  configureProvisionalSessions,
  deleteUnsentSessionRow,
  isProvisionalSession,
  markProvisionalSession,
  removeEmptyDialogueDir,
  resetProvisionalSessionsForTest,
  sweepLeftoverProvisionalSessions,
} from '../provisionalSessions.js';
import * as schema from '../schema.js';

describe('provisional sessions', () => {
  let rawDb: Database.Database | null = null;
  let detach: (() => void) | null = null;
  let userData = '';

  beforeEach(() => {
    resetProvisionalSessionsForTest();
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'provisional-sessions-'));
  });

  afterEach(() => {
    detach?.();
    detach = null;
    rawDb?.close();
    rawDb = null;
    fs.rmSync(userData, { recursive: true, force: true });
  });

  function openDb(): Database.Database {
    const db = new Database(':memory:');
    rawDb = db;
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_kind TEXT,
        working_dir TEXT,
        user_send_at INTEGER
      );
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    `);
    const client = {
      query: async () => [],
      queryOne: async () => undefined,
      exec: async () => ({ changes: 0 }) as never,
      tx: async () => {
        throw new Error('unused');
      },
      drizzle: drizzle(db, { schema }),
      vecAvailable: false,
      dispose: async () => {},
    } as DbClient;
    setCurrentDbClient(client, 'user-a');
    detach = () => clearCurrentDbClient(client);
    return db;
  }

  const rowExists = (db: Database.Database, id: string) =>
    !!db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);

  it('remembers unsent tasks across a restart and deletes the ones that were never sent', async () => {
    configureProvisionalSessions(userData);
    const dialogueDir = path.join(userData, 'dialogues', 'unsent');
    markProvisionalSession('unsent', 1_000, dialogueDir);
    markProvisionalSession('sent-later', 1_000);
    // Opened with a caller-chosen folder: the row goes, the folder is never Cindy's to remove.
    markProvisionalSession('explicit', 1_000);
    expect(isProvisionalSession('unsent')).toBe(true);

    // Next launch: the in-memory registry is gone, the file is not.
    resetProvisionalSessionsForTest();
    const db = openDb();
    fs.mkdirSync(dialogueDir, { recursive: true });
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('unsent', 'dialogue', dialogueDir, null);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('sent-later', 'project', '/repo', 2_000);
    const explicitDir = path.join(userData, 'elsewhere', 'explicit');
    fs.mkdirSync(explicitDir, { recursive: true });
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('explicit', 'dialogue', explicitDir, null);
    configureProvisionalSessions(userData);
    // Until swept, a leftover still counts as unsent (hidden from controllers).
    expect(isProvisionalSession('unsent')).toBe(true);
    await expect(sweepLeftoverProvisionalSessions(5_000)).resolves.toEqual(['unsent', 'explicit']);
    expect(fs.existsSync(explicitDir)).toBe(true);
    expect(isProvisionalSession('unsent')).toBe(false);

    expect(rowExists(db, 'unsent')).toBe(false);
    expect(fs.existsSync(dialogueDir)).toBe(false);
    // Already sent: an ordinary task now, never deleted.
    expect(rowExists(db, 'sent-later')).toBe(true);
    expect(fs.existsSync(path.join(userData, 'provisional-sessions.json'))).toBe(false);
  });

  it('keeps entries of another account until that account sweeps them', async () => {
    configureProvisionalSessions(userData);
    markProvisionalSession('other-account', 1_000);
    resetProvisionalSessionsForTest();
    openDb();
    configureProvisionalSessions(userData);
    await sweepLeftoverProvisionalSessions(2_000);
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'provisional-sessions.json'), 'utf8'));
    expect(saved.entries.map((entry: { id: string }) => entry.id)).toEqual(['other-account']);
  });

  it('after an account switch, leaves the old account\'s unsent task for that account to clean up', async () => {
    configureProvisionalSessions(userData);
    openDb();
    markProvisionalSession('from-a', 1_000);
    detach?.();
    openDb(); // account B
    expect(claimOwnedProvisionalSession('from-a')).toBe('foreign');
    // Still hidden from controllers, and kept on disk for account A's next sweep.
    expect(isProvisionalSession('from-a')).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'provisional-sessions.json'), 'utf8'));
    expect(saved.entries.map((entry: { id: string }) => entry.id)).toEqual(['from-a']);
  });

  it('only hard-deletes a task that is still unsent and has no messages', async () => {
    const db = openDb();
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('empty', 'project', '/repo', null);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('has-message', 'project', '/repo', null);
    db.prepare('INSERT INTO messages VALUES (?, ?)').run('m1', 'has-message');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('sent', 'project', '/repo', 10);

    await expect(deleteUnsentSessionRow('empty')).resolves.toMatchObject({ workingDir: '/repo' });
    await expect(deleteUnsentSessionRow('has-message')).resolves.toBeNull();
    await expect(deleteUnsentSessionRow('sent')).resolves.toBeNull();
    expect(rowExists(db, 'empty')).toBe(false);
    expect(rowExists(db, 'has-message')).toBe(true);
    expect(rowExists(db, 'sent')).toBe(true);
  });

  it('leaves a dialogue folder alone once something was written into it', async () => {
    const dir = path.join(userData, 'dialogues', 'task-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.md'), 'x');
    removeEmptyDialogueDir('task-1', dir);
    expect(fs.existsSync(dir)).toBe(true);
    // Never touches a folder that is not this task's own.
    const shared = path.join(userData, 'shared');
    fs.mkdirSync(shared);
    removeEmptyDialogueDir('task-1', shared);
    expect(fs.existsSync(shared)).toBe(true);
  });
});
