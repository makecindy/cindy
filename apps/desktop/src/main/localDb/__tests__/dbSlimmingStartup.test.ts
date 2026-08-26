import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runPendingDbSlimmingAtStartup } from '../dbSlimmingStartup';
import {
  DbSlimmingCancelledError,
  DbSlimmingWorkerPreReplacementError,
  DbSlimmingWorkerStartupError,
} from '../dbSlimmingWorkerClient';
import {
  cancelDbSlimmingStartupProgress,
  getDbSlimmingStartupProgress,
} from '../dbSlimmingStartupState';
import {
  readDbSlimmingRequest,
  readDbSlimmingResult,
  type DbSlimmingRequestRecord,
  writeDbSlimmingRequest,
} from '../maintenanceStore';

const REQUEST_ID = '9c5c7e99-6a6a-4d21-9152-4034a4959490';

let tmpDir: string;
let dbFilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-slimming-startup-'));
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
    deletedTaskCount: 1,
    archivedTaskCount: 2,
    messageCount: 3,
    beforeBytes: 4_096,
    backupEnabled: true,
    phase: 'scheduled',
    ...overrides,
  };
}

const log = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

describe('runPendingDbSlimmingAtStartup', () => {
  it('leaves another owner request untouched and never opens that owner database', async () => {
    const pending = request();
    writeDbSlimmingRequest(tmpDir, pending);
    const runMaintenance = vi.fn();

    const outcome = await runPendingDbSlimmingAtStartup({
      userDataDir: tmpDir,
      dbFilePath: path.join(tmpDir, 'cindy-owner-2.db'),
      ownerId: 'owner-2',
      leaseKind: 'writer',
      loadVectorExtension: vi.fn(() => true),
      log,
      runMaintenance,
    });

    expect(outcome).toEqual({ handled: false, originalDatabaseReady: true });
    expect(runMaintenance).not.toHaveBeenCalled();
    expect(readDbSlimmingRequest(tmpDir)).toEqual(pending);
  });

  it('runs the pending request only while holding the writer lease', async () => {
    const pending = request();
    writeDbSlimmingRequest(tmpDir, pending);
    const completed = {
      id: pending.id,
      ownerId: pending.ownerId,
      status: 'completed' as const,
      finishedAt: 3_000,
      archiveAgeMonths: 3 as const,
      deletedTaskCount: 1,
      archivedTaskCount: 2,
      messageCount: 3,
      beforeBytes: 4_096,
      afterBytes: 2_048,
      reclaimedBytes: 2_048,
      backupCreated: true,
      backupLocation: 'database-directory' as const,
      backupPath: `${dbFilePath}.slimming-backup`,
    };
    const runMaintenance = vi.fn(async () => ({
      result: completed,
      originalDatabaseReady: true,
    }));

    const outcome = await runPendingDbSlimmingAtStartup({
      userDataDir: tmpDir,
      dbFilePath,
      ownerId: pending.ownerId,
      leaseKind: 'writer',
      loadVectorExtension: vi.fn(() => true),
      log,
      runMaintenance,
    });

    expect(runMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        userDataDir: tmpDir,
        dbFilePath,
        request: pending,
      }),
    );
    expect(outcome).toEqual({
      handled: true,
      result: completed,
      originalDatabaseReady: true,
    });
  });

  it('records database-in-use without running maintenance for a reader lease', async () => {
    writeDbSlimmingRequest(tmpDir, request());
    const runMaintenance = vi.fn();

    const outcome = await runPendingDbSlimmingAtStartup({
      userDataDir: tmpDir,
      dbFilePath,
      ownerId: 'owner-1',
      leaseKind: 'reader',
      loadVectorExtension: vi.fn(() => true),
      log,
      now: () => 3_000,
      runMaintenance,
    });

    expect(runMaintenance).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      handled: true,
      originalDatabaseReady: true,
      result: {
        status: 'failed',
        reason: 'database-in-use',
        originalDatabaseRestored: true,
      },
    });
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
    expect(readDbSlimmingResult(tmpDir)).toMatchObject({
      ownerId: 'owner-1',
      status: 'failed',
      reason: 'database-in-use',
    });
  });

  it('propagates an unrecoverable maintenance outcome so startup can fail closed', async () => {
    const pending = request();
    writeDbSlimmingRequest(tmpDir, pending);
    const failed = {
      id: pending.id,
      ownerId: pending.ownerId,
      status: 'failed' as const,
      finishedAt: 3_000,
      archiveAgeMonths: 3 as const,
      reason: 'recovery-failed' as const,
      originalDatabaseRestored: false,
    };

    const outcome = await runPendingDbSlimmingAtStartup({
      userDataDir: tmpDir,
      dbFilePath,
      ownerId: pending.ownerId,
      leaseKind: 'writer',
      loadVectorExtension: vi.fn(() => true),
      log,
      runMaintenance: vi.fn(async () => ({
        result: failed,
        originalDatabaseReady: false,
      })),
    });

    expect(outcome).toEqual({
      handled: true,
      result: failed,
      originalDatabaseReady: false,
    });
  });

  it('records and clears a worker startup failure before any database work begins', async () => {
    const pending = request();
    writeDbSlimmingRequest(tmpDir, pending);

    const outcome = await runPendingDbSlimmingAtStartup({
      userDataDir: tmpDir,
      dbFilePath,
      ownerId: pending.ownerId,
      leaseKind: 'writer',
      loadVectorExtension: vi.fn(() => true),
      log,
      now: () => 3_000,
      runMaintenance: vi.fn(async () => {
        throw new DbSlimmingWorkerStartupError('bundle missing');
      }),
    });

    expect(outcome).toMatchObject({
      handled: true,
      originalDatabaseReady: true,
      result: {
        status: 'failed',
        reason: 'cleanup-failed',
        originalDatabaseRestored: true,
      },
    });
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
    expect(readDbSlimmingResult(tmpDir)).toMatchObject({
      id: pending.id,
      status: 'failed',
      reason: 'cleanup-failed',
    });
  });

  it('continues startup after a utility process failure before replacement', async () => {
    const pending = request();
    writeDbSlimmingRequest(tmpDir, pending);

    const outcome = await runPendingDbSlimmingAtStartup({
      userDataDir: tmpDir,
      dbFilePath,
      ownerId: pending.ownerId,
      leaseKind: 'writer',
      loadVectorExtension: vi.fn(() => true),
      log,
      now: () => 3_000,
      runMaintenance: vi.fn(async () => {
        throw new DbSlimmingWorkerPreReplacementError('utility process crashed');
      }),
    });

    expect(outcome).toMatchObject({
      handled: true,
      originalDatabaseReady: true,
      result: {
        status: 'failed',
        reason: 'cleanup-failed',
        originalDatabaseRestored: true,
      },
    });
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
    expect(readDbSlimmingResult(tmpDir)).toMatchObject({
      id: pending.id,
      status: 'failed',
      reason: 'cleanup-failed',
    });
  });

  it('discards the working copy and continues startup when the user cancels', async () => {
    const pending = request();
    writeDbSlimmingRequest(tmpDir, pending);

    const outcome = await runPendingDbSlimmingAtStartup({
      userDataDir: tmpDir,
      dbFilePath,
      ownerId: pending.ownerId,
      leaseKind: 'writer',
      loadVectorExtension: vi.fn(() => true),
      log,
      runMaintenance: vi.fn(async (options) => {
        options.onProgress?.({ phase: 'cleaning', progress: 52, cancellable: true });
        expect(cancelDbSlimmingStartupProgress()).toBe(true);
        expect(options.signal?.aborted).toBe(true);
        throw new DbSlimmingCancelledError();
      }),
    });

    expect(outcome).toEqual({ handled: false, originalDatabaseReady: true });
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
    expect(getDbSlimmingStartupProgress()).toBeNull();
  });
});
