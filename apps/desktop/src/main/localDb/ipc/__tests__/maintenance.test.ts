import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../../client/DbClient';
import { archiveCutoffForAge, createLocalDbMaintenanceIpcHandlers } from '../maintenance';
import {
  readDbSlimmingRequest,
  writeDbSlimmingRequest,
  writeDbSlimmingResult,
} from '../../maintenanceStore';

let tmpDir: string;
let dbFilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-maintenance-ipc-'));
  dbFilePath = path.join(tmpDir, 'cindy-owner.db');
  fs.writeFileSync(dbFilePath, 'database-bytes');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createHarness() {
  let owner = { ownerId: 'owner-1', scopeKey: 'scope-1' };
  let dbClientOwnerId: string | null = owner.ownerId;
  let canSchedule = true;
  const queryOne = vi.fn(async () => ({
    activeTaskCount: 0,
    deletedTaskCount: 1,
    archivedTaskCount: 2,
    messageCount: 3,
    estimatedMessageBytes: 4_096,
  }));
  const selectBackupDirectory = vi.fn(async () => path.join(tmpDir, 'backups'));
  const confirmActiveTaskCleanup = vi.fn(async () => true);
  const confirmWithoutBackup = vi.fn(async () => true);
  const revealFile = vi.fn(async () => true);
  const relaunch = vi.fn();
  const handlers = createLocalDbMaintenanceIpcHandlers({
    captureOwner: () => ({ ...owner }),
    isOwnerCurrent: (snapshot) =>
      snapshot.ownerId === owner.ownerId && snapshot.scopeKey === owner.scopeKey,
    getDbClient: () => ({ queryOne } as unknown as DbClient),
    getDbClientOwnerId: () => dbClientOwnerId,
    getCurrentDbPath: () => dbFilePath,
    getUserDataDir: () => tmpDir,
    canSchedule: () => canSchedule,
    selectBackupDirectory,
    confirmActiveTaskCleanup,
    confirmWithoutBackup,
    revealFile,
    relaunch,
  });
  return {
    handlers,
    confirmActiveTaskCleanup,
    confirmWithoutBackup,
    queryOne,
    revealFile,
    relaunch,
    setOwner(next: { ownerId: string; scopeKey: string }) {
      owner = next;
    },
    setDbClientOwnerId(next: string | null) {
      dbClientOwnerId = next;
    },
    setCanSchedule(next: boolean) {
      canSchedule = next;
    },
  };
}

