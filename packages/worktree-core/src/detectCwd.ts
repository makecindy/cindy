import path from "node:path";
import type { DetectCwdResp } from "./types.js";
import type { WorktreeManagerPorts } from "./managerPorts.js";
export function createDirectoryProbe(
  ports: Pick<
    WorktreeManagerPorts,
    | "createCwdProbeScheduler"
    | "gitExec"
    | "GitExecError"
    | "realpathWorkingDirectory"
    | "gitPathOutput"
    | "getManagedWorktreeBasePath"
  >,
) {
  const {
    createCwdProbeScheduler,
    gitExec,
    GitExecError,
    realpathWorkingDirectory,
    gitPathOutput,
    getManagedWorktreeBasePath,
  } = ports;
  const detectCwd = createCwdProbeScheduler(detectCwdOnce);

  // Share the work budget across realpath and every Git query. Git's additional
  // 3s process-tree cleanup still leaves response headroom under Mobile's 15s wait.
  const CWD_PROBE_TIMEOUT_MS = 10_000;

  async function detectCwdOnce(cwd: string): Promise<DetectCwdResp> {
    const deadline = performance.now() + CWD_PROBE_TIMEOUT_MS;
    const probeGit = async (args: readonly string[], dir?: string) => {
      const timeoutMs = Math.ceil(deadline - performance.now());
      if (timeoutMs <= 0) {
        throw new GitExecError({
          args,
          exitCode: null,
          stdout: "",
          stderr: "directory probe deadline exceeded",
          timedOut: true,
        });
      }
      return gitExec(args, dir, { timeoutMs, deadlineAtMs: deadline });
    };
    // Git resolves relative metadata paths from the physical process cwd. A
    // symlink spelling can otherwise make an ordinary repo look like a linked
    // worktree. Keep Git's existing error handling if the directory is unavailable.
    cwd = await realpathWorkingDirectory(cwd).catch((err) => {
      // Keep timeout/pool exhaustion unknown; falling back to a symlink spelling
      // could recreate the false linked-worktree result we are trying to avoid.
      if (
        err?.code === "WORKDIR_PROBE_TIMEOUT" ||
        err?.code === "WORKDIR_PROBE_UNAVAILABLE"
      )
        throw err;
      return cwd;
    });
    // One Git process returns the same snapshot that previously needed five.
    // Unborn HEADs, older Git versions and newline-containing paths retain the
    // individual-query fallback below rather than changing the IPC contract.
    try {
      const { stdout } = await probeGit(
        [
          "rev-parse",
          "--show-toplevel",
          "--abbrev-ref",
          "HEAD",
          "--git-dir",
          "--git-common-dir",
        ],
        cwd,
      );
      const lines = gitPathOutput(stdout).split(
        process.platform === "win32" ? /\r?\n/ : /\n/,
      );
      if (lines.length === 4 && lines.every((line) => line.trim().length > 0)) {
        const [root, branch, gitDir, commonDir] = lines;
        return {
          isGitRepo: true,
          isInsideWorktree:
            path.resolve(cwd, gitDir) !== path.resolve(cwd, commonDir),
          gitInstalled: true,
          supportsRecoveryKeyDiscard: true,
          repoRoot: path.resolve(root),
          ...(branch !== "HEAD" ? { currentBranch: branch.trim() } : {}),
        };
      }
    } catch (err) {
      if (err instanceof GitExecError && err.timedOut) throw err;
      // Preserve the existing partial results and error classification.
    }
    const out: DetectCwdResp = {
      isGitRepo: false,
      isInsideWorktree: false,
      gitInstalled: true,
      supportsRecoveryKeyDiscard: true,
    };
    // 1. git --version 探测安装
    try {
      await probeGit(["--version"]);
    } catch (err) {
      if (err instanceof GitExecError && err.timedOut) throw err;
      if (err instanceof GitExecError && err.cause?.code === "ENOENT") {
        out.gitInstalled = false;
        return out;
      }
      // 其他失败也视为不可用(极罕见)
      out.gitInstalled = false;
      return out;
    }

    // 2. rev-parse --show-toplevel: 拿 repo 根
    try {
      const { stdout } = await probeGit(["rev-parse", "--show-toplevel"], cwd);
      const toplevel = gitPathOutput(stdout);
      if (toplevel) {
        out.isGitRepo = true;
        out.repoRoot = path.resolve(toplevel);
      }
    } catch (err) {
      if (err instanceof GitExecError && err.timedOut) throw err;
      out.isGitRepo = false;
    }

    if (!out.isGitRepo) return out;

    // 3. 当前分支
    try {
      const { stdout } = await probeGit(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        cwd,
      );
      const branch = stdout.trim();
      if (branch && branch !== "HEAD") out.currentBranch = branch;
    } catch (err) {
      if (err instanceof GitExecError && err.timedOut) throw err;
      // ignore — 分支信息不影响主流程
    }

    // 4. 是否在 linked worktree 内
    // 权威判定: `git rev-parse --git-dir` 在 linked worktree 里指向 `.git/worktrees/<name>`,
    // 而 `--git-common-dir` 始终指向主仓库的 `.git`。两者解析后的绝对路径不一致 → linked worktree。
    // 这种判断是 git 自己用来区分主/linked worktree 的方式, 不依赖目录命名约定 ——
    // 任何工具(CC Desktop / 手工 git worktree add 等) 创建的 worktree 都能被检出。
    try {
      // 任一命令失败后仍等另一条完成清理，不能提前释放目录探测槽位。
      const results = await Promise.allSettled([
        probeGit(["rev-parse", "--git-dir"], cwd),
        probeGit(["rev-parse", "--git-common-dir"], cwd),
      ]);
      for (const result of results) {
        if (
          result.status === "rejected" &&
          result.reason instanceof GitExecError &&
          result.reason.timedOut
        ) {
          throw result.reason;
        }
      }
      const [gitDirResult, commonDirResult] = results;
      if (gitDirResult.status === "rejected") throw gitDirResult.reason;
      if (commonDirResult.status === "rejected") throw commonDirResult.reason;
      const gitDirRaw = gitDirResult.value.stdout;
      const gitCommonDirRaw = commonDirResult.value.stdout;
      const gitDir = path.resolve(cwd, gitPathOutput(gitDirRaw));
      const gitCommonDir = path.resolve(cwd, gitPathOutput(gitCommonDirRaw));
      if (gitDir && gitCommonDir && gitDir !== gitCommonDir) {
        out.isInsideWorktree = true;
      }
    } catch (err) {
      if (err instanceof GitExecError && err.timedOut) throw err;
      // 解析失败 → 兜底走托管目录名启发式, 至少识别出 Cindy 自己创建的 worktree
      const normalizedRepoRoot = out.repoRoot?.replace(/\\/g, "/");
      if (
        normalizedRepoRoot &&
        getManagedWorktreeBasePath(normalizedRepoRoot) != null
      ) {
        out.isInsideWorktree = true;
      }
    }

    return out;
  }

  return { detectCwd };
}
