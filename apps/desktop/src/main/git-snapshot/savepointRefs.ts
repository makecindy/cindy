/**
 * git-snapshot: shadow savepoint 的隐藏引用管理。
 *
 * 每个 session 一条保存点链, 挂在 refs/cindy/savepoints/<sessionId> 下。
 * 该命名空间不在 refs/heads / refs/tags 内, clone、push、git log 都不会带上,
 * 因此保存点对用户的分支历史完全不可见。
 */

import { createLogger } from '../logger';
import { gitExec, GitExecError } from '../worktree/gitExec';

const log = createLogger('git-snapshot');

export const SAVEPOINT_REF_NAMESPACE = 'refs/cindy/savepoints/';

/** session id 允许进入 refname 的字符集(UUID / cuid 都覆盖)。 */
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Raised when a session id cannot be embedded into a git refname. */
export class InvalidSavepointSessionIdError extends Error {
  constructor(readonly sessionId: string) {
    super('session id is not a valid savepoint ref component');
    this.name = 'InvalidSavepointSessionIdError';
  }
}

/** Full ref name for one session's savepoint chain. */
export function savepointRefForSession(sessionId: string): string {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) {
    throw new InvalidSavepointSessionIdError(sessionId);
  }
  return `${SAVEPOINT_REF_NAMESPACE}${sessionId}`;
}

/** Current tip commit of the session's savepoint chain, or null when absent. */
export async function readSavepointTip(
  repoRoot: string,
  sessionId: string,
): Promise<string | null> {
  const ref = savepointRefForSession(sessionId);
  try {
    const { stdout } = await gitExec(['rev-parse', '--verify', '--quiet', ref], repoRoot);
    return stdout.trim() || null;
  } catch (err) {
    if (err instanceof GitExecError && err.exitCode === 1) return null;
    throw err;
  }
}

/** Deletes the session's savepoint chain ref. Best-effort and silent. */
export async function deleteSavepointRef(repoRoot: string, sessionId: string): Promise<void> {
  let ref: string;
  try {
    ref = savepointRefForSession(sessionId);
  } catch {
    return;
  }
  try {
    await gitExec(['update-ref', '-d', ref], repoRoot);
  } catch (err) {
    log.debug('[savepoint-refs] delete ref failed (ignored)', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Lists all savepoint chain refs in the repository. */
export async function listSavepointRefs(
  repoRoot: string,
): Promise<Array<{ sessionId: string; sha: string }>> {
  const { stdout } = await gitExec(
    ['for-each-ref', '--format=%(refname)%00%(objectname)', SAVEPOINT_REF_NAMESPACE],
    repoRoot,
  );
  const out: Array<{ sessionId: string; sha: string }> = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [refname, sha] = line.split('\0');
    if (!refname?.startsWith(SAVEPOINT_REF_NAMESPACE) || !sha) continue;
    out.push({ sessionId: refname.slice(SAVEPOINT_REF_NAMESPACE.length), sha });
  }
  return out;
}