describe('local database maintenance IPC', () => {
  it('accepts only the fixed 7 day, 1 month, 3 month, and 6 month archive thresholds', async () => {
    const { handlers, queryOne } = createHarness();

    for (const archiveAgeMonths of ['7-days', 1, 3, 6] as const) {
      await expect(handlers.scan({ archiveAgeMonths })).resolves.toMatchObject({
        archiveAgeMonths,
      });
    }
    for (const archiveAgeMonths of [0, 1.5, 2, 7, 12, '7-day']) {
      await expect(
        handlers.scan({ archiveAgeMonths: archiveAgeMonths as never }),
      ).rejects.toThrow('[INVALID_PARAMS]');
    }
    expect(queryOne).toHaveBeenCalledTimes(4);
  });

  it('defaults active-task cleanup off for legacy callers and rejects non-boolean values', async () => {
    const { handlers, queryOne } = createHarness();

    const scan = await handlers.scan({ archiveAgeMonths: 3 });

    expect(scan).toMatchObject({ includeActiveTasks: false, activeTaskCount: 0 });
    expect(queryOne).toHaveBeenLastCalledWith(expect.stringContaining("status = 'active'"), [
      scan.archivedBeforeMs,
      scan.archivedBeforeMs,
      0,
      scan.archivedBeforeMs,
    ]);

    for (const includeActiveTasks of [null, 0, 'true', {}]) {
      await expect(
        handlers.scan({ archiveAgeMonths: 3, includeActiveTasks } as never),
      ).rejects.toThrow('[INVALID_PARAMS]');
    }
    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it('applies the selected age cutoff to every task status and carries its scope into the marker', async () => {
    const harness = createHarness();
    harness.queryOne.mockResolvedValueOnce({
      activeTaskCount: 4,
      deletedTaskCount: 1,
      archivedTaskCount: 2,
      messageCount: 7,
      estimatedMessageBytes: 8_192,
    });

    const scan = await harness.handlers.scan({
      archiveAgeMonths: '7-days',
      includeActiveTasks: true,
    });

    expect(scan).toMatchObject({ includeActiveTasks: true, activeTaskCount: 4 });
    expect(harness.queryOne).toHaveBeenLastCalledWith(
      expect.stringContaining("status = 'active'"),
      [scan.archivedBeforeMs, scan.archivedBeforeMs, 1, scan.archivedBeforeMs],
    );

    await expect(
      harness.handlers.schedule({ scanId: scan.scanId, backupEnabled: true }),
    ).resolves.toEqual({ scheduled: true });
    expect(harness.confirmActiveTaskCleanup).toHaveBeenCalledExactlyOnceWith({
      backupEnabled: true,
    });
    expect(readDbSlimmingRequest(tmpDir)).toMatchObject({
      includeActiveTasks: true,
      activeTaskCount: 4,
      deletedTaskCount: 1,
      archivedTaskCount: 2,
      messageCount: 7,
    });
  });

  it('subtracts exactly seven days for the seven day archive threshold', () => {
    expect(archiveCutoffForAge(Date.UTC(2026, 2, 10, 12, 30), '7-days')).toBe(
      Date.UTC(2026, 2, 3, 12, 30),
    );
  });

  it('subtracts natural months and clamps dates at the end of shorter months', () => {
    expect(archiveCutoffForAge(Date.UTC(2026, 2, 31, 12, 30), 1)).toBe(
      Date.UTC(2026, 1, 28, 12, 30),
    );
    expect(archiveCutoffForAge(Date.UTC(2024, 2, 31, 12, 30), 1)).toBe(
      Date.UTC(2024, 1, 29, 12, 30),
    );
  });

  it('invalidates a scan when the owner scope changes before scheduling', async () => {
    const harness = createHarness();
    const scan = await harness.handlers.scan({ archiveAgeMonths: 3 });
    harness.setOwner({ ownerId: 'owner-1', scopeKey: 'scope-2' });

    await expect(
      harness.handlers.schedule({ scanId: scan.scanId, backupEnabled: true }),
    ).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(harness.relaunch).not.toHaveBeenCalled();
  });

  it('invalidates a custom-directory grant independently from a fresh scan', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T00:00:00.000Z'));
    const harness = createHarness();
    const directory = await harness.handlers.chooseBackupDirectory();
    expect(directory).toMatchObject({ selected: true });

    vi.advanceTimersByTime(29 * 60 * 1000);
    const scan = await harness.handlers.scan({ archiveAgeMonths: 3 });
    vi.advanceTimersByTime(2 * 60 * 1000);

    await expect(
      harness.handlers.schedule({
        scanId: scan.scanId,
        backupEnabled: true,
        backupDirectoryGrantId: directory.grantId,
      }),
    ).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(harness.relaunch).not.toHaveBeenCalled();
  });

  it('requires a new scan after the scan grant expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T00:00:00.000Z'));
    const harness = createHarness();
    const scan = await harness.handlers.scan({ archiveAgeMonths: 3 });
    vi.advanceTimersByTime(31 * 60 * 1000);

    await expect(
      harness.handlers.schedule({ scanId: scan.scanId, backupEnabled: true }),
    ).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(harness.relaunch).not.toHaveBeenCalled();
  });

  it('does not schedule file replacement from a passive shared instance', async () => {
    const harness = createHarness();
    const scan = await harness.handlers.scan({ archiveAgeMonths: 3 });
    harness.setCanSchedule(false);

    await expect(
      harness.handlers.schedule({ scanId: scan.scanId, backupEnabled: true }),
    ).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
    expect(harness.relaunch).not.toHaveBeenCalled();
  });

  it('requires a native Main confirmation before scheduling without a backup', async () => {
    const harness = createHarness();
    harness.confirmWithoutBackup.mockResolvedValue(false);
    const scan = await harness.handlers.scan({ archiveAgeMonths: 3 });

    await expect(
      harness.handlers.schedule({ scanId: scan.scanId, backupEnabled: false }),
    ).resolves.toEqual({ scheduled: false });

    expect(harness.confirmWithoutBackup).toHaveBeenCalledOnce();
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
    expect(harness.relaunch).not.toHaveBeenCalled();
  });

  it('requires a native Main confirmation for active-task cleanup with a backup', async () => {
    const harness = createHarness();
    harness.confirmActiveTaskCleanup.mockResolvedValue(false);
    const scan = await harness.handlers.scan({
      archiveAgeMonths: '7-days',
      includeActiveTasks: true,
    });

    await expect(
      harness.handlers.schedule({ scanId: scan.scanId, backupEnabled: true }),
    ).resolves.toEqual({ scheduled: false });

    expect(harness.confirmActiveTaskCleanup).toHaveBeenCalledExactlyOnceWith({
      backupEnabled: true,
    });
    expect(harness.confirmWithoutBackup).not.toHaveBeenCalled();
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
    expect(harness.relaunch).not.toHaveBeenCalled();
  });

  it('includes the no-backup state in the active-task Main confirmation', async () => {
    const harness = createHarness();
    const scan = await harness.handlers.scan({
      archiveAgeMonths: 1,
      includeActiveTasks: true,
    });

    await expect(
      harness.handlers.schedule({ scanId: scan.scanId, backupEnabled: false }),
    ).resolves.toEqual({ scheduled: true });

    expect(harness.confirmActiveTaskCleanup).toHaveBeenCalledExactlyOnceWith({
      backupEnabled: false,
    });
    expect(harness.confirmWithoutBackup).not.toHaveBeenCalled();
  });

  it('does not show the native no-backup confirmation when a backup is enabled', async () => {
    const harness = createHarness();
    const scan = await harness.handlers.scan({ archiveAgeMonths: '7-days' });

    await expect(
      harness.handlers.schedule({ scanId: scan.scanId, backupEnabled: true }),
    ).resolves.toEqual({ scheduled: true });

    expect(harness.confirmWithoutBackup).not.toHaveBeenCalled();
    expect(harness.confirmActiveTaskCleanup).not.toHaveBeenCalled();
    expect(readDbSlimmingRequest(tmpDir)).toMatchObject({
      archiveAgeMonths: '7-days',
      backupEnabled: true,
    });
    expect(harness.relaunch).toHaveBeenCalledExactlyOnceWith(scan.scanId);
  });

  it('does not restart or copy the database when the scan found nothing to clean', async () => {
    const harness = createHarness();
    harness.queryOne.mockResolvedValueOnce({
      activeTaskCount: 0,
      deletedTaskCount: 0,
      archivedTaskCount: 0,
      messageCount: 0,
      estimatedMessageBytes: 0,
    });
    const scan = await harness.handlers.scan({ archiveAgeMonths: '7-days' });

    await expect(
      harness.handlers.schedule({ scanId: scan.scanId, backupEnabled: false }),
    ).resolves.toEqual({ scheduled: false });

    expect(harness.confirmWithoutBackup).not.toHaveBeenCalled();
    expect(harness.confirmActiveTaskCleanup).not.toHaveBeenCalled();
    expect(harness.relaunch).not.toHaveBeenCalled();
    expect(readDbSlimmingRequest(tmpDir)).toBeNull();
  });

  it('does not overwrite another owner pending recovery marker', async () => {
    const harness = createHarness();
    const pending = {
      version: 1 as const,
      id: '9c5c7e99-6a6a-4d21-9152-4034a4959490',
      ownerId: 'owner-2',
      createdAt: 1_000,
      scannedAt: 900,
      archivedBeforeMs: 800,
      archiveAgeMonths: '7-days' as const,
      deletedTaskCount: 1,
      archivedTaskCount: 2,
      messageCount: 3,
      beforeBytes: 4_096,
      backupEnabled: true,
      phase: 'replacement-installed' as const,
    };
    writeDbSlimmingRequest(tmpDir, pending);
    const scan = await harness.handlers.scan({ archiveAgeMonths: '7-days' });

    await expect(
      harness.handlers.schedule({ scanId: scan.scanId, backupEnabled: true }),
    ).rejects.toThrow('[PRECONDITION_FAILED]');

    expect(readDbSlimmingRequest(tmpDir)).toEqual(pending);
    expect(harness.relaunch).not.toHaveBeenCalled();
  });

  it('never exposes the privileged backup path to Renderer', async () => {
    const harness = createHarness();
    const backupPath = `${dbFilePath}.slimming-backup`;
    fs.writeFileSync(backupPath, 'backup');
    writeDbSlimmingResult(tmpDir, {
      id: '9c5c7e99-6a6a-4d21-9152-4034a4959490',
      ownerId: 'owner-1',
      status: 'completed',
      finishedAt: 3_000,
      archiveAgeMonths: 3,
      deletedTaskCount: 1,
      archivedTaskCount: 2,
      messageCount: 3,
      beforeBytes: 4_096,
      afterBytes: 2_048,
      reclaimedBytes: 2_048,
      backupCreated: true,
      backupLocation: 'database-directory',
      backupPath,
    });

    const result = harness.handlers.getLastResult();

    expect(result).toMatchObject({ status: 'completed', backupCreated: true });
    expect(result).not.toHaveProperty('ownerId');
    expect(result).not.toHaveProperty('backupPath');
    await expect(harness.handlers.openLastBackupDirectory()).resolves.toEqual({ opened: true });
    expect(harness.revealFile).toHaveBeenCalledWith(backupPath);
  });

  it('rechecks the live database owner before granting maintenance access', async () => {
    const harness = createHarness();
    harness.setDbClientOwnerId('owner-2');

    await expect(harness.handlers.scan({ archiveAgeMonths: 3 })).rejects.toThrow(
      '[PRECONDITION_FAILED]',
    );
    expect(harness.queryOne).not.toHaveBeenCalled();
  });
});
