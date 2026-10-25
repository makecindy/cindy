import { randomBytes } from "node:crypto";
import type { createRecoveryArchiveWorkerClient } from "./recoveryArchiveWorkerClient.js";
import type {
  FileEvidence,
  WorktreeRecoveryArchive,
} from "./recoveryArchiveIO.js";

export type { WorktreeRecoveryArchive } from "./recoveryArchiveIO.js";
export { sameWorktreeFiles } from "./recoveryArchiveIO.js";

export function createWorktreeRecoveryArchives(
  ports: ReturnType<typeof createRecoveryArchiveWorkerClient> & {
    recycleJournalRoot(): string;
    wrapArchiveKey(key: Buffer): Promise<string>;
    unwrapArchiveKey(encryptedKey: string): Promise<Buffer>;
  },
) {
  const { runRecoveryArchiveTask, recycleJournalRoot } = ports;

  function inventoryWorktree(
    root: string,
  ): Promise<Record<string, FileEvidence>> {
    return runRecoveryArchiveTask({ operation: "inventory", root });
  }

  async function createRecoveryArchive(
    root: string,
    resourceId: string,
  ): Promise<WorktreeRecoveryArchive> {
    const key = randomBytes(32);
    try {
      const encryptedKey = await ports.wrapArchiveKey(key);
      return await runRecoveryArchiveTask({
        operation: "create",
        root,
        resourceId,
        directory: recycleJournalRoot(),
        key,
        encryptedKey,
        iv: randomBytes(12),
      });
    } finally {
      key.fill(0);
    }
  }

  async function withArchiveKey<T>(
    archive: WorktreeRecoveryArchive,
    run: (key: Buffer) => Promise<T>,
  ): Promise<T> {
    const key = await ports.unwrapArchiveKey(archive.encryptedKey);
    try {
      return await run(key);
    } finally {
      key.fill(0);
    }
  }

  function verifyRecoveryArchive(
    archive: WorktreeRecoveryArchive,
  ): Promise<void> {
    return withArchiveKey(archive, (key) =>
      runRecoveryArchiveTask({
        operation: "verify",
        archive,
        directory: recycleJournalRoot(),
        key,
      }),
    );
  }

  function extractRecoveryArchive(
    archive: WorktreeRecoveryArchive,
    staging: string,
    keep = false,
  ): Promise<void> {
    return withArchiveKey(archive, (key) =>
      runRecoveryArchiveTask({
        operation: "extract",
        archive,
        staging,
        keep,
        directory: recycleJournalRoot(),
        key,
      }),
    );
  }

  return {
    inventoryWorktree,
    createRecoveryArchive,
    verifyRecoveryArchive,
    extractRecoveryArchive,
  };
}
