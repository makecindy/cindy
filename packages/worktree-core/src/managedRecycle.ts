import { createWorktreeRecycleRequests } from "./recycleRequests.js";
import {
  deferRecycle,
  recycleFailureReason,
  recyclePolicy,
} from "./recyclePolicy.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sameWorktreeFiles } from "./recoveryArchiveIO.js";
import { isManagedWorktreePath } from "./safety.js";
import { withWorktreeRecycleSlot } from "./recycleQueue.js";
import type { WorktreeMeta } from "./types.js";
import type { WorktreeRecycleRecord } from "./recycleTypes.js";
import type { WorktreeManagerPorts } from "./managerPorts.js";
import type { createWorktreeContentSnapshots } from "./contentSnapshot.js";
import type { createWorktreeRecoveryArchives } from "./recoveryArchive.js";
import type { createWorktreeRecycleJournal } from "./recycleJournal.js";
import type { createWorktreeResourceSafety } from "./resourceSafety.js";

export interface ManagedRecycleOptions {
  canRemove?: () => Promise<boolean>;
  isSessionRuntimeAlive?: (sessionId: string) => boolean | undefined;
  onRemoved?: () => Promise<void>;
}

export type ManagedRecyclePorts = Pick<
  WorktreeManagerPorts,
  | "gitExec"
  | "hasLiveSessionReference"
  | "loadLiveSessionPathKeys"
  | "physicalWorktreeKey"
  | "withWorktreeResourceLock"
  | "store"
> &
  Pick<
    ReturnType<typeof createWorktreeContentSnapshots>,
    | "captureWorktreeContent"
    | "worktreeContentBaselineMatches"
    | "worktreeContentMatches"
    | "worktreeStagedContentMatches"
    | "presentFilesMatchSnapshotTree"
    | "releaseSnapshotRef"
    | "snapshotTreePaths"
    | "discardableWorktreePaths"
  > &
  Pick<
    ReturnType<typeof createWorktreeRecoveryArchives>,
    "createRecoveryArchive" | "inventoryWorktree" | "verifyRecoveryArchive"
  > &
  Pick<
    ReturnType<typeof createWorktreeRecycleJournal>,
    | "newRecycleRecord"
    | "readRecycleRecord"
    | "writeRecycleRecord"
    | "worktreeGeneration"
  > &
  Pick<
    ReturnType<typeof createWorktreeResourceSafety>,
    "assertManagedResourcePath" | "assertWorktreeGitIdentity"
  > & {
    /** Terminal hosts retain an encrypted archive for packaged-worker recovery. */
    archiveOnSnapshot?: boolean;
    withLegacyWorktreeRuntimeGuard<T>(
      task: (held: () => boolean) => Promise<T>,
    ): Promise<T>;
  };

