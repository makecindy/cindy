import type { WorktreeMeta } from "./types.js";
import type { createWorktreeStore, WorktreeStorePorts } from "./store.js";
import type { GitExecError, GitExecOpts, GitExecResult } from "./gitTypes.js";
import type { classifyError } from "./errorClassifier.js";
import type { createCwdProbeScheduler } from "./cwdProbeScheduler.js";

export interface WorktreeRuntimeLease {
  readonly file: string;
  readonly physicalPath: string;
  readonly keepSentinel?: { file?: string; content: string; identity: string };
}
export type WorktreeSessionReference = {
  id: string;
  workingDir?: string | null;
  worktreePath?: string | null;
  status?: string | null;
  source?: string | null;
  currentDatabase?: boolean;
};
export type WorktreeTransferRow = {
  childSessionId: string;
  requestingBotId: string;
  worktreePath: string | null;
  persistedSessionId: string | null;
  targetExists: number;
};

/** Host boundaries only. Git, quarantine, lease and compensation ordering live
 * in the shared manager; a host supplies its actual registry and task storage. */
export type WorktreeManagerPorts = typeof import("./nameGenerator.js") & {
  store: ReturnType<typeof createWorktreeStore>;
  log: {
    info(message: string, ...details: unknown[]): void;
    warn(message: string, ...details: unknown[]): void;
    debug(message: string, ...details: unknown[]): void;
    error(message: string, ...details: unknown[]): void;
  };
  classifyError: typeof classifyError;
  createCwdProbeScheduler: typeof createCwdProbeScheduler;
  GitExecError: typeof GitExecError;
  gitExec(
    args: readonly string[],
    cwd?: string,
    options?: GitExecOpts,
  ): Promise<GitExecResult>;
  globalSafeDirectoryLockPath(): string;
  safeDirectorySpellings(value: string): string[];
  gitPathOutput(value: string): string;
  readAttachedWorktreeBranch(cwd: string): Promise<string | null>;
  realpathWorkingDirectory(cwd: string): Promise<string>;
  withCrossProcessLock: WorktreeStorePorts["withCrossProcessLock"];
  applyWorktreeIncludeFile(
    baseRepo: string,
    worktree: string,
    options?: { overwriteExisting?: boolean },
  ): Promise<Array<{ relpath: string; status: string; error?: string }>>;
  listChangedWorktreeIncludeFiles(
    baseRepo: string,
    worktree: string,
  ): Promise<Array<{ relpath: string; reason: string }>>;
  hasKeepSentinel(worktree: string): boolean;
  isManagedWorktreePath(
    worktree: string,
    baseRepo: string,
    registeredPaths: readonly string[],
  ): boolean;
  isWorktreeDirty(worktree: string): Promise<boolean>;
  listNonReproducibleIgnoredFiles(
    baseRepo: string,
    worktree: string,
  ): Promise<string[]>;
  loadLiveSessionPathKeys(options?: {
    contextPath?: string;
    excludeSessionId?: string;
    isSessionRuntimeAlive?: (id: string) => boolean | undefined;
  }): Promise<ReadonlySet<string> | null>;
  hasLiveSessionReference(
    meta: Pick<WorktreeMeta, "path" | "quarantinePath">,
    keys: ReadonlySet<string> | null,
  ): boolean;
  withWorktreeRestoreMutation<T>(
    id: string,
    action: () => Promise<T>,
  ): Promise<T>;
  recycleManagedWorktree(
    meta: WorktreeMeta,
    options: {
      canRemove?: () => Promise<boolean>;
      isSessionRuntimeAlive?: (id: string) => boolean | undefined;
      onRemoved?: () => Promise<void>;
    },
  ): Promise<boolean>;
  physicalWorktreeKey(path: string): Promise<string>;
  withWorktreeResourceLock<T>(
    path: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  acquireWorktreeRuntimeLease(
    id: string,
    cwd: string,
  ): Promise<WorktreeRuntimeLease | null>;
  recordWorktreeRuntimeLeaseChild(
    lease: WorktreeRuntimeLease,
    pid: number,
  ): void;
  reclaimOrphanedWorktreeRuntimeLeases(path: string): Promise<number>;
  releaseWorktreeRuntimeLease(lease: WorktreeRuntimeLease): Promise<void>;
  assertPrecreatedSessionNotCancelled(id: string): void;
  sealPrecreatedSessionCancellation(id: string): void;
  withPrecreatedSessionOperationLock<T>(
    id: string,
    action: () => Promise<T>,
  ): Promise<T>;
  getManagedWorktreeBasePath(path: string): string | null;
  MANAGED_WORKTREE_DIR_NAME: string;
  readSessionTransfer(
    transfer: NonNullable<WorktreeMeta["pendingSessionTransfer"]>,
  ): Promise<WorktreeTransferRow | null | undefined>;
  readLocalWorktreeReferences(): Promise<WorktreeSessionReference[] | null>;
};
