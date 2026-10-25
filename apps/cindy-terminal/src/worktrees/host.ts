import { RUNTIME_DIRECTORY } from '../version.js';
import { createWorkerWorktreeProjects } from '@cindy/worktree-core/workerProject';
import { TerminalWorktreeTaskLeases } from './task-leases.js';
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND_IDENTITY } from "@cindy/maker-shared/brand-identity";
import {
  managedWorktreeBaseRepo as getManagedWorktreeBasePath,
  MANAGED_WORKTREE_DIR_NAME,
} from "@cindy/maker-shared/worktree-paths";
import { withCrossProcessLock } from "@cindy/remote-agent/crossProcessLock";
import { killProcessTree } from "@cindy/maker-scheduler/proc-util";
import { createWorktreeManager } from "@cindy/worktree-core/manager";
import { createGitExecutor } from "@cindy/worktree-core/gitExec";
import { GitExecError } from "@cindy/worktree-core/gitTypes";
import { createExecFileDiagnostics } from "@cindy/worktree-core/execFileDiagnostics";
import { createWorktreeResourceLocks } from "@cindy/worktree-core/resourceLock";
import { createWorktreeRuntimeLeases } from "@cindy/worktree-core/runtimeLeases";
import { createWorktreeRecycleEvents } from "@cindy/worktree-core/recycleEvents";
import { createWorktreeRecycleJournal } from "@cindy/worktree-core/recycleJournal";
import { createWorktreeContentSnapshots } from "@cindy/worktree-core/contentSnapshot";
import { createWorktreeResourceSafety } from "@cindy/worktree-core/resourceSafety";
import { createWorktreeRecoveryArchives } from "@cindy/worktree-core/recoveryArchive";
import { createRecoveryArchiveWorkerClient } from "@cindy/worktree-core/recoveryArchiveWorkerClient";
import { createLiveWorktreeReferences } from "@cindy/worktree-core/liveSessionRefs";
import { createManagedWorktreeRecycle } from "@cindy/worktree-core/managedRecycle";
import { createRecordedWorktreeRecovery } from "@cindy/worktree-core/restoreRecovery";
import { createWorktreeRestore } from "@cindy/worktree-core/restore";
import { createWorktreeRestoreLocks } from "@cindy/worktree-core/restoreLock";
import { createPrecreatedWorktreeCancellation } from "@cindy/worktree-core/precreatedCancellation";
import { createWorktreeDirtyChecks } from "@cindy/worktree-core/dirty";
import { createWorktreeIncludeEngine } from "@cindy/worktree-core/includePatternsEngine";
import { createAttachedBranchReader } from "@cindy/worktree-core/attachedBranch";
import { createFreshWorktreeBase } from "@cindy/worktree-core/freshBase";
import { createWorktreePool } from "@cindy/worktree-core/pool";
import { createWorktreeRecycleMaintenance } from "@cindy/worktree-core/recycleMaintenance";
import { acquireWindowsPackagedInstanceBarrier } from "@cindy/worktree-core/windowsPackagedInstanceBarrier";
import {
  readDesktopProcessIdentity,
  isReusedDesktopInstancePid,
} from "@cindy/worktree-core/processIdentity";
import { MainProcessWorkdirProbeClient } from "@cindy/worktree-core/workdirProbe";
import { classifyError } from "@cindy/worktree-core/errorClassifier";
import { createCwdProbeScheduler } from "@cindy/worktree-core/cwdProbeScheduler";
import { gitPathOutput } from "@cindy/worktree-core/gitPathOutput";
import * as names from "@cindy/worktree-core/nameGenerator";
import * as safety from "@cindy/worktree-core/safety";
import type { WorktreeManagerPorts } from "@cindy/worktree-core/managerPorts";
import { createWorktreeSessionTransferReader } from '@cindy/app-runtime/worktreeSessionTransfer';
import type { Logger } from "@cindy/maker-core";
import type { TerminalTaskStorage } from "../tasks/storage.js";
import { privateDirectory } from "../platform.js";
import { TerminalWorktreeRegistry } from "./registry.js";
import {
  TerminalWorktreeReferences,
  desktopAppDataRoot,
} from "./references.js";
import { createTerminalArchiveKeys } from "./archive-keys.js";

export type TerminalWorktrees = Awaited<
  ReturnType<typeof createTerminalWorktrees>
>;

/** Shared algorithms, real native storage and OS probes. Each owner gets its own
 * registry/restore queues; physical locks and compatible leases span hosts. */
