import path from "node:path";
import type {
  WorktreeRuntimeLease,
  createWorktreeRuntimeLeases,
} from "@cindy/worktree-core/runtimeLeases";
import type { TerminalTaskMeta } from "../tasks/storage.js";
import { atomicPrivateWrite, readPrivateFile } from "../platform.js";

/** Retained tasks must also protect a borrowed GUI worktree while the daemon is
 * stopped. These ordinary v1 leases are understood by already released GUIs;
 * they are retired only after the task stops referencing that directory. */
export class TerminalWorktreeTaskLeases {
  private readonly file: string;
  private readonly entries = new Map<string, WorktreeRuntimeLease[]>();
  private readonly ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly options: {
      root: string;
      appDataRoot: string;
      runtime: ReturnType<typeof createWorktreeRuntimeLeases>;
      guard(): void;
      warn(message: string): void;
      physicalWorktreeKey(value: string): Promise<string>;
    },
  ) {
    this.file = path.join(options.root, "worktree-task-references.json");
    this.ready = this.open();
  }
  private async open() {
    const raw = await readPrivateFile(this.file);
    if (!raw) return;
    const data = JSON.parse(raw.toString()) as {
      version?: unknown;
      entries?: unknown;
    };
    if (data.version !== 1 || !Array.isArray(data.entries))
      throw new Error("WORKTREE_TASK_LEASE_INDEX_INVALID");
    const directory = path.join(
      this.options.appDataRoot,
      "Cindy",
      "shared-worktree-runtime-leases",
    );
    for (const entry of data.entries) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(entry.id) ||
        !Array.isArray(entry.leases)
      )
        throw new Error("WORKTREE_TASK_LEASE_INDEX_INVALID");
      for (const lease of entry.leases) {
        if (
          !lease ||
          typeof lease.file !== "string" ||
          path.dirname(lease.file) !== directory ||
          !/^\d+-[a-f0-9]{64}\.json$/.test(path.basename(lease.file)) ||
          typeof lease.physicalPath !== "string" ||
          !path.isAbsolute(lease.physicalPath) ||
          lease.keepSentinel !== undefined
        )
          throw new Error("WORKTREE_TASK_LEASE_INDEX_INVALID");
      }
      if (this.entries.has(entry.id))
        throw new Error("WORKTREE_TASK_LEASE_INDEX_INVALID");
      this.entries.set(entry.id, entry.leases);
    }
  }
  private serialize(run: () => Promise<void>) {
    const job = this.writes.then(run);
    this.writes = job.catch(() => {});
    return job;
  }
  private persist() {
    return atomicPrivateWrite(
      this.file,
      JSON.stringify({
        version: 1,
        entries: [...this.entries].map(([id, leases]) => ({ id, leases })),
      }),
    );
  }
  private async desired(row: TerminalTaskMeta | null): Promise<Set<string>> {
    const paths = new Set<string>();
    if (!row || row.archived || row.deleted || row.remoteHostId) return paths;
    for (const value of [row.workDir, row.worktreePath]) {
      if (!value) continue;
      const root = this.options.runtime.managedWorktreeRoot(value);
      if (root) paths.add(await this.options.physicalWorktreeKey(root));
    }
    return paths;
  }
  async beforeWrite(
    row: TerminalTaskMeta,
    resources?: ReadonlySet<string>,
  ): Promise<void> {
    await this.ready;
    for (const root of await this.desired(row)) {
      if (resources && !resources.has(root)) continue;
      // Acquire outside the index write lane: another caller can hold a physical
      // resource lock while waiting to publish its independent index update.
      let retained = false;
      for (const lease of this.entries.get(row.id) ?? []) {
        if (lease.physicalPath !== root) continue;
        const raw = await readPrivateFile(lease.file);
        if (!raw) continue;
        const record = JSON.parse(raw.toString());
        if (record.version !== 1 || record.path !== root)
          throw new Error("WORKTREE_TASK_LEASE_INVALID");
        retained = true;
        break;
      }
      if (retained) continue;
      this.options.guard();
      const lease = await this.options.runtime.acquireWorktreeRuntimeLease(
        row.id,
        root,
      );
      if (!lease) throw new Error("WORKTREE_REFERENCE_LEASE_UNAVAILABLE");
      await this.serialize(async () => {
        this.options.guard();
        this.entries.set(row.id, [...(this.entries.get(row.id) ?? []), lease]);
        await this.persist();
      });
    }
  }
  async afterWrite(
    row: TerminalTaskMeta | null,
    id: string,
    resources?: ReadonlySet<string>,
  ): Promise<void> {
    try {
      await this.ready;
      const wanted = await this.desired(row);
      const obsolete = (this.entries.get(id) ?? []).filter(
        (lease) =>
          !wanted.has(lease.physicalPath) &&
          (!resources || resources.has(lease.physicalPath)),
      );
      // A failure after the metadata commit must not make the in-memory task row
      // diverge. Retain the journal and retry at startup; the directory stays held.
      for (const lease of obsolete) {
        try {
          await this.options.runtime.releaseWorktreeRuntimeLease(lease);
          await this.serialize(async () => {
            const remaining = (this.entries.get(id) ?? []).filter(
              (value) => value.file !== lease.file,
            );
            if (remaining.length) this.entries.set(id, remaining);
            else this.entries.delete(id);
            await this.persist();
          });
        } catch {
          this.options.warn("WORKTREE_TASK_LEASE_RELEASE_DEFERRED");
        }
      }
    } catch {
      this.options.warn("WORKTREE_TASK_LEASE_RELEASE_DEFERRED");
    }
  }
  async reconcile(rows: readonly TerminalTaskMeta[]) {
    await this.ready;
    for (const row of rows) {
      await this.beforeWrite(row);
      await this.afterWrite(row, row.id);
    }
    const known = new Set(rows.map((row) => row.id));
    for (const id of this.entries.keys())
      if (!known.has(id)) await this.afterWrite(null, id);
  }
  /** Called before the original session service releases its physical locks.
   * Only touch those roots: acquiring unrelated roots here could deadlock with
   * a concurrent task mutation holding the opposite set of locks. */
  async reconcileResources(
    resources: readonly string[],
    rows: readonly TerminalTaskMeta[],
  ) {
    await this.ready;
    const keys = new Set(
      await Promise.all(
        resources.map((value) => this.options.physicalWorktreeKey(value)),
      ),
    );
    for (const row of rows) {
      await this.beforeWrite(row, keys);
      await this.afterWrite(row, row.id, keys);
    }
    const known = new Set(rows.map((row) => row.id));
    for (const id of this.entries.keys())
      if (!known.has(id)) await this.afterWrite(null, id, keys);
  }
  async flush() {
    await this.ready;
    await this.writes;
  }
}
