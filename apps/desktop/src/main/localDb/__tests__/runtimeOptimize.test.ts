import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../userDataPath.js', () => ({ userDataPath: () => fixture.root }));
vi.mock('../../host-client-mode.js', () => ({ isHostClientMode: () => false }));
vi.mock('../../cindy-make/versionRuntimeIdentity.js', () => ({ isCindyPersonalRuntime: () => false }));
vi.mock('../hostUi.js', () => ({ localDbHostUi: () => ({ isPackaged: () => true }) }));
vi.mock('../betterSqliteFactory', () => ({ createBetterSqliteDatabase: (file: string) => new Database(file) }));
vi.mock('../registerCjkSeg', () => ({ ensureCjkFtsTempTriggersInstalled: () => undefined }));
vi.mock('../migrate', () => ({ getDrizzleDir: () => fixture.root, prepareBackupDiskSpace: vi.fn(), pruneMigrationBackupsToBudget: vi.fn(), runMigrations: vi.fn() }));
vi.mock('../backup', () => ({ tryRestoreWithFallback: vi.fn(), backupDb: vi.fn(), restrictLegacyBackupPermissions: vi.fn() }));
vi.mock('../schemaDriftDetector', () => ({ detectSchemaDrift: vi.fn() }));
vi.mock('../schemaDriftRepair', () => ({ repairSchemaDriftWithBackup: vi.fn() }));
vi.mock('../schemaDriftCompatibility', () => ({ reconcileKnownEquivalentMigrationHashes: vi.fn() }));
vi.mock('../orcaStaleIndexCleanup', () => ({ cleanupStaleOrcaLeadIndex: vi.fn(), hasStaleOrcaLeadIndex: vi.fn() }));
vi.mock('../orcaStrandedLeadReconcile', () => ({ reconcileStrandedOrcaLeads: vi.fn() }));
vi.mock('../codexHistoryPromptInit', () => ({ initializeCodexHistoryPromptState: vi.fn() }));
vi.mock('../dialogueWorkspace', () => ({ dialogueWorkspaceRoots: () => [] }));
vi.mock('../managedDialogueWorkspaceRepair', () => ({ repairManagedDialogueWorkspaceSessions: vi.fn() }));
vi.mock('../sqliteVecLoader', () => ({ loadSqliteVec: () => ({ loaded: true }), resetSqliteVecState: vi.fn() }));
vi.mock('../migrationRunner', () => ({ checkMigrationCompatibility: vi.fn(), prepareMigrationRuntimeManifest: vi.fn(), readSchemaVersion: vi.fn() }));
vi.mock('../schemaMigrationLease', () => ({
  acquireSchemaStartupLease: async () => ({ acquired: true, kind: 'writer', lease: { release: vi.fn() } }),
  SchemaMigrationReaderLeaseLifecycle: class { release() {} closeConnection() {} },
}));
vi.mock('../schemaStartupPolicy', () => ({ runSchemaStartupPolicy: async () => ({ ready: true }) }));
vi.mock('../dbSlimmingWorkerClient', () => ({ deferReleaseUntilDbSlimmingWorkerTermination: () => false }));
vi.mock('../modelDefaultsProfile', () => ({ ownerDatabasePath: (root: string, user: string) => path.join(root, `${user}.db`), prepareModelDefaultsProfile: vi.fn() }));
vi.mock('../../devStartupStatus', () => ({ recordDesktopDevLocalDbStartupResult: vi.fn() }));
import * as runtime from '../index';
import { createLifecycleDbClientManager } from '../client/lifecycleDbClient';
import type { DbClient } from '../client/DbClient';

// #11401 / standard unit: actual index.ensureReady/native pragma/timer/close.
// Client-facade tests miss main's maintenance SQL. A quarantine signal must
// stop periodic and normal-teardown optimize, while healthy close keeps it.
// All startup maintenance/leases are isolated ports; only the exclusively
// created mkdtemp database is opened. Separate file isolates index singleton
// state/mocks from the inproc factory regression. No migration/App claim.
describe('main native connection quarantine', () => {
  beforeEach(() => {
    fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-optimize-quarantine-'));
    vi.useFakeTimers();
  });
  afterEach(() => {
    runtime.closeDb();
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  it.each([false, true])('stops maintenance SQL after quarantine, preserving healthy optimize (corrupt=%s)', async corrupt => {
    await expect(runtime.ensureReady('synthetic-owner')).resolves.toEqual({ ready: true });
    const db = runtime.getRawDb();
    const pragma = vi.spyOn(db, 'pragma');
    if (corrupt) {
      runtime.markRuntimeDbCorrupt();
    }
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    runtime.closeDb();
    expect(pragma).toHaveBeenCalledTimes(corrupt ? 0 : 2);
    expect(db.open).toBe(false);
  });
  // A readiness request can pass its preflight before a worker's corrupt
  // response arrives, then open main later. The lifecycle's final admission
  // must quarantine that real new handle too, not just the earlier callback.
  it('quarantines a main handle opened after an already admitted readiness request observes worker corruption', async () => {
    const owner = 'synthetic-owner';
    await runtime.ensureReady(owner);
    let failure: Error | null = null;
    const client = {
      query: vi.fn(async () => []), dispose: vi.fn(async () => undefined),
      get corruptionError() { return failure; },
    } as unknown as DbClient;
    const ports = {
      getCurrentDbPath: runtime.getCurrentDbPath,
      closeMainDb: () => runtime.closeDb({ skipOptimize: true }),
      quarantineMainDb: (id: string) => { if (runtime.getCurrentUserId() === id) runtime.markRuntimeDbCorrupt(); },
      createWorkerClient: async () => client, createInprocClient: async () => client,
      setCurrentDbClient: vi.fn(), clearCurrentDbClient: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const manager = createLifecycleDbClientManager(ports);
    try {
      await manager.ensure(owner, {});
      runtime.closeDb(); // Healthy worker takeover had released main.
      failure = Object.assign(new Error('bad page'), { code: 'SQLITE_CORRUPT' });
      // An already-admitted initialization opens main after the corrupt reply;
      // the earlier callback had no native singleton to mark at that instant.
      await runtime.ensureReady(owner);
      const db = runtime.getRawDb();
      const pragma = vi.spyOn(db, 'pragma');
      await expect(manager.ensure(owner, {})).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      runtime.closeDb();
      expect(pragma).not.toHaveBeenCalled();
      expect(db.open).toBe(false);
    } finally {
      await manager.dispose('test-end');
    }
  });

});