export function createManagedWorktreeRecycle(ports: ManagedRecyclePorts) {
  const {
    captureWorktreeContent,
    worktreeContentBaselineMatches,
    worktreeContentMatches,
    worktreeStagedContentMatches,
    presentFilesMatchSnapshotTree,
    releaseSnapshotRef,
    snapshotTreePaths,
    discardableWorktreePaths,
    gitExec,
    hasLiveSessionReference,
    loadLiveSessionPathKeys,
    newRecycleRecord,
    readRecycleRecord,
    writeRecycleRecord,
    worktreeGeneration,
    createRecoveryArchive,
    inventoryWorktree,
    verifyRecoveryArchive,
    physicalWorktreeKey,
    withWorktreeResourceLock,
    assertManagedResourcePath,
    assertWorktreeGitIdentity,
    store,
    withLegacyWorktreeRuntimeGuard,
    archiveOnSnapshot = false,
  } = ports;
  const { directoryIdentity, requestWorktreeRecycle, hasOtherGeneration } =
    createWorktreeRecycleRequests(ports);

  async function hasGitLink(worktreePath: string): Promise<boolean> {
    try {
      await fs.lstat(path.join(worktreePath, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async function residualFilesAllowed(
    root: string,
    sinceMs: number,
    saved: ReadonlySet<string> | null,
    discardable: readonly string[] | null,
  ): Promise<boolean> {
    const discarded = (relative: string): boolean =>
      discardable!.some((entry) =>
        entry.endsWith("/")
          ? `${relative}/` === entry || relative.startsWith(entry)
          : relative === entry,
      );
    const walk = async (
      directory: string,
      prefix: string,
    ): Promise<boolean> => {
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
      for (const entry of entries) {
        const relative = `${prefix}${entry.name}`;
        const entryPath = path.join(directory, entry.name);
        if (relative === ".git") continue;
        if (entry.isDirectory()) {
          if (saved && discarded(relative)) continue;
          if (!(await walk(entryPath, `${relative}/`))) return false;
          continue;
        }
        let stat;
        try {
          stat = await fs.lstat(entryPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (Math.max(stat.mtimeMs, stat.birthtimeMs) > sinceMs) return false;
        if (saved && !saved.has(relative) && !discarded(relative)) return false;
      }
      return true;
    };
    return walk(root, "");
  }

  async function residualFilesCovered(
    meta: WorktreeMeta,
    record: WorktreeRecycleRecord,
    snapshot: NonNullable<WorktreeRecycleRecord["snapshot"]>,
  ): Promise<boolean> {
    if (record.archive) {
      await verifyRecoveryArchive(record.archive);
      if (
        !sameWorktreeFiles(
          await inventoryWorktree(meta.path),
          record.archive.files,
          true,
        )
      )
        return false;
    } else {
      const since = record.removingSince;
      if (typeof since !== "number" || !Number.isFinite(since)) return false;
      const discardable = Array.isArray(record.removalDiscardable)
        ? record.removalDiscardable
        : null;
      const saved = discardable
        ? await snapshotTreePaths(meta.baseRepo, snapshot.tree)
        : null;
      if (!(await residualFilesAllowed(meta.path, since, saved, discardable)))
        return false;
    }
    if (!(await hasGitLink(meta.path))) return true;
    await assertWorktreeGitIdentity(meta);
    return worktreeStagedContentMatches(meta.path, snapshot);
  }

  /** Pool reset is destructive too: preserve the old generation before clean/reset. */
  async function checkpointWorktreeForReuse(meta: WorktreeMeta): Promise<void> {
    const current = store.get(meta.sessionId);
    if (
      !current ||
      current.pendingSessionTransfer ||
      worktreeGeneration(current) !== worktreeGeneration(meta) ||
      (await hasOtherGeneration(meta))
    )
      throw new Error("pooled generation changed");
    await assertManagedResourcePath(meta, store.getAllPaths());
    await assertWorktreeGitIdentity(meta);
    if (
      hasLiveSessionReference(
        meta,
        await loadLiveSessionPathKeys({ contextPath: meta.path }),
      )
    ) {
      throw new Error("pooled worktree is referenced");
    }
    const previous = await readRecycleRecord(meta.path);
    if (
      previous?.generation === worktreeGeneration(meta) &&
      ["paused", "kept"].includes(recyclePolicy(previous).state)
    ) {
      throw new Error("pooled worktree recycling is paused");
    }
    const record = await newRecycleRecord(meta);
    record.directoryIdentity =
      (await directoryIdentity(meta.path)) ?? undefined;
    if (
      !record.directoryIdentity ||
      !isManagedWorktreePath(meta.path, meta.baseRepo, store.getAllPaths())
    ) {
      throw new Error("pooled worktree path is unsafe");
    }
    const gitLink = await fs.lstat(path.join(meta.path, ".git"));
    if (!gitLink.isFile() || gitLink.isSymbolicLink())
      throw new Error("pooled worktree Git link is missing");
    const snapshot = await captureWorktreeContent(
      meta.path,
      `refs/cindy/worktree-recovery/${record.id}/${randomUUID()}`,
      { includeUntracked: true },
    );
    record.snapshot = snapshot;
    try {
      if (
        hasLiveSessionReference(
          meta,
          await loadLiveSessionPathKeys({ contextPath: meta.path }),
        ) ||
        !(await worktreeContentMatches(meta.path, snapshot))
      ) {
        throw new Error("pooled worktree changed before reuse");
      }
    } catch (error) {
      await releaseSnapshotRef(meta.baseRepo, snapshot);
      throw error;
    }
    await assertManagedResourcePath(meta, store.getAllPaths());
    await assertWorktreeGitIdentity(meta);
    if ((await directoryIdentity(meta.path)) !== record.directoryIdentity)
      throw new Error("pooled directory replaced");
    record.phase = "removed";
    await writeRecycleRecord(record);
  }

  /** Written before the terminal status mutation, so a crash cannot lose the cleanup intent. */

  /** Complete a single durable request. Failure preserves registration and retry evidence. */
  async function recycleManagedWorktree(
    meta: WorktreeMeta,
    options: ManagedRecycleOptions,
  ): Promise<boolean> {
    return withWorktreeRecycleSlot(() =>
      recycleManagedWorktreeInSlot(meta, options),
    );
  }

  async function recycleManagedWorktreeInSlot(
    meta: WorktreeMeta,
    options: ManagedRecycleOptions,
  ): Promise<boolean> {
    return withWorktreeResourceLock(meta.path, () =>
      withLegacyWorktreeRuntimeGuard(async (legacyGuardHeld) => {
        const registered = store.get(meta.sessionId);
        if (registered?.pendingSessionTransfer) return false;
        if (
          registered &&
          worktreeGeneration(registered) !== worktreeGeneration(meta)
        )
          return false;
        if (await hasOtherGeneration(meta)) return false;
        let record = await readRecycleRecord(meta.path);
        if (!record || record.generation !== worktreeGeneration(meta)) {
          record = await newRecycleRecord(meta);
          record.directoryIdentity =
            (await directoryIdentity(meta.path)) ?? undefined;
          await writeRecycleRecord(record);
        }
        const policy = recyclePolicy(record);
        if (policy.state === "paused" || policy.state === "kept") return false;
        const startedAt = performance.now();
        const defer = async (reason: string): Promise<false> => {
          deferRecycle(record, reason, performance.now() - startedAt);
          await writeRecycleRecord(record);
          return false;
        };
        const ownerAllowsRemoval = async (): Promise<boolean> => {
          if (!legacyGuardHeld()) return false;
          if (!options.canRemove || !(await options.canRemove())) return false;
          const current = store.get(meta.sessionId);
          return !current || worktreeGeneration(current) === record.generation;
        };
        const canRemove = async (): Promise<boolean> => {
          if (!(await ownerAllowsRemoval())) return false;
          const refs = await loadLiveSessionPathKeys({
            contextPath: meta.path,
            excludeSessionId: meta.sessionId,
            isSessionRuntimeAlive: options.isSessionRuntimeAlive,
          });
          return !hasLiveSessionReference(
            { ...meta, path: await physicalWorktreeKey(meta.path) },
            refs,
          );
        };
        try {
          if (meta.quarantinePath)
            return defer("legacy-quarantine-needs-review");
          if (!(await ownerAllowsRemoval()))
            return defer("referenced-or-runtime-unavailable");
          const identity = await directoryIdentity(meta.path);
          if (identity === null) {
            // No directory remains to delete; retain other owners' registrations.
            record.phase = "removed";
            record.reason = undefined;
            await writeRecycleRecord(record);
            await gitExec(["worktree", "prune"], meta.baseRepo).catch(
              () => undefined,
            );
            await options.onRemoved?.();
            if (await canRemove()) await unregisterResource(meta);
            else await store.del(meta.sessionId);
            return true;
          }
          if (!(await canRemove()))
            return defer("referenced-or-runtime-unavailable");
          if (record.directoryIdentity && identity !== record.directoryIdentity)
            return defer("directory-replaced");
          if (
            !isManagedWorktreePath(
              meta.path,
              meta.baseRepo,
              store.getAllPaths(),
            )
          )
            return defer("unmanaged-path");
          const realParent = await physicalWorktreeKey(path.dirname(meta.path));
          const expectedParent = path.join(
            await physicalWorktreeKey(meta.baseRepo),
            path.basename(path.dirname(meta.path)),
          );
          if (realParent !== expectedParent)
            return defer("redirected-worktree-parent");
          try {
            await fs.lstat(path.join(meta.path, ".worktree-keep"));
            return defer("keep-sentinel");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          record.directoryIdentity = identity;
          await assertManagedResourcePath(meta, store.getAllPaths());
          const partialRemoval =
            record.phase === "removing" && Boolean(record.snapshot);
          if (!partialRemoval) {
            // A missing .git must never fall through to the parent repository.
            await assertWorktreeGitIdentity(meta);
            let superseded: WorktreeRecycleRecord["snapshot"];
            if (
              !record.snapshot ||
              !(await worktreeContentMatches(meta.path, record.snapshot))
            ) {
              superseded = record.snapshot;
              record.snapshot = await captureWorktreeContent(
                meta.path,
                `refs/cindy/worktree-recovery/${record.id}/${randomUUID()}`,
                { includeUntracked: true },
              );
              // Terminal hosts keep the encrypted archive alongside the Git
              // snapshot; Desktop retains its existing snapshot-only path.
              record.archive = archiveOnSnapshot
                ? await createRecoveryArchive(meta.path, record.id)
                : undefined;
            }
            record.phase = "snapshotted";
            await writeRecycleRecord(record);
            if (superseded && superseded.ref !== record.snapshot.ref)
              await releaseSnapshotRef(meta.baseRepo, superseded);
          }
          const snapshot = record.snapshot;
          if (!snapshot) return defer("recovery-evidence-missing");
          const contentUnchanged = async (): Promise<boolean> => {
            if (record.phase === "removing")
              return residualFilesCovered(meta, record, snapshot);
            if (!(await hasGitLink(meta.path))) return false;
            await assertWorktreeGitIdentity(meta);
            return worktreeContentMatches(meta.path, snapshot);
          };
          if (!(await canRemove())) return defer("referenced-before-removal");
          if ((await directoryIdentity(meta.path)) !== identity)
            return defer("directory-replaced");
          await assertManagedResourcePath(meta, store.getAllPaths());
          if (!(await contentUnchanged()))
            return defer(
              partialRemoval
                ? "residual-files-changed"
                : "git-baseline-changed",
            );
          if (!partialRemoval) {
            const since = Date.now();
            if (!(await canRemove())) return defer("referenced-before-removal");
            if ((await directoryIdentity(meta.path)) !== identity)
              return defer("directory-replaced");
            await assertManagedResourcePath(meta, store.getAllPaths());
            await assertWorktreeGitIdentity(meta);
            if (!(await worktreeContentMatches(meta.path, snapshot)))
              return defer("git-baseline-changed-before-removal");
            record.removalDiscardable =
              (await discardableWorktreePaths(meta.path)) ?? undefined;
            record.removingSince = since;
            record.phase = "removing";
            await writeRecycleRecord(record);
          }
          try {
            await gitExec(
              [
                "-c",
                "core.longpaths=true",
                "worktree",
                "remove",
                "--force",
                meta.path,
              ],
              meta.baseRepo,
            );
          } catch {
            // Git may remove .git before Windows reports EBUSY. Only delete surviving
            // bytes still covered by this generation's authenticated recovery archive.
            if ((await directoryIdentity(meta.path)) !== identity)
              return defer("remove-unconfirmed");
            if (!(await canRemove()))
              return defer("referenced-before-fallback");
            if (!(await residualFilesCovered(meta, record, snapshot)))
              return defer("residual-files-changed");
            await assertManagedResourcePath(meta, store.getAllPaths());
            if (await hasGitLink(meta.path)) {
              await assertWorktreeGitIdentity(meta);
              if (!(await worktreeStagedContentMatches(meta.path, snapshot)))
                return defer("git-baseline-changed");
            }
            if ((await directoryIdentity(meta.path)) !== identity)
              return defer("directory-replaced");
            await fs.rm(meta.path, { recursive: true, force: true });
          }
          if ((await directoryIdentity(meta.path)) !== null)
            return defer("directory-still-present");
          await gitExec(["worktree", "prune"], meta.baseRepo);
          record.phase = "removed";
          record.reason = undefined;
          await writeRecycleRecord(record);
          await options.onRemoved?.();
          await unregisterResource(meta);
          return true;
        } catch (error) {
          return defer(recycleFailureReason(error));
        }
      }),
    );
  }

  async function unregisterResource(meta: WorktreeMeta): Promise<void> {
    const physicalPath = await physicalWorktreeKey(meta.path);
    for (const entry of store.getAll()) {
      if ((await physicalWorktreeKey(entry.path)) === physicalPath)
        await store.del(entry.sessionId);
    }
  }

  return {
    checkpointWorktreeForReuse,
    requestWorktreeRecycle,
    recycleManagedWorktree,
  };
}
