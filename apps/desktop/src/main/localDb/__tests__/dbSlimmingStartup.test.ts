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
  it('discards a marker only when its JSON is confirmed invalid', async () => {
    fs.writeFileSync(path.join(tmpDir, 'db-slimming-request.json'), '{invalid', 'utf8');

    await expect(
      runPendingDbSlimmingAtStartup({
        userDataDir: tmpDir,
        dbFilePath,
        ownerId: 'owner-1',
        leaseKind: 'writer',
        loadVectorExtension: vi.fn(() => true),
        log,
      }),
    ).resolves.toEqual({ handled: false, originalDatabaseReady: true });

    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
  });

  it('preserves the marker and fails closed when the marker cannot be read', async () => {
    const pending = request();
    writeDbSlimmingRequest(tmpDir, pending);
    const readError = Object.assign(new Error('marker is temporarily locked'), { code: 'EACCES' });

    await expect(
      runPendingDbSlimmingAtStartup({
        userDataDir: tmpDir,
        dbFilePath,
        ownerId: pending.ownerId,
        leaseKind: 'writer',
        loadVectorExtension: vi.fn(() => true),
        log,
        readRequest: () => {
          throw readError;
        },
      }),
    ).rejects.toBe(readError);

    expect(readDbSlimmingRequest(tmpDir)).toEqual(pending);
  });

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

  it('does not consume a reader-lease request while its marker is occupied', async () => {
    const pending = request();
    writeDbSlimmingRequest(tmpDir, pending);
    const requestPath = path.join(tmpDir, 'db-slimming-request.json');
    const originalRmSync = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'rmSync').mockImplementation((candidate, options) => {
      if (String(candidate) === requestPath) {
        throw Object.assign(new Error('request marker is busy'), { code: 'EBUSY' });
      }
      return originalRmSync(candidate, options);
    });
    const runMaintenance = vi.fn();

    await expect(
      runPendingDbSlimmingAtStartup({
        userDataDir: tmpDir,
        dbFilePath,
        ownerId: pending.ownerId,
        leaseKind: 'reader',
        loadVectorExtension: vi.fn(() => true),
        log,
        runMaintenance,
      }),
    ).rejects.toThrow('database slimming request marker could not be cleared');

    expect(runMaintenance).not.toHaveBeenCalled();
    expect(readDbSlimmingRequest(tmpDir)).toEqual(pending);
    expect(readDbSlimmingResult(tmpDir)).toMatchObject({
      id: pending.id,
      status: 'failed',
      reason: 'database-in-use',
    });
  });

  it('keeps the request scheduled when the reader in-use result cannot be persisted', async () => {
    const pending = request();
    writeDbSlimmingRequest(tmpDir, pending);
    const resultPathPrefix = `${path.join(tmpDir, 'db-slimming-result.json')}.`;
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((candidate, data, options) => {
      if (String(candidate).startsWith(resultPathPrefix)) {
        throw Object.assign(new Error('result marker is unavailable'), { code: 'EACCES' });
      }
      return originalWriteFileSync(candidate, data, options);
    });
    const runMaintenance = vi.fn();

    const outcome = await runPendingDbSlimmingAtStartup({
      userDataDir: tmpDir,
      dbFilePath,
      ownerId: pending.ownerId,
      leaseKind: 'reader',
      loadVectorExtension: vi.fn(() => true),
      log,
      runMaintenance,
    });

    expect(runMaintenance).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      handled: true,
      originalDatabaseReady: true,
      result: { status: 'failed', reason: 'database-in-use' },
    });
    expect(readDbSlimmingRequest(tmpDir)).toEqual(pending);
    expect(readDbSlimmingResult(tmpDir)).toBeNull();
  });

  it.each([
    ['swap-prepared', undefined],
    ['replacement-installed', undefined],
    ['rollback-completed', 'replacement-failed'],
    ['committed', undefined],
  ] as const)('preserves a %s recovery marker when only a reader lease is available', async (
    phase,
    rollbackFailureReason,
  ) => {
    const pending = request({
      phase,
      ...(rollbackFailureReason ? { rollbackFailureReason } : {}),
    });
    writeDbSlimmingRequest(tmpDir, pending);
    const runMaintenance = vi.fn();

    await expect(
      runPendingDbSlimmingAtStartup({
        userDataDir: tmpDir,
        dbFilePath,
        ownerId: pending.ownerId,
        leaseKind: 'reader',
        loadVectorExtension: vi.fn(() => true),
        log,
        runMaintenance,
      }),
    ).rejects.toThrow('database slimming recovery requires the writer lease');

    expect(runMaintenance).not.toHaveBeenCalled();
    expect(readDbSlimmingRequest(tmpDir)).toEqual(pending);
    expect(readDbSlimmingResult(tmpDir)).toBeNull();
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

  it('does not continue startup after a utility process failure while its request is occupied', async () => {
    const pending = request();
    writeDbSlimmingRequest(tmpDir, pending);
    const requestPath = path.join(tmpDir, 'db-slimming-request.json');
    const originalRmSync = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'rmSync').mockImplementation((candidate, options) => {
      if (String(candidate) === requestPath) {
        throw Object.assign(new Error('request marker is busy'), { code: 'EBUSY' });
      }
      return originalRmSync(candidate, options);
    });

    await expect(
      runPendingDbSlimmingAtStartup({
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
      }),
    ).rejects.toThrow('database slimming request marker could not be cleared');

    expect(readDbSlimmingRequest(tmpDir)).toEqual(pending);
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

  it('does not report cancellation complete while the request marker is occupied', async () => {
    const pending = request();
    writeDbSlimmingRequest(tmpDir, pending);
    const requestPath = path.join(tmpDir, 'db-slimming-request.json');
    const originalRmSync = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'rmSync').mockImplementation((candidate, options) => {
      if (String(candidate) === requestPath) {
        throw Object.assign(new Error('request marker is busy'), { code: 'EBUSY' });
      }
      return originalRmSync(candidate, options);
    });

    await expect(
      runPendingDbSlimmingAtStartup({
        userDataDir: tmpDir,
        dbFilePath,
        ownerId: pending.ownerId,
        leaseKind: 'writer',
        loadVectorExtension: vi.fn(() => true),
        log,
        runMaintenance: vi.fn(async () => {
          throw new DbSlimmingCancelledError();
        }),
      }),
    ).rejects.toThrow('database slimming request marker could not be cleared');

    expect(readDbSlimmingRequest(tmpDir)).toMatchObject({ id: pending.id, phase: 'scheduled' });
    expect(getDbSlimmingStartupProgress()).toBeNull();
  });
});
