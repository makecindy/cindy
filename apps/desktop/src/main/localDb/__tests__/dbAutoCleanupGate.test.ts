import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __testing as settingsTesting } from '../../db-auto-cleanup-settings';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import {
  createAutoCleanupRequest,
  evaluateDbAutoCleanupGate,
  scanDbAutoCleanupCandidates,
  type DbAutoCleanupCandidate,
} from '../dbAutoCleanupGate';
import { readDbSlimmingRequest, writeDbSlimmingRequest } from '../maintenanceStore';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;
const CUTOFF = NOW - RETENTION_DAYS * DAY_MS;

const SETTINGS = {
  ...settingsTesting.DEFAULTS,
  // The gate is only reachable once a run is switched on; the shipped default is
  // off, so every non-disabled case states that explicitly.
  enabled: true,
  retentionDays: RETENTION_DAYS,
} as const;

let tmpDir: string;
let dbFilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-auto-cleanup-gate-'));
  dbFilePath = path.join(tmpDir, 'cindy-owner.db');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function candidate(overrides: Partial<DbAutoCleanupCandidate> = {}): DbAutoCleanupCandidate {
  return {
    deletedTaskCount: 3,
    messageCount: 5_000,
    estimatedMessageBytes: 30 * 1024 * 1024,
    databaseBytes: 100 * 1024 * 1024,
    requiredFreeBytes: 364 * 1024 * 1024,
    databaseVolumeFreeBytes: 10 * 1024 * 1024 * 1024,
    ...overrides,
  };
}

describe('evaluateDbAutoCleanupGate', () => {
  it.each([
    ['disabled setting', { settings: { ...SETTINGS, enabled: false } }, 'disabled'],
    ['unprobeable database', { candidate: null }, 'no-targets'],
    ['no deleted sessions', { candidate: candidate({ deletedTaskCount: 0 }) }, 'no-targets'],
    [
      'deleted sessions without messages',
      { candidate: candidate({ messageCount: 0 }) },
      'no-targets',
    ],
    [
      'small history',
      { candidate: candidate({ messageCount: 10, estimatedMessageBytes: 1024 }) },
      'below-threshold',
    ],
    [
      'cooldown still running',
      { settings: { ...SETTINGS, lastAutoRunAt: NOW - 6 * DAY_MS } },
      'cooldown',
    ],
    [
      'clock moved backwards',
      { settings: { ...SETTINGS, lastAutoRunAt: NOW + DAY_MS } },
      'cooldown',
    ],
    [
      'not enough free space',
      { candidate: candidate({ databaseVolumeFreeBytes: 364 * 1024 * 1024 - 1 }) },
      'insufficient-space',
    ],
    [
      'free space unknown',
      { candidate: candidate({ databaseVolumeFreeBytes: null }) },
      'insufficient-space',
    ],
  ] as const)('skips on %s', (_label, overrides, reason) => {
    const settings = 'settings' in overrides ? overrides.settings : SETTINGS;
    const measured = 'candidate' in overrides ? overrides.candidate : candidate();

    expect(evaluateDbAutoCleanupGate({ settings, candidate: measured, now: NOW })).toEqual({
      run: false,
      reason,
    });
  });

  it('runs once the history is large enough, the cooldown elapsed and space is free', () => {
    // Either threshold is enough: a few huge messages are worth cleaning too.
    const measured = candidate({ messageCount: 10, estimatedMessageBytes: 30 * 1024 * 1024 });
    expect(
      evaluateDbAutoCleanupGate({ settings: SETTINGS, candidate: measured, now: NOW }),
    ).toEqual({
      run: true,
      candidate: measured,
    });

    const afterCooldown = { ...SETTINGS, lastAutoRunAt: NOW - 7 * DAY_MS };
    expect(
      evaluateDbAutoCleanupGate({ settings: afterCooldown, candidate: candidate(), now: NOW }),
    ).toEqual({ run: true, candidate: candidate() });

    const exactlyEnoughSpace = candidate({ databaseVolumeFreeBytes: 364 * 1024 * 1024 });
    expect(
      evaluateDbAutoCleanupGate({
        settings: SETTINGS,
        candidate: exactlyEnoughSpace,
        now: NOW,
      }),
    ).toEqual({ run: true, candidate: exactlyEnoughSpace });
  });
});

describe('scanDbAutoCleanupCandidates', () => {
  function createFixture(): void {
    const db = createBetterSqliteDatabase(dbFilePath);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL
      );
    `);
    const insertSession = db.prepare(
      'INSERT INTO sessions (id, status, updated_at) VALUES (?, ?, ?)',
    );
    const insertMessage = db.prepare(
      'INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)',
    );
    for (const [id, status, updatedAt] of [
      ['deleted-old', 'deleted', CUTOFF - 1_000],
      ['deleted-boundary', 'deleted', CUTOFF],
      ['deleted-recent', 'deleted', CUTOFF + 1],
      ['archived-old', 'archived', CUTOFF - 1_000],
      ['active-old', 'active', CUTOFF - 1_000],
    ] as const) {
      insertSession.run(id, status, updatedAt);
      insertMessage.run(`message-${id}`, id, 'user', 'x'.repeat(100));
    }
    // A deleted session whose history is already gone is not a cleanup target.
    insertSession.run('deleted-empty', 'deleted', CUTOFF - 1_000);
    db.close();
  }

  it('measures only deleted sessions inside the retention window', () => {
    createFixture();

    const measured = scanDbAutoCleanupCandidates({ dbFilePath, cutoffMs: CUTOFF });

    // Archived tasks are the reason `targetStatuses` exists: they share the same
    // cutoff, and an automatic run must never purge their history.
    expect(measured).toMatchObject({
      deletedTaskCount: 2,
      messageCount: 2,
      databaseVolumeFreeBytes: expect.any(Number),
    });
    expect(measured!.estimatedMessageBytes).toBeGreaterThanOrEqual(2 * 100);
    expect(measured!.requiredFreeBytes).toBeGreaterThan(measured!.databaseBytes * 3);
  });

  it('returns no candidate when the database cannot be opened', () => {
    fs.writeFileSync(dbFilePath, 'not a database', 'utf8');

    expect(scanDbAutoCleanupCandidates({ dbFilePath, cutoffMs: CUTOFF })).toBeNull();
    expect(
      scanDbAutoCleanupCandidates({
        dbFilePath: path.join(tmpDir, 'missing.db'),
        cutoffMs: CUTOFF,
      }),
    ).toBeNull();
  });
});

describe('createAutoCleanupRequest', () => {
  it('produces a marker the startup reader accepts and that only purges deleted tasks', () => {
    const measured = candidate();
    const request = createAutoCleanupRequest({
      ownerId: 'owner-1',
      now: NOW,
      settings: SETTINGS,
      candidate: measured,
    });

    expect(request).toMatchObject({
      version: 1,
      ownerId: 'owner-1',
      createdAt: NOW,
      scannedAt: NOW,
      archivedBeforeMs: CUTOFF,
      // 30 days cannot be stored as `30`; the reader rejects it.
      archiveAgeMonths: 1,
      targetStatuses: ['deleted'],
      includeActiveTasks: false,
      deletedTaskCount: 3,
      archivedTaskCount: 0,
      messageCount: 5_000,
      beforeBytes: 100 * 1024 * 1024,
      backupEnabled: true,
      phase: 'scheduled',
    });

    writeDbSlimmingRequest(tmpDir, request);
    expect(readDbSlimmingRequest(tmpDir)).toEqual(request);
  });
});
