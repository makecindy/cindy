import { taskStorageFixture, closeTaskStorageFixtures } from '../testing/task-storage.js';
import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TerminalTaskStorage } from "../tasks/storage.js";
import { TerminalWorktreeRegistry } from "./registry.js";
import type { WorktreeMeta } from "@cindy/worktree-core/types";

const roots: string[] = [];
afterEach(async () => {
  await closeTaskStorageFixtures();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cindy-worktree-registry-"),
  );
  roots.push(root);
  const tasks = await taskStorageFixture(path.join(root, "tasks"));
  await tasks.create({
    id: "owner-task",
    agentKind: "claude-code",
    workDir: root,
    title: "Owner",
    model: "fixture",
  });
  let active = true;
  const create = () =>
    new TerminalWorktreeRegistry({
      root,
      tasks,
      logger: { warn() {} },
      guard: () => {
        if (!active) throw new Error("OWNER_CHANGED");
      },
    });
  const first = create(),
    second = create();
  await Promise.all([first.ready, second.ready]);
  const meta: WorktreeMeta = {
    sessionId: "owner-task",
    name: "fixture",
    path: path.join(root, ".cindy-worktrees", "fixture"),
    baseRepo: root,
    branch: "cindy/fixture",
    sourceBranch: "main",
    createdAt: new Date(0).toISOString(),
    generation: "first",
  };
  return {
    root,
    tasks,
    first,
    second,
    create,
    meta,
    revoke: () => {
      active = false;
    },
  };
}

/** Integration: terminal storage was absent from the shared worktree manager.
 * Two real owner adapters must retain each other's entries, cleanup intents and
 * task snapshots; generation conflicts must not overwrite a newer owner. */
it("persists the shared registry, generation fence and cleanup journal across host instances", async () => {
  const f = await setup();
  await f.first.store.set(f.meta.sessionId, f.meta);
  await f.second.store.set("another-task", {
    ...f.meta,
    sessionId: "another-task",
    path: f.meta.path + "-other",
  });
  expect(f.first.store.getAll()).toHaveLength(2);
  expect(await f.tasks.get(f.meta.sessionId)).toMatchObject({
    worktreePath: f.meta.path,
  });
  await f.first.store.addPendingSafeDirectoryCleanups([f.meta.path]);
  await f.second.store.addPendingSafeDirectoryCleanups([
    f.meta.path + "-other",
  ]);
  await f.first.store.removePendingSafeDirectoryCleanups([f.meta.path]);
  expect(f.second.store.getPendingSafeDirectoryCleanups()).toEqual([
    f.meta.path + "-other",
  ]);
  const replacement = {
    ...f.meta,
    sessionId: "replacement",
    generation: "second",
  };
  await f.second.store.replace(
    f.meta.sessionId,
    replacement.sessionId,
    replacement,
    f.meta,
  );
  await expect(
    f.first.store.replace(
      f.meta.sessionId,
      "stale",
      { ...f.meta, sessionId: "stale" },
      f.meta,
    ),
  ).rejects.toThrow("ownership changed");
  const restarted = f.create();
  await restarted.ready;
  expect(restarted.store.get("replacement")).toEqual(replacement);
  expect(restarted.store.getPendingSafeDirectoryCleanups()).toEqual([
    f.meta.path + "-other",
  ]);
  await restarted.store.del("replacement");
  expect((await f.tasks.get(f.meta.sessionId))?.worktreePath).toBe(f.meta.path);
  f.revoke();
  await expect(
    f.first.store.set("late", { ...f.meta, sessionId: "late" }),
  ).rejects.toThrow("OWNER_CHANGED");
});

/** Security: an unreadable registry must preserve resources, never become an
 * empty successful lookup that authorizes removal. Verify the actual file. */
it("preserves a corrupt registry instead of resetting unknown worktree ownership", async () => {
  const f = await setup();
  const file = path.join(f.root, "worktrees", "worktrees.json");
  const corrupt = '{"worktrees":null}';
  await writeFile(file, corrupt, { mode: 0o600 });
  expect(() => f.first.store.getAll()).toThrow("invalid worktree registry");
  await expect(f.second.store.set(f.meta.sessionId, f.meta)).rejects.toThrow(
    "invalid worktree registry",
  );
  expect(await readFile(file, "utf8")).toBe(corrupt);
  await expect(f.create().ready).rejects.toThrow("invalid worktree registry");
});
