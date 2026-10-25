import type { createGitExecutor } from "@cindy/worktree-core/gitExec";
import { GitExecError } from "@cindy/worktree-core/gitTypes";
import type { DbLogger } from "@cindy/runtime-db/logging";

/** Raised when a session id cannot be embedded into a git refname. */
export class InvalidSavepointSessionIdError extends Error {
  constructor(readonly sessionId: string) {
    super("session id is not a valid savepoint ref component");
    this.name = "InvalidSavepointSessionIdError";
  }
}
export function createSavepointRefs(host: {
  gitExec: ReturnType<typeof createGitExecutor>["gitExec"];
  createLogger(scope: string): DbLogger;
}) {
  const { gitExec, createLogger } = host;

  const log = createLogger("git-snapshot");

  const SAVEPOINT_REF_NAMESPACE = "refs/cindy/savepoints/";

  /** session id 允许进入 refname 的字符集(UUID / cuid 都覆盖)。 */
  const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

  /** Full ref name for one session's savepoint chain. */
  function savepointRefForSession(sessionId: string): string {
    if (!SAFE_SESSION_ID_RE.test(sessionId)) {
      throw new InvalidSavepointSessionIdError(sessionId);
    }
    return `${SAVEPOINT_REF_NAMESPACE}${sessionId}`;
  }

  /** Current tip commit of the session's savepoint chain, or null when absent. */
  async function readSavepointTip(
    repoRoot: string,
    sessionId: string,
  ): Promise<string | null> {
    const ref = savepointRefForSession(sessionId);
    try {
      const { stdout } = await gitExec(
        ["rev-parse", "--verify", "--quiet", ref],
        repoRoot,
      );
      return stdout.trim() || null;
    } catch (err) {
      if (err instanceof GitExecError && err.exitCode === 1) return null;
      throw err;
    }
  }

  /** Deletes the session's savepoint chain ref. Best-effort and silent. */
  async function deleteSavepointRef(
    repoRoot: string,
    sessionId: string,
  ): Promise<void> {
    let ref: string;
    try {
      ref = savepointRefForSession(sessionId);
    } catch {
      return;
    }
    try {
      await gitExec(["update-ref", "-d", ref], repoRoot);
    } catch (err) {
      log.debug("[savepoint-refs] delete ref failed (ignored)", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Lists all savepoint chain refs in the repository. */
  async function listSavepointRefs(
    repoRoot: string,
  ): Promise<Array<{ sessionId: string; sha: string }>> {
    const { stdout } = await gitExec(
      [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)",
        SAVEPOINT_REF_NAMESPACE,
      ],
      repoRoot,
    );
    const out: Array<{ sessionId: string; sha: string }> = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const [refname, sha] = line.split("\0");
      if (!refname?.startsWith(SAVEPOINT_REF_NAMESPACE) || !sha) continue;
      out.push({
        sessionId: refname.slice(SAVEPOINT_REF_NAMESPACE.length),
        sha,
      });
    }
    return out;
  }
  return {
    SAVEPOINT_REF_NAMESPACE,
    savepointRefForSession,
    readSavepointTip,
    deleteSavepointRef,
    listSavepointRefs,
  };
}
