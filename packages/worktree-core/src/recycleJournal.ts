import { setImmediate } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";

import { watch } from "node:fs";

import fs from "node:fs/promises";

import path from "node:path";
import type { WorktreeManagerPorts } from "./managerPorts.js";
import type { WorktreeMeta } from "./types.js";
import type { WorktreeRecycleRecord } from "./recycleTypes.js";
export type { WorktreeRecycleRecord } from "./recycleTypes.js";

export function createWorktreeRecycleJournal(
  ports: Pick<WorktreeManagerPorts, "physicalWorktreeKey" | "log"> & {
    userDataRoot(): string;
    appDataRoot(): string;
    worktreeResourceId(key: string): string;
    notifyWorktreeRecycleRecordChanged(id: string): void;
  },
) {
  const {
    physicalWorktreeKey,
    log,
    worktreeResourceId,
    notifyWorktreeRecycleRecordChanged,
  } = ports;

  function recycleJournalRoot(): string {
    return path.join(ports.userDataRoot(), "worktree-recycle");
  }

  function sharedJournalLocationsRoot(): string {
    return path.join(
      ports.appDataRoot(),
      "Cindy",
      "shared-worktree-recycle-journals",
    );
  }

  /** Keep publishing locators for older clients that may still borrow across profiles. */
  async function publishJournalLocation(root: string): Promise<void> {
    const directory = sharedJournalLocationsRoot();
    const id = createHash("sha256").update(root).digest("hex");
    await fs.mkdir(directory, { recursive: true });
    await writeRecordFile(path.join(directory, `${id}.json`), {
      version: 1,
      root,
    });
  }

  function worktreeGeneration(meta: WorktreeMeta): string {
    return meta.generation ?? `${meta.sessionId}:${meta.createdAt}`;
  }

  function parseRecord(raw: string, id: string): WorktreeRecycleRecord {
    const record = JSON.parse(raw) as WorktreeRecycleRecord;
    if (
      !record ||
      record.version !== 1 ||
      record.id !== id ||
      !record.meta ||
      typeof record.generation !== "string" ||
      !record.generation ||
      typeof record.meta.sessionId !== "string" ||
      !record.meta.sessionId ||
      typeof record.meta.path !== "string" ||
      !path.isAbsolute(record.meta.path) ||
      typeof record.meta.baseRepo !== "string" ||
      !path.isAbsolute(record.meta.baseRepo) ||
      (record.restoreCheckoutPath !== undefined &&
        (typeof record.restoreCheckoutPath !== "string" ||
          !path.isAbsolute(record.restoreCheckoutPath))) ||
      typeof record.requestedAt !== "string" ||
      !Number.isFinite(Date.parse(record.requestedAt)) ||
      !Number.isInteger(record.attempts) ||
      record.attempts < 0 ||
      (record.retryPolicy !== undefined &&
        (!record.retryPolicy ||
          !["retrying", "waiting", "paused", "kept"].includes(
            record.retryPolicy.state,
          ) ||
          !Number.isInteger(record.retryPolicy.failures) ||
          record.retryPolicy.failures < 0 ||
          !Number.isFinite(record.retryPolicy.failedWorkMs) ||
          record.retryPolicy.failedWorkMs < 0)) ||
      !Number.isFinite(record.nextAttemptAt) ||
      ![
        "pending",
        "snapshotted",
        "removing",
        "removed",
        "restoring",
        "restored",
      ].includes(record.phase)
    ) {
      throw new Error("invalid worktree recycle record");
    }
    return record;
  }

  async function readRecycleRecord(
    value: string,
    sessionId?: string,
  ): Promise<WorktreeRecycleRecord | null> {
    const id = worktreeResourceId(await physicalWorktreeKey(value));
    try {
      const record = parseRecord(
        await fs.readFile(
          path.join(recycleJournalRoot(), `${id}.json`),
          "utf8",
        ),
        id,
      );
      if (!sessionId || record.meta.sessionId === sessionId) return record;
      const history = path.join(recycleJournalRoot(), "history");
      let names: string[];
      try {
        names = await fs.readdir(history);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const matches: WorktreeRecycleRecord[] = [];
      for (const name of names.filter(
        (name) => name.startsWith(`${id}-`) && name.endsWith(".json"),
      )) {
        const candidate = parseRecord(
          await fs.readFile(path.join(history, name), "utf8"),
          id,
        );
        if (candidate.meta.sessionId === sessionId) matches.push(candidate);
      }
      return (
        matches.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0] ??
        null
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Caller holds the physical resource lock. Atomic per-resource files cannot lose another resource's update. */
  async function writeRecycleRecord(
    record: WorktreeRecycleRecord,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(record.id))
      throw new Error("invalid worktree resource id");
    const root = recycleJournalRoot();
    await fs.mkdir(root, { recursive: true });
    // Must be discoverable before committing an intent that permits destructive I/O.
    await publishJournalLocation(root);
    if (record.snapshot && record.phase === "removed") {
      const history = path.join(root, "history");
      await fs.mkdir(history, { recursive: true });
      const key = createHash("sha256")
        .update(
          `${record.generation}:${record.requestedAt}:${record.snapshot.commit}`,
        )
        .digest("hex");
      await writeRecordFile(
        path.join(history, `${record.id}-${key}.json`),
        record,
      );
    }
    await writeRecordFile(path.join(root, `${record.id}.json`), record);
    notifyWorktreeRecycleRecordChanged(record.id);
  }

  /** Watch atomic journal replacements, not archive bytes, temporary files or history. */
  async function watchRecycleJournal(
    onChange: () => void,
    onError: (error: unknown) => void,
  ): Promise<() => void> {
    const root = recycleJournalRoot();
    await fs.mkdir(root, { recursive: true });
    // Expose pre-upgrade requests too, even when their retry deadline is in the future.
    await publishJournalLocation(root);
    const watcher = watch(root, { persistent: false }, (_event, filename) => {
      if (filename === null || /^[a-f0-9]{64}\.json$/.test(filename.toString()))
        onChange();
    });
    watcher.on("error", onError);
    return () => watcher.close();
  }

  async function writeRecordFile(
    target: string,
    record: WorktreeRecycleRecord | { version: 1; root: string },
  ): Promise<void> {
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  async function newRecycleRecord(
    meta: WorktreeMeta,
  ): Promise<WorktreeRecycleRecord> {
    return {
      version: 1,
      id: worktreeResourceId(await physicalWorktreeKey(meta.path)),
      generation: worktreeGeneration(meta),
      meta,
      requestedAt: new Date().toISOString(),
      phase: "pending",
      attempts: 0,
      nextAttemptAt: 0,
    };
  }

  /** Fail closed for a malformed file; callers report the failure without discarding evidence. */
  async function listRecycleRecords(): Promise<WorktreeRecycleRecord[]> {
    let names: string[];
    try {
      names = await fs.readdir(recycleJournalRoot());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: WorktreeRecycleRecord[] = [];
    const candidates = names
      .filter((value) => /^[a-f0-9]{64}\.json$/.test(value))
      .map((value) => ({ file: value, id: value.slice(0, -5) }));
    try {
      const history = await fs.readdir(
        path.join(recycleJournalRoot(), "history"),
      );
      for (const name of history.filter((value) => value.endsWith(".json"))) {
        const id = name.slice(0, 65).replace(/-.*/, "");
        if (/^[a-f0-9]{64}$/.test(id))
          candidates.push({ file: path.join("history", name), id });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const candidate of candidates) {
      try {
        records.push(
          parseRecord(
            await fs.readFile(
              path.join(recycleJournalRoot(), candidate.file),
              "utf8",
            ),
            candidate.id,
          ),
        );
      } catch {
        log.warn("invalid worktree recycle request preserved", {
          resourceId: candidate.id,
        });
      }
    }
    return records;
  }
  async function listRecycleRecordsWithHistory(): Promise<
    WorktreeRecycleRecord[] | null
  > {
    const root = recycleJournalRoot();
    const files: Array<{ file: string; id: string }> = [];
    let scanned = 0;
    for (const [directory, pattern] of [
      [root, /^[a-f0-9]{64}\.json$/],
      [path.join(root, "history"), /^[a-f0-9]{64}-[a-f0-9]{64}\.json$/],
    ] as const) {
      let names: string[];
      try {
        names = await fs.readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const name of names) {
        if (++scanned % 128 === 0) await setImmediate();
        if (pattern.test(name))
          files.push({
            file: path.join(directory, name),
            id: name.slice(0, 64),
          });
      }
    }
    const records: WorktreeRecycleRecord[] = [];
    for (const { file, id } of files) {
      try {
        records.push(parseRecord(await fs.readFile(file, "utf8"), id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        log.warn("worktree recycle sweep skipped: unreadable record", {
          resourceId: id,
        });
        return null;
      }
    }
    return records;
  }

  const archiveNamePattern = /^[a-f0-9-]+\.tar\.gz\.enc$/;
  /** Older clients may still be writing an archive in a shared profile; their writes finish well within this. */
  const ORPHAN_ARCHIVE_MIN_AGE_MS = 2 * 60 * 60_000;

  /**
   * Delete recovery archives no record points to. Older clients left one per interrupted attempt;
   * its key lived only in the unsaved record, so nothing can ever decrypt it. Any unreadable
   * record skips the sweep, since it might reference an archive.
   */
  async function pruneUnreferencedRecoveryArchives(
    now = Date.now(),
  ): Promise<number> {
    const root = recycleJournalRoot();
    let names: string[];
    try {
      names = await fs.readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    const archives = names.filter((name) => archiveNamePattern.test(name));
    if (archives.length === 0) return 0;
    const records = await listRecycleRecordsWithHistory();
    if (!records) return 0;
    const referenced = new Set<string>();
    for (const record of records)
      if (record.archive?.file) referenced.add(record.archive.file);
    let removed = 0;
    for (const name of archives) {
      if (referenced.has(name)) continue;
      const file = path.join(root, name);
      try {
        if (now - (await fs.stat(file)).mtimeMs < ORPHAN_ARCHIVE_MIN_AGE_MS)
          continue;
        await fs.rm(file, { force: true });
        removed++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return removed;
  }

  return {
    pruneUnreferencedRecoveryArchives,
    listRecycleRecordsWithHistory,
    recycleJournalRoot,
    worktreeGeneration,
    readRecycleRecord,
    writeRecycleRecord,
    watchRecycleJournal,
    newRecycleRecord,
    listRecycleRecords,
  };
}
