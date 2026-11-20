import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', packaged: true }));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../userDataPath.js', () => ({ userDataPath: () => fixture.root }));
vi.mock('../../host-client-mode.js', () => ({ isHostClientMode: () => false }));
vi.mock('../../cindy-make/versionRuntimeIdentity.js', () => ({ isCindyPersonalRuntime: () => false }));
vi.mock('../hostUi.js', () => ({ localDbHostUi: () => ({ isPackaged: () => fixture.packaged, showMessageBoxSync: () => 1 }) }));
vi.mock('../betterSqliteFactory', () => ({ createBetterSqliteDatabase: vi.fn((file: string) => new Database(file)) }));
vi.mock('../registerCjkSeg', () => ({ ensureCjkFtsTempTriggersInstalled: () => undefined }));
vi.mock('../migrate', () => ({ getDrizzleDir: () => fixture.root, prepareBackupDiskSpace: vi.fn(), pruneMigrationBackupsToBudget: vi.fn(), runMigrations: vi.fn() }));
vi.mock('../backup', () => ({ tryRestoreWithFallback: vi.fn(), backupDb: vi.fn(), restrictLegacyBackupPermissions: vi.fn(), estimateDbSizeBytes: () => 0, getFreeDiskBytes: () => null, isoBackupTotalBudgetBytes: () => 0, pruneIsoBackupsToBudget: () => [] }));
vi.mock('../schemaDriftDetector', () => ({ detectSchemaDrift: vi.fn() }));
vi.mock('../schemaDriftRepair', () => ({ repairSchemaDriftWithBackup: vi.fn() }));
vi.mock('../schemaDriftCompatibility', () => ({ reconcileKnownEquivalentMigrationHashes: vi.fn() }));
vi.mock('../orcaStaleIndexCleanup', () => ({ cleanupStaleOrcaLeadIndex: vi.fn(), hasStaleOrcaLeadIndex: vi.fn() }));
vi.mock('../orcaStrandedLeadReconcile', () => ({ reconcileStrandedOrcaLeads: vi.fn() }));
vi.mock('../codexHistoryPromptInit', () => ({ initializeCodexHistoryPromptState: vi.fn() }));
vi.mock('../dialogueWorkspace', () => ({ dialogueWorkspaceRoots: () => [] }));
vi.mock('../managedDialogueWorkspaceRepair', () => ({ repairManagedDialogueWorkspaceSessions: vi.fn() }));
vi.mock('../sqliteVecLoader', () => ({ loadSqliteVec: () => ({ loaded: true }), resetSqliteVecState: vi.fn() }));
vi.mock('../migrationRunner', async importOriginal => ({ ...await importOriginal<typeof import('../migrationRunner')>(), checkMigrationCompatibility: vi.fn(), prepareMigrationRuntimeManifest: vi.fn() }));
vi.mock('../schemaMigrationLease', () => ({
  acquireSchemaStartupLease: vi.fn(async () => ({ acquired: true, kind: 'writer', lease: { release: vi.fn() } })),
  SchemaMigrationReaderLeaseLifecycle: class { release() {} closeConnection() {} },
}));
vi.mock('../schemaStartupPolicy', () => ({ runSchemaStartupPolicy: vi.fn(async () => ({ ready: true, compatibility: null })) }));
vi.mock('../dbSlimmingWorkerClient', () => ({ deferReleaseUntilDbSlimmingWorkerTermination: () => false }));
vi.mock('../modelDefaultsProfile', () => ({ ownerDatabasePath: (root: string, user: string) => path.join(root, `${user}.db`), prepareModelDefaultsProfile: vi.fn() }));
vi.mock('../../devStartupStatus', () => ({ recordDesktopDevLocalDbStartupResult: vi.fn() }));
import { backupDb } from '../backup';
import { detectSchemaDrift } from '../schemaDriftDetector';
import { reconcileKnownEquivalentMigrationHashes } from '../schemaDriftCompatibility';
import { repairSchemaDriftWithBackup } from '../schemaDriftRepair';
import { configureMigrationRuntime } from '../migrationRuntime';
import * as runtime from '../index';
import { createLifecycleDbClientManager } from '../client/lifecycleDbClient';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runSchemaStartupPolicy } from '../schemaStartupPolicy';
import { cleanupStaleOrcaLeadIndex } from '../orcaStaleIndexCleanup';
import { acquireSchemaStartupLease } from '../schemaMigrationLease';
import type { CreateDbClientOptions, DbClient } from '../client/DbClient';

