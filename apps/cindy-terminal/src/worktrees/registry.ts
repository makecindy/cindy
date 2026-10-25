import path from "node:path";
import {
  createWorktreeStore,
  type WorktreeJsonStore,
} from "@cindy/worktree-core/store";
import { withCrossProcessLock } from "@cindy/remote-agent/crossProcessLock";
import {
  atomicPrivateWriteSync,
  privateDirectory,
  readPrivateFileSync,
} from "../platform.js";
import type { TerminalTaskStorage } from "../tasks/storage.js";

/** Fresh disk reads inside the shared registry lock preserve other processes'
 * changes. The owner task journal remains a display snapshot, as in Desktop. */
export class TerminalWorktreeRegistry {
  readonly ready: Promise<void>;
  readonly store: ReturnType<typeof createWorktreeStore>;
  private opened = false;
  constructor(options: {
    root: string;
    tasks: TerminalTaskStorage;
    guard(): void;
    logger: { warn(message: string, detail?: string): void };
  }) {
    const root = path.join(options.root, "worktrees");
    const guard = () => {
      options.guard();
      if (!this.opened) throw new Error("WORKTREE_STORE_NOT_READY");
    };
    const json = <T extends object>(name: string): WorktreeJsonStore<T> => {
      const file = path.join(root, name + ".json");
      const read = (): Partial<T> => {
        guard();
        const bytes = readPrivateFileSync(file);
        if (!bytes) return {};
        const value: unknown = JSON.parse(bytes.toString());
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("INVALID_WORKTREE_REGISTRY");
        return value as Partial<T>;
      };
      return {
        get: (key, fallback) => {
          const value = read();
          return key in value ? (value[key] as T[typeof key]) : fallback;
        },
        set: (key, value) => {
          const current = read();
          guard();
          atomicPrivateWriteSync(
            file,
            JSON.stringify({ ...current, [key]: value }),
          );
        },
      };
    };
    const worktrees = json<{
      worktrees: Record<
        string,
        import("@cindy/worktree-core/types").WorktreeMeta
      >;
    }>("worktrees");
    const cleanup = json<{ pending: string[] }>(
      "worktree-safe-directory-cleanup",
    );
    this.store = createWorktreeStore({
      getStore: () => worktrees,
      getCleanupStore: () => cleanup,
      withCrossProcessLock,
      log: options.logger,
      setWorktreePathInDb: async (id, worktreePath) => {
        guard();
        if (await options.tasks.get(id)) {
          guard();
          await options.tasks.update(id, { worktreePath });
        }
      },
    });
    this.ready = privateDirectory(root).then(() => {
      options.guard();
      this.opened = true;
      this.store.getAll();
    });
  }
}
