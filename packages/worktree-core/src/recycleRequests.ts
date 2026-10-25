import fs from 'node:fs/promises';
import type { WorktreeMeta } from './types.js';
import type { ManagedRecyclePorts } from './managedRecycle.js';
/** Durable intent and generation checks shared by session writes and the recycler. */
export function createWorktreeRecycleRequests(ports: Pick<ManagedRecyclePorts,
 'store' | 'physicalWorktreeKey' | 'withWorktreeResourceLock' | 'worktreeGeneration' |
 'readRecycleRecord' | 'newRecycleRecord' | 'writeRecycleRecord'>) {
 const { store, physicalWorktreeKey, withWorktreeResourceLock, worktreeGeneration,
 readRecycleRecord, newRecycleRecord, writeRecycleRecord } = ports;
  async function directoryIdentity(value: string): Promise<string | null> {
    try {
      const stat = await fs.lstat(value);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("worktree directory identity is unsafe");
      return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function requestWorktreeRecycle(
    sessionId: string,
    resourcePaths: readonly string[] = [],
  ): Promise<void> {
    const own = store.get(sessionId);
    const paths = new Set(
      await Promise.all(resourcePaths.map(physicalWorktreeKey)),
    );
    const candidates = own ? [own] : store.getAll();
    for (const meta of candidates) {
      if (
        meta.ephemeral ||
        (!own && !paths.has(await physicalWorktreeKey(meta.path)))
      )
        continue;
      await withWorktreeResourceLock(meta.path, async () => {
        if (
          worktreeGeneration(store.get(meta.sessionId) ?? meta) !==
            worktreeGeneration(meta) ||
          (await hasOtherGeneration(meta))
        )
          return;
        const previous = await readRecycleRecord(meta.path);
        if (
          previous?.generation === worktreeGeneration(meta) &&
          previous.phase !== "restored"
        )
          return;
        const record = await newRecycleRecord(meta);
        record.directoryIdentity =
          (await directoryIdentity(meta.path)) ?? undefined;
        await writeRecycleRecord(record);
      });
    }
  }

  async function hasOtherGeneration(meta: WorktreeMeta): Promise<boolean> {
    const physicalPath = await physicalWorktreeKey(meta.path);
    for (const entry of store.getAll()) {
      if (
        worktreeGeneration(entry) !== worktreeGeneration(meta) &&
        (await physicalWorktreeKey(entry.path)) === physicalPath
      )
        return true;
    }
    return false;
  }

return { directoryIdentity, requestWorktreeRecycle, hasOtherGeneration };
}