// #11401 / standard unit: actual index.ensureReady/native pragma/timer/close.
// Client-facade tests miss main's maintenance SQL. A quarantine signal must
// stop periodic and normal-teardown optimize, while healthy close keeps it.
// All startup maintenance/leases are isolated ports; only the exclusively
// created mkdtemp database is opened. Separate file isolates index singleton
// state/mocks from the inproc factory regression. No migration/App claim.
describe('main native connection quarantine', () => {
  beforeEach(() => {
    fixture.packaged = true;
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
  // The original late-handle test spied only after startup SQL had run. Observe
  // the actual native factory before the passive open, including lease waits.
  it('blocks passive startup SQL after worker corruption with no main handle', async () => {
    const owner = 'synthetic-owner';
    await runtime.ensureReady(owner);
    let failure: Error | null = null;
    let onCorruption: CreateDbClientOptions['onCorruption'];
    const client = {
      query: vi.fn(async () => []), dispose: vi.fn(async () => undefined),
      get corruptionError() { return failure; },
    } as unknown as DbClient;
    const manager = createLifecycleDbClientManager({
      getCurrentDbPath: runtime.getCurrentDbPath,
      closeMainDb: (userId) => runtime.closeDb({ skipOptimize: true, recoverRuntimeCorruptionForUserId: userId }),
      quarantineMainDb: (userId, error) => runtime.markRuntimeDbCorrupt(userId, error),
      createWorkerClient: async (options) => { onCorruption = options.onCorruption; return client; },
      createInprocClient: async () => client,
      setCurrentDbClient: vi.fn(), clearCurrentDbClient: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    try {
      await manager.ensure(owner, {});
      runtime.closeDb({ preserveSchemaMigrationLease: true });
      await manager.prepareForEnsure(owner); // Already admitted before corruption.
      failure = Object.assign(new Error('bad page'), { code: 'SQLITE_CORRUPT' });
      onCorruption!(failure);
      vi.mocked(createBetterSqliteDatabase).mockClear();
      await expect(runtime.ensureReady(owner)).rejects.toBe(failure);
      expect(createBetterSqliteDatabase).not.toHaveBeenCalled();
      // Closing/switching a healthy different owner must not forget this file.
      await expect(runtime.ensureReady('healthy-owner')).resolves.toEqual({ ready: true });
      const healthyDb = runtime.getRawDb();
      await manager.dispose('owner-switch');
      await expect(runtime.ensureReady(owner)).rejects.toBe(failure);
      await manager.prepareForEnsure(owner, true);
      expect(healthyDb.open).toBe(true); // Recovery must not close another owner.
      await expect(runtime.ensureReady(owner)).resolves.toEqual({ ready: true });
      expect(runtime.getRawDb().open).toBe(true);
    } finally {
      await manager.dispose('test-end');
    }
  });

  it('rejects a pending lease admission before native open when corruption arrives', async () => {
    const owner = 'synthetic-owner';
    let releaseLease!: (value: Awaited<ReturnType<typeof acquireSchemaStartupLease>>) => void;
    const released = vi.fn();
    vi.mocked(acquireSchemaStartupLease).mockImplementationOnce(() => new Promise(resolve => { releaseLease = resolve; }));
    vi.mocked(createBetterSqliteDatabase).mockClear();
    const pending = runtime.ensureReady(owner);
    const failure = Object.assign(new Error('bad page'), { code: 'SQLITE_CORRUPT' });
    runtime.markRuntimeDbCorrupt(owner, failure);
    const rejected = expect(pending).rejects.toBe(failure);
    releaseLease({ acquired: true, kind: 'writer', newlyAcquired: true, lease: { kind: 'writer', release: released } });
    await rejected;
    expect(createBetterSqliteDatabase).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledOnce();
    runtime.closeDb({ skipOptimize: true, recoverRuntimeCorruptionForUserId: owner });
  });
  it('stops remaining startup SQL if corruption arrives during an awaited schema phase', async () => {
    const owner = 'synthetic-owner';
    const failure = Object.assign(new Error('bad page'), { code: 'SQLITE_CORRUPT' });
    let db!: Database.Database;
    let pragma!: ReturnType<typeof vi.spyOn>;
    vi.mocked(cleanupStaleOrcaLeadIndex).mockClear();
    vi.mocked(runSchemaStartupPolicy).mockImplementationOnce(async options => {
      db = runtime.getRawDb();
      runtime.markRuntimeDbCorrupt(owner, failure);
      pragma = vi.spyOn(db, 'pragma');
      // Same port invoked by the real policy after its awaited migration/drift.
      options.cleanupSchemaDdl();
      return { ready: true, compatibility: null };
    });
    await expect(runtime.ensureReady(owner)).rejects.toBe(failure);
    expect(cleanupStaleOrcaLeadIndex).not.toHaveBeenCalled();
    expect(pragma).not.toHaveBeenCalled();
    expect(db.open).toBe(false);
    await expect(runtime.ensureReady(owner)).rejects.toBe(failure);
    runtime.closeDb({ skipOptimize: true, recoverRuntimeCorruptionForUserId: owner });
  });

  // Real schema helpers, not policy-port substitutes: an online backup yields
  // while the live worker can report corruption. Only exclusively synthetic DBs.
  it.each([false, true])('guards actual drift apply after backup (corrupt=%s)', async corrupt => {
    fixture.packaged = false;
    const owner = 'synthetic-owner';
    const failure = Object.assign(new Error('bad page'), { code: 'SQLITE_CORRUPT' });
    const actual = await vi.importActual<typeof import('../schemaDriftRepair')>('../schemaDriftRepair');
    vi.mocked(repairSchemaDriftWithBackup).mockImplementationOnce(actual.repairSchemaDriftWithBackup);
    vi.mocked(detectSchemaDrift).mockReturnValue({ status: 'clean', entries: [] });
    vi.mocked(reconcileKnownEquivalentMigrationHashes).mockImplementation((_db, report) => ({ report, reconciled: [], failures: [] }));
    let finishBackup!: (value: string) => void;
    let enteredBackup!: () => void;
    const entered = new Promise<void>(resolve => { enteredBackup = resolve; });
    vi.mocked(backupDb).mockImplementationOnce(() => { enteredBackup(); return new Promise(resolve => { finishBackup = resolve; }); });
    vi.mocked(runSchemaStartupPolicy).mockImplementationOnce(async options => {
      await options.handleSchemaDrift();
      return { ready: true, compatibility: null };
    });
    const pending = runtime.ensureReady(owner);
    await entered;
    const db = runtime.getRawDb();
    const exec = vi.spyOn(db, 'exec');
    if (corrupt) runtime.markRuntimeDbCorrupt(owner, failure);
    const result = corrupt ? expect(pending).rejects.toBe(failure) : expect(pending).resolves.toEqual({ ready: true });
    finishBackup('synthetic-backup');
    await result;
    if (corrupt) expect(exec).not.toHaveBeenCalled();
    if (!corrupt) expect(exec.mock.calls.length).toBeGreaterThan(0);
    runtime.closeDb({ skipOptimize: true, recoverRuntimeCorruptionForUserId: owner });
  });

  it.each([false, true])('guards actual migration replay after backup (corrupt=%s)', async corrupt => {
    const actual = await vi.importActual<typeof import('../migrate')>('../migrate');
    const drizzleDir = path.join(fixture.root, 'drizzle');
    fs.mkdirSync(drizzleDir);
    // Synthetic migration input only; never modifies the repository chain.
    fs.writeFileSync(path.join(drizzleDir, '0111_fixture.sql'), 'CREATE TABLE synthetic_guard(id INTEGER);');
    configureMigrationRuntime({ drizzleDir, isPackaged: true });
    const file = path.join(fixture.root, 'migration.db');
    const db = new Database(file);
    try {
      db.exec("CREATE TABLE migration_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO migration_meta VALUES('schema_version','110'); CREATE TABLE migration_history(seq INTEGER PRIMARY KEY,file_name TEXT,content_hash TEXT,applied_at INTEGER);");
      let finishBackup!: (value: string) => void;
      vi.mocked(backupDb).mockImplementationOnce(() => new Promise(resolve => { finishBackup = resolve; }));
      let failure: Error | null = null;
      const pending = actual.runMigrations(db, file, () => { if (failure) throw failure; });
      if (corrupt) failure = Object.assign(new Error('bad page'), { code: 'SQLITE_CORRUPT' });
      const result = corrupt ? expect(pending).rejects.toBe(failure) : expect(pending).resolves.toBeUndefined();
      finishBackup('NO_DB_TO_BACKUP');
      await result;
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='synthetic_guard'").get()).toEqual(corrupt ? undefined : { name: 'synthetic_guard' });
      expect(db.open).toBe(true); // A quarantine rejection must not restore/replace files.
    } finally { db.close(); }
  });

});
