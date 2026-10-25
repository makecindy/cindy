import fs from "node:fs/promises";
import path from "node:path";
import type {
  WorkerProjectInfo,
  WorkerOwnedWorktree,
} from "@cindy/maker-shared/orca-worker-project";
import type { WorktreeManagerPorts } from "./managerPorts.js";
import type { createWorktreeManager } from "./manager.js";

export interface WorkerProjectProbe extends WorkerProjectInfo {
  commonDir: string | null;
  checkoutRoot: string | null;
  realDirectory: string | null;
}
export function createWorkerWorktreeProjects(
  ports: Pick<WorktreeManagerPorts, "gitExec" | "log"> & {
    WorktreeManager: Pick<
      ReturnType<typeof createWorktreeManager>,
      "getForSession" | "createWorktree" | "awaitBackgroundCheckout"
    >;
  },
) {
  const { gitExec, log, WorktreeManager } = ports;
  const stripEol = (value: string) => value.replace(/[\r\n]+$/, "");
  const identity = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  async function probeWorkerProject(
    directory: string,
    details = true,
  ): Promise<WorkerProjectProbe> {
    const result: WorkerProjectProbe = {
      directory,
      baseRepo: null as string | null,
      branch: null as string | null,
      exists: false,
      dirty: false,
      isWorktree: false,
      worktreeName: undefined as string | undefined,
      commonDir: null as string | null,
      checkoutRoot: null as string | null,
      realDirectory: null as string | null,
    };
    try {
      result.exists = (await fs.stat(directory)).isDirectory();
      if (result.exists) result.realDirectory = await fs.realpath(directory);
    } catch {
      return result;
    }
    if (!result.exists) return result;
    try {
      const options = { timeoutMs: 5000 };
      const { stdout } = await gitExec(
        [
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--git-common-dir",
          "--git-dir",
        ],
        directory,
        options,
      );
      const [root, common, gitDir] = stripEol(stdout).split(/\r?\n/);
      result.checkoutRoot = await fs.realpath(root);
      result.commonDir = await fs.realpath(common);
      result.isWorktree =
        identity(await fs.realpath(gitDir)) !== identity(result.commonDir);
      if (result.isWorktree) result.worktreeName = path.basename(root);
      // worktree list's first entry is the main checkout (also handles separate git dirs).
      const { stdout: list } = await gitExec(
        ["worktree", "list", "--porcelain", "-z"],
        directory,
        options,
      );
      const first = list
        .split("\0")
        .find((line) => line.startsWith("worktree "));
      result.baseRepo = first ? first.slice(9) : root;
      if (!details) return result;
      const { stdout: status } = await gitExec(
        ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
        directory,
        options,
      );
      const lines = stripEol(status).split(/\r?\n/);
      const oid = lines
        .find((line) => line.startsWith("# branch.oid "))
        ?.slice(13);
      const head = lines
        .find((line) => line.startsWith("# branch.head "))
        ?.slice(14);
      if (oid === "(initial)") {
        result.headState = "unborn";
      } else if (oid && head) {
        result.headState = head === "(detached)" ? "detached" : "branch";
        result.branch = result.headState === "detached" ? oid : head;
      }
      result.dirty = lines.some(
        (line) => line.length > 0 && !line.startsWith("# "),
      );
    } catch {
      /* Non-Git directories remain valid projects. */
    }
    return result;
  }

  async function resolveWorkerWorktreeSource(
    directory: string,
    sourceBranch?: string,
    probe: (
      directory: string,
    ) => Promise<WorkerProjectProbe> = probeWorkerProject,
  ): Promise<string> {
    if (
      sourceBranch !== undefined &&
      (typeof sourceBranch !== "string" ||
        !sourceBranch.trim() ||
        sourceBranch.length > 1024 ||
        sourceBranch.startsWith("-") ||
        Array.from(sourceBranch).some(
          (character) => character.charCodeAt(0) < 32,
        ))
    ) {
      throw new Error(
        "Worktree source_branch must be a valid branch or commit",
      );
    }
    const info = await probe(directory);
    if (!info.exists)
      throw new Error("Worker worktree directory does not exist");
    if (!info.baseRepo)
      throw new Error("Worker worktree requires a Git repository");
    if (sourceBranch !== undefined) {
      try {
        await gitExec(
          [
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            `${sourceBranch}^{commit}`,
          ],
          directory,
          { timeoutMs: 5000 },
        );
      } catch {
        throw new Error(
          "Worktree source_branch must reference an existing commit",
        );
      }
      return sourceBranch;
    }
    if (info.headState === "unborn" || !info.branch) {
      throw new Error("Worker worktree requires a repository with a commit");
    }
    return info.branch;
  }

  function getWorkerOwnedWorktree(
    sessionId: string,
  ): WorkerOwnedWorktree | undefined {
    const meta = WorktreeManager.getForSession(sessionId);
    return meta ? { path: meta.path, branch: meta.branch } : undefined;
  }

  async function createWorkerWorktree(
    sessionId: string,
    directory: string,
    sourceBranch: string,
  ): Promise<string> {
    const info = await probeWorkerProject(directory);
    if (!info.baseRepo)
      throw new Error("Worker worktree requires a Git repository");
    const created = await WorktreeManager.createWorktree(
      { sessionId, baseRepo: info.baseRepo, name: "", sourceBranch },
      { trackBackgroundCheckout: true },
    );
    if (!created.ok)
      throw new Error(
        `Worker worktree creation failed: ${created.error.message}`,
      );
    // Probe paths are realpaths, so a symlink spelling cannot change the subproject offset.
    const relative =
      info.checkoutRoot && info.realDirectory
        ? path.relative(info.checkoutRoot, info.realDirectory)
        : "";
    if (!relative) return created.meta.path;

    // Stage checkout only includes root startup files. A subproject and its rules need
    // the full checkout; root-directory Workers keep the normal asynchronous startup.
    await WorktreeManager.awaitBackgroundCheckout(sessionId);
    const subproject = path.join(created.meta.path, relative);
    try {
      const [realRoot, realSubproject] = await Promise.all([
        fs.realpath(created.meta.path),
        fs.realpath(subproject),
      ]);
      const withinRoot = path.relative(
        identity(realRoot),
        identity(realSubproject),
      );
      if (
        withinRoot &&
        withinRoot !== ".." &&
        !withinRoot.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(withinRoot) &&
        (await fs.stat(realSubproject)).isDirectory()
      )
        return subproject;
    } catch {
      // The selected source branch may not contain this subproject.
    }
    log.warn(
      "Worker subproject is unavailable within the new worktree; using its root",
      {
        sessionId,
      },
    );
    return created.meta.path;
  }

  return {
    probeWorkerProject,
    resolveWorkerWorktreeSource,
    getWorkerOwnedWorktree,
    createWorkerWorktree,
  };
}
