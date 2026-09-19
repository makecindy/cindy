import path from 'node:path';
import { vi } from 'vitest';
import { createWorkingDirectoryRecovery } from '../../workingDirectoryRecovery';
import { createWorkingDirectoryPreflight, type WorkingDirectoryPreflightDeps } from '../../workingDirectoryPreflight';

/** Real preflight and recovery with in-memory filesystem and main-process adapters. */
export function createPreflightHarness() {
  const dir = path.resolve('/project');
  const directoryStat = { isDirectory: () => true, dev: 7 };
  const io = { stat: vi.fn(async (_dir: string) => directoryStat), mkdir: vi.fn(async () => {}) };
  const recovery = createWorkingDirectoryRecovery(io);
  const recover = vi.spyOn(recovery, 'recover');
  const emitMissing = vi.fn();
  const log = { debug: vi.fn(), warn: vi.fn() };
  const readBoundWorkingDir = vi.fn(async (_id: string): Promise<string | null> => dir);
  const deps: WorkingDirectoryPreflightDeps = {
    workingDirectoryRecovery: recovery,
    statWorkingDirectory: io.stat,
    readBoundWorkingDir,
    getUserDataPath: () => path.resolve('/user-data'),
    isCindyMakeWorktreePath: vi.fn(() => false),
    assertCindyMakeWorkspace: vi.fn(async () => {}),
    getManagedWorktreeBasePath: vi.fn(() => null),
    getManagedWorktreeReadinessForSession: vi.fn(async () => 'gone' as const),
    findSimilarDirOnDisk: vi.fn(async () => null),
    listActiveSessions: () => [],
    emitWorkDirMissingError: emitMissing,
    workdirLog: log,
    log,
  };
  return { dir, directoryStat, io, recovery, recover, emitMissing, log, readBoundWorkingDir, deps, check: createWorkingDirectoryPreflight(deps) };
}

export function filesystemError(code: string) {
  return Object.assign(new Error('filesystem operation failed'), { code });
}
