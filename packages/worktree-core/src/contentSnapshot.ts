import { setImmediate } from "node:timers/promises";
import type { GitExecOpts } from "./gitTypes.js";
import fs from "node:fs/promises";

import os from "node:os";

import path from "node:path";

import { createHash } from "node:crypto";
import type { WorktreeManagerPorts } from "./managerPorts.js";
import type { WorktreeRecycleRecord } from "./recycleTypes.js";

export const SNAPSHOT_REF_PREFIX = "refs/cindy/worktree-recovery/";

/** HEAD or the index moved while a snapshot was being captured. */
export class WorktreeChangedDuringSnapshotError extends Error {
  constructor() {
    super("worktree HEAD or index changed during snapshot");
  }
}
export function createWorktreeContentSnapshots(
  ports: Pick<WorktreeManagerPorts, "gitExec" | "GitExecError">,
) {
  const { gitExec, GitExecError } = ports;

  async function indexHash(worktreePath: string): Promise<string> {
    const { stdout } = await gitExec(
      ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      worktreePath,
    );
    return createHash("sha256")
      .update(await fs.readFile(stdout.trim()))
      .digest("hex");
  }

  /** Distinguish a deliberately detached HEAD from an unreadable symbolic ref. */
  async function readWorktreeHeadRef(
    worktreePath: string,
  ): Promise<string | null> {
    try {
      const { stdout } = await gitExec(
        ["symbolic-ref", "--quiet", "HEAD"],
        worktreePath,
      );
      const ref = stdout.trim();
      if (!ref.startsWith("refs/heads/"))
        throw new Error("unsupported worktree HEAD ref");
      return ref;
    } catch (error) {
      if (error instanceof GitExecError && error.exitCode === 1) return null;
      throw error;
    }
  }

  async function worktreeContentBaselineMatches(
    worktreePath: string,
    snapshot: NonNullable<WorktreeRecycleRecord["snapshot"]>,
  ): Promise<boolean> {
    const { stdout } = await gitExec(["rev-parse", "HEAD"], worktreePath);
    return (
      stdout.trim() === snapshot.head &&
      (await indexHash(worktreePath)) === snapshot.indexHash &&
      (snapshot.headRef === undefined ||
        (await readWorktreeHeadRef(worktreePath)) === snapshot.headRef)
    );
  }

  async function withTemporaryIndex<T>(
    run: (env: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    const temp = await fs.mkdtemp(
      path.join(os.tmpdir(), "cindy-worktree-index-"),
    );
    try {
      return await run({
        GIT_INDEX_FILE: path.join(temp, "index"),
        GIT_OPTIONAL_LOCKS: "0",
      });
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }

  async function untrackedNestedRepositories(
    worktreePath: string,
    extraEnv: Record<string, string>,
  ): Promise<string[]> {
    const { stdout } = await gitExec(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      worktreePath,
      { extraEnv },
    );
    return stdout
      .split("\0")
      .filter((entry) => entry.endsWith("/"))
      .map((entry) => entry.slice(0, -1));
  }

  async function unmarkHiddenEdits(
    worktreePath: string,
    extraEnv: Record<string, string>,
  ): Promise<void> {
    const { stdout } = await gitExec(["ls-files", "-v", "-z"], worktreePath, {
      extraEnv,
    });
    const marked: string[] = [];
    for (const entry of stdout.split("\0")) {
      const tag = entry[0];
      if (
        !tag ||
        entry[1] !== " " ||
        (tag === tag.toUpperCase() && tag !== "S")
      )
        continue;
      const file = entry.slice(2);
      if (tag.toUpperCase() === "S") {
        try {
          await fs.lstat(path.join(worktreePath, file));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      marked.push(file);
    }
    for (let start = 0; start < marked.length; start += 200) {
      await gitExec(
        [
          "update-index",
          "--no-assume-unchanged",
          "--no-skip-worktree",
          "--",
          ...marked.slice(start, start + 200),
        ],
        worktreePath,
        { extraEnv },
      );
    }
  }

  async function addWorktreeContent(
    worktreePath: string,
    mode: "--all" | "--update",
    extraEnv: Record<string, string>,
  ): Promise<void> {
    await unmarkHiddenEdits(worktreePath, extraEnv);
    const nested =
      mode === "--all"
        ? await untrackedNestedRepositories(worktreePath, extraEnv)
        : [];
    if (nested.length === 0) {
      await gitExec(["add", mode, "--", "."], worktreePath, { extraEnv });
      return;
    }
    const pathspec = path.join(
      path.dirname(extraEnv.GIT_INDEX_FILE),
      "pathspec",
    );
    await fs.writeFile(
      pathspec,
      [".", ...nested.map((entry) => `:(exclude,literal)${entry}`)].join("\0") +
        "\0",
    );
    await gitExec(
      ["add", mode, `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"],
      worktreePath,
      { extraEnv },
    );
  }

  async function fullContentTree(worktreePath: string): Promise<string> {
    return withTemporaryIndex(async (extraEnv) => {
      const { stdout: indexPath } = await gitExec(
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        worktreePath,
      );
      await fs.copyFile(indexPath.trim(), extraEnv.GIT_INDEX_FILE);
      await addWorktreeContent(worktreePath, "--all", extraEnv);
      const { stdout } = await gitExec(["write-tree"], worktreePath, {
        extraEnv,
      });
      return stdout.trim();
    });
  }

  async function worktreeContentMatches(
    worktreePath: string,
    snapshot: NonNullable<WorktreeRecycleRecord["snapshot"]>,
  ): Promise<boolean> {
    return (
      snapshot.untracked === true &&
      (await worktreeStagedContentMatches(worktreePath, snapshot)) &&
      (await fullContentTree(worktreePath)) === snapshot.tree &&
      (await worktreeStagedContentMatches(worktreePath, snapshot))
    );
  }

  /** Existing files in a partially removed checkout must be covered by the snapshot tree. */
  async function presentFilesMatchSnapshotTree(
    worktreePath: string,
    tree: string,
  ): Promise<boolean> {
    return withTemporaryIndex(async (extraEnv) => {
      await gitExec(["read-tree", tree], worktreePath, { extraEnv });
      await gitExec(["update-index", "-q", "--refresh"], worktreePath, {
        extraEnv,
      }).catch(() => undefined);
      const { stdout: changed } = await gitExec(
        ["diff-files", "--name-status", "-z"],
        worktreePath,
        { extraEnv },
      );
      const fields = changed.split("\0").filter(Boolean);
      for (let index = 0; index < fields.length; index += 2) {
        if (fields[index] !== "D") return false;
      }
      const { stdout: extra } = await gitExec(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        worktreePath,
        { extraEnv },
      );
      return extra
        .split("\0")
        .every((entry) => entry === "" || entry.endsWith("/"));
    });
  }

  /** Restore missing snapshot files without overwriting files written by a user. */
  async function checkoutMissingSnapshotFiles(
    worktreePath: string,
    tree: string,
  ): Promise<void> {
    await withTemporaryIndex(async (extraEnv) => {
      await gitExec(["read-tree", tree], worktreePath, { extraEnv });
      await gitExec(["checkout-index", "--all", "--quiet"], worktreePath, {
        extraEnv,
      }).catch(() => undefined);
      await gitExec(["update-index", "-q", "--refresh"], worktreePath, {
        extraEnv,
      }).catch(() => undefined);
      const { stdout } = await gitExec(
        ["diff-files", "--name-status", "-z", "--diff-filter=D"],
        worktreePath,
        { extraEnv },
      );
      if (stdout.length > 0)
        throw new Error("snapshot files could not be restored");
    });
  }

  async function releaseSnapshotRef(
    baseRepo: string,
    snapshot: Pick<
      NonNullable<WorktreeRecycleRecord["snapshot"]>,
      "ref" | "commit"
    >,
    options?: Pick<GitExecOpts, "timeoutMs" | "deadlineAtMs">,
  ): Promise<boolean> {
    if (!snapshot.ref.startsWith(SNAPSHOT_REF_PREFIX)) return false;
    try {
      await gitExec(
        ["update-ref", "-d", snapshot.ref, snapshot.commit],
        baseRepo,
        options,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Existing snapshot refs and the commits they point to, read with a single Git process. */
  async function listSnapshotRefs(
    baseRepo: string,
    options?: Pick<GitExecOpts, "timeoutMs" | "deadlineAtMs">,
  ): Promise<Map<string, string>> {
    const { stdout } = await gitExec(
      [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)",
        SNAPSHOT_REF_PREFIX,
      ],
      baseRepo,
      options,
    );
    const refs = new Map<string, string>();
    let scanned = 0;
    for (const line of stdout.split("\n")) {
      if (++scanned % 128 === 0) await setImmediate();
      const [ref, commit] = line.trim().split("\0");
      if (ref && commit) refs.set(ref, commit);
    }
    return refs;
  }

  async function snapshotTreePaths(
    baseRepo: string,
    tree: string,
  ): Promise<Set<string>> {
    const { stdout } = await gitExec(
      ["ls-tree", "-r", "-z", "--name-only", tree],
      baseRepo,
    );
    return new Set(stdout.split("\0").filter(Boolean));
  }

  const MAX_DISCARDABLE_ENTRIES = 2_000;
  async function discardableWorktreePaths(
    worktreePath: string,
  ): Promise<string[] | null> {
    const listed = async (args: string[]) =>
      (
        await gitExec(["ls-files", ...args, "-z"], worktreePath, {
          extraEnv: { GIT_OPTIONAL_LOCKS: "0" },
        })
      ).stdout
        .split("\0")
        .filter(Boolean);
    const ignored = await listed([
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
    ]);
    const nested = (await listed(["--others", "--exclude-standard"])).filter(
      (entry) => entry.endsWith("/"),
    );
    const entries = [...new Set([...ignored, ...nested])];
    return entries.length > MAX_DISCARDABLE_ENTRIES ? null : entries;
  }

  /** Staged content of the live index, read from a copy so the live index is never locked or rewritten. */
  async function stagedTree(worktreePath: string): Promise<string | null> {
    const temp = await fs.mkdtemp(
      path.join(os.tmpdir(), "cindy-worktree-index-"),
    );
    const index = path.join(temp, "index");
    try {
      const { stdout: indexPath } = await gitExec(
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        worktreePath,
      );
      await fs.copyFile(indexPath.trim(), index);
      const { stdout } = await gitExec(["write-tree"], worktreePath, {
        extraEnv: { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" },
      });
      return stdout.trim();
    } catch (error) {
      // An index that no longer yields a tree (e.g. new merge conflicts) has changed.
      if (error instanceof GitExecError) return null;
      throw error;
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }

  /**
   * Same HEAD and staged content as the baseline. Unlike the byte hash above, this tolerates
   * stat-cache refreshes (`git status` from another task rewrites the index without changing it),
   * so a long snapshot of a repository in active use is not discarded for nothing.
   */
  async function worktreeStagedContentMatches(
    worktreePath: string,
    snapshot: NonNullable<WorktreeRecycleRecord["snapshot"]>,
  ): Promise<boolean> {
    const { stdout } = await gitExec(["rev-parse", "HEAD"], worktreePath);
    return (
      stdout.trim() === snapshot.head &&
      (snapshot.headRef === undefined ||
        (await readWorktreeHeadRef(worktreePath)) === snapshot.headRef) &&
      (await stagedTree(worktreePath)) === snapshot.indexTree
    );
  }

  /**
   * Snapshot the actual HEAD, index and file tree without stashing or changing the live checkout.
   * `stagedContentOnly` checks consistency like {@link worktreeStagedContentMatches}, for callers
   * that only need the captured content; the default byte comparison suits destructive recycling.
   */
  async function captureWorktreeContent(
    worktreePath: string,
    ref: string,
    {
      stagedContentOnly = false,
      includeUntracked = false,
    }: { stagedContentOnly?: boolean; includeUntracked?: boolean } = {},
  ): Promise<NonNullable<WorktreeRecycleRecord["snapshot"]>> {
    const temp = await fs.mkdtemp(
      path.join(os.tmpdir(), "cindy-worktree-index-"),
    );
    const index = path.join(temp, "index");
    const options = {
      extraEnv: { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" },
    };
    try {
      const { stdout: headOutput } = await gitExec(
        ["rev-parse", "--verify", "HEAD^{commit}"],
        worktreePath,
      );
      const head = headOutput.trim();
      const headRef = await readWorktreeHeadRef(worktreePath);
      const { stdout: indexPath } = await gitExec(
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        worktreePath,
      );
      await fs.copyFile(indexPath.trim(), index);
      const originalIndexHash = createHash("sha256")
        .update(await fs.readFile(index))
        .digest("hex");
      const { stdout: staged } = await gitExec(
        ["write-tree"],
        worktreePath,
        options,
      );
      const indexTree = staged.trim();
      // Untracked/ignored bytes go exclusively to the encrypted recovery archive.
      await addWorktreeContent(
        worktreePath,
        includeUntracked ? "--all" : "--update",
        options.extraEnv,
      );
      const { stdout: contents } = await gitExec(
        ["write-tree"],
        worktreePath,
        options,
      );
      const tree = contents.trim();
      // Retain both trees through the snapshot ref, including staged-only bytes.
      const identity = {
        GIT_AUTHOR_NAME: "Cindy",
        GIT_AUTHOR_EMAIL: "worktree@localhost",
        GIT_COMMITTER_NAME: "Cindy",
        GIT_COMMITTER_EMAIL: "worktree@localhost",
      };
      const commitOptions = { extraEnv: identity };
      const { stdout: indexCommit } = await gitExec(
        ["commit-tree", indexTree, "-p", head, "-m", "Worktree index recovery"],
        worktreePath,
        commitOptions,
      );
      const { stdout: commitOutput } = await gitExec(
        [
          "commit-tree",
          tree,
          "-p",
          head,
          "-p",
          indexCommit.trim(),
          "-m",
          "Worktree content recovery",
        ],
        worktreePath,
        commitOptions,
      );
      const commit = commitOutput.trim();
      await gitExec(["update-ref", ref, commit], worktreePath);
      const snapshot = {
        head,
        headRef,
        tree,
        indexTree,
        commit,
        ref,
        indexHash: originalIndexHash,
        ...(includeUntracked ? { untracked: true as const } : {}),
      };
      try {
        const unchanged =
          stagedContentOnly || includeUntracked
            ? await worktreeStagedContentMatches(worktreePath, snapshot)
            : await worktreeContentBaselineMatches(worktreePath, snapshot);
        if (!unchanged) throw new WorktreeChangedDuringSnapshotError();
      } catch (error) {
        await gitExec(["update-ref", "-d", ref, commit], worktreePath).catch(
          () => undefined,
        );
        throw error;
      }
      return snapshot;
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  return {
    readWorktreeHeadRef,
    worktreeContentBaselineMatches,
    worktreeStagedContentMatches,
    worktreeContentMatches,
    presentFilesMatchSnapshotTree,
    checkoutMissingSnapshotFiles,
    releaseSnapshotRef,
    listSnapshotRefs,
    snapshotTreePaths,
    discardableWorktreePaths,
    captureWorktreeContent,
  };
}