export async function createTerminalWorktrees(options: {
  profile: string;
  root: string;
  tasks: TerminalTaskStorage;
  logger: Pick<Logger, "info" | "warn" | "debug" | "error">;
  guard(): void;
  secrets: Parameters<typeof createTerminalArchiveKeys>[0];
  appDataRoot?: string;
  archiveWorkerPath?: string;
  extraPiHomes?(): Promise<string[]>;
}) {
  const database = await options.tasks.database();
  const readSessionTransfer = createWorktreeSessionTransferReader(() => {
    options.guard();
    return database.getDbClient();
  });
  const appDataRoot = options.appDataRoot ?? desktopAppDataRoot();
  const userDataRoot = () => options.root;
  const log = Object.fromEntries(
    ["info", "warn", "debug", "error"].map((level) => [
      level,
      (message: string, ...details: unknown[]) =>
        options.logger[level as keyof typeof options.logger](
          message,
          details.length === 1 &&
            details[0] !== null &&
            typeof details[0] === "object" &&
            !Array.isArray(details[0])
            ? (details[0] as Record<string, unknown>)
            : { details },
        ),
    ]),
  ) as WorktreeManagerPorts["log"];
  await privateDirectory(path.join(options.root, ".dev-instances"));
  options.guard();
  const registry = new TerminalWorktreeRegistry({
    root: options.root,
    tasks: options.tasks,
    guard: options.guard,
    logger: log,
  });
  await registry.ready;
  const store = registry.store;
  const locks = createWorktreeResourceLocks({ withCrossProcessLock });
  const restoreLocks = createWorktreeRestoreLocks();
  const events = createWorktreeRecycleEvents(locks.worktreeResourceId);
  const git = createGitExecutor({
    withCrossProcessLock,
    killProcessTree,
    log,
    ...createExecFileDiagnostics(log),
  });
  const common = { ...locks, ...git, GitExecError, log, store };
  const runtimeFor = (root: string, publishShared = false) =>
    createWorktreeRuntimeLeases({
      ...locks,
      ...events,
      ...git,
      userDataRoot: () => root,
      appDataRoot: () => appDataRoot,
      readDesktopProcessIdentity,
      isReusedDesktopInstancePid,
      publishShared,
    });
  const runtime = runtimeFor(options.root, true);
  const taskLeases = new TerminalWorktreeTaskLeases({ root: options.root, appDataRoot, runtime, physicalWorktreeKey: locks.physicalWorktreeKey, guard: options.guard, warn: message => log.warn(message) });
  await taskLeases.reconcile(await options.tasks.list());
  options.tasks.configureWorktreeReferences(taskLeases);
  const references = new TerminalWorktreeReferences({
    profile: options.profile,
    ownerRoot: options.root,
    appDataRoot,
    guard: options.guard,
    log,
    readRuntimePaths: (root) => runtimeFor(root).readWorktreeRuntimePaths(),
    extraPiHomes: options.extraPiHomes,
  });
  await references.ready;
  const readLocalWorktreeReferences = () =>
    references.readLocalWorktreeReferences();
  const live = createLiveWorktreeReferences({
    ...common,
    readLocalWorktreeReferences,
    readWorktreeRuntimePaths: () => references.readWorktreeRuntimePaths(),
    readPiSubagentWorktreeReferences: () =>
      references.readPiSubagentWorktreeReferences(),
  });
  const journal = createWorktreeRecycleJournal({
    ...common,
    ...events,
    userDataRoot,
    appDataRoot: () => appDataRoot,
  });
  const archiveWorkerPath =
    options.archiveWorkerPath ??
    path.join(RUNTIME_DIRECTORY, "worktree-recovery-worker.cjs");
  const archive = createWorktreeRecoveryArchives({
    ...journal,
    ...createRecoveryArchiveWorkerClient(() => archiveWorkerPath),
    ...createTerminalArchiveKeys(options.secrets, options.guard),
  });
  const snapshots = createWorktreeContentSnapshots(common);
  const resourceSafety = createWorktreeResourceSafety(common);
  const withLegacyWorktreeRuntimeGuard = async <T>(
    task: (held: () => boolean) => Promise<T>,
  ): Promise<T> => {
    if (process.platform !== "win32") return task(() => true);
    const barriers: Awaited<
      ReturnType<typeof acquireWindowsPackagedInstanceBarrier>
    >[] = [];
    try {
      const rootsByProgram = new Map<string, string[]>();
      for (const root of references.desktopRoots()) {
        const program =
          path.basename(root) === BRAND_IDENTITY.userDataDirNameByRegion.dev
            ? BRAND_IDENTITY.executableNameByRegion.dev
            : BRAND_IDENTITY.executableName;
        rootsByProgram.set(program, [
          ...(rootsByProgram.get(program) ?? []),
          root,
        ]);
      }
      for (const [programName, roots] of rootsByProgram)
        barriers.push(
          await acquireWindowsPackagedInstanceBarrier({
            userDataDir: roots[0]!,
            additionalUserDataDirs: roots.slice(1),
            programName,
          }),
        );
      return await task(() => barriers.every((barrier) => barrier.isHeld()));
    } finally {
      for (const barrier of barriers.reverse()) await barrier.release();
    }
  };
  const recycle = createManagedWorktreeRecycle({
    ...common,
    ...live,
    ...journal,
    ...archive,
    ...snapshots,
    ...resourceSafety,
    archiveOnSnapshot: true,
    withLegacyWorktreeRuntimeGuard,
  });
  const recordedRecovery = createRecordedWorktreeRecovery({
    ...common,
    ...live,
    ...journal,
    ...archive,
    ...snapshots,
    ...resourceSafety,
    withLegacyWorktreeRuntimeGuard,
  });
  const cancellation = createPrecreatedWorktreeCancellation({
    userDataRoot,
    withCrossProcessLock,
  });
  const dirty = createWorktreeDirtyChecks(common);
  const include = createWorktreeIncludeEngine(common);
  const branch = createAttachedBranchReader(common);
  const probe = new MainProcessWorkdirProbeClient({ log });
  const manager = createWorktreeManager({
    ...common,
    ...live,
    ...runtime,
    ...recycle,
    ...cancellation,
    ...dirty,
    ...include,
    ...branch,
    ...restoreLocks,
    ...names,
    ...safety,
    withCrossProcessLock,
    gitPathOutput,
    classifyError,
    createCwdProbeScheduler,
    getManagedWorktreeBasePath,
    MANAGED_WORKTREE_DIR_NAME,
    readLocalWorktreeReferences,
    readSessionTransfer,
    realpathWorkingDirectory: async (directory) => {
      const result = await probe.probe(
        directory,
        path.resolve(directory),
        5_000,
        "realpath",
      );
      if (!result.ok)
        throw Object.assign(new Error("Working directory probe failed"), {
          code: result.code,
        });
      if (!result.path) throw new Error("INVALID_RESOLVED_DIRECTORY");
      return result.path;
    },
  });
  const restore = createWorktreeRestore({
    ...common,
    ...dirty,
    ...include,
    ...branch,
    ...recordedRecovery,
    ...journal,
    ...restoreLocks,
    ...manager,
    readSessionWorktreeBinding: async (id) => {
      const row = await options.tasks.get(id);
      options.guard();
      return row
        ? { workingDir: row.workDir, worktreePath: row.worktreePath ?? null }
        : null;
    },
    readWorktreeOwnerRows: async () =>
      (await options.tasks.list()).map((row) => ({
        id: row.id,
        worktreePath: row.worktreePath ?? null,
        status: row.deleted ? "deleted" : row.archived ? "archived" : "active",
      })),
  });
  const pool = createWorktreePool({
    ...common,
    ...live,
    ...dirty,
    ...include,
    ...names,
    ...recycle,
    ...journal,
    ...recordedRecovery,
    ...manager,
    WorktreeManager: manager,
    withLegacyWorktreeRuntimeGuard,
  });
  const source = { readLocalWorktreeReferences };
  const maintenance = createWorktreeRecycleMaintenance({
    ...common,
    ...live,
    ...recycle,
    ...journal,
    ...events,
    ...runtime,
    userDataRoot,
    getReferenceSource: () => source,
  });
  return {
    gitExec: git.gitExec,
    locks, events,
    taskLeases,
    cancellation,
    manager,
    restore,
    pool,
    recycle,
    journal,
    runtime,
    maintenance,
    references,
    store,
    workerProjects: createWorkerWorktreeProjects({ ...common, WorktreeManager: manager }),
    freshBase: createFreshWorktreeBase(common),
    close: async () => {
      await maintenance.stopWorktreeRecycleMaintenance();
      pool.parkAll();
      probe.dispose();
    },
  };
}
