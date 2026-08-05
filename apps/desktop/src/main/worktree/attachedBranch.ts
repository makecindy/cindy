import { gitExec } from './gitExec';

const LOCAL_BRANCH_REF_PREFIX = 'refs/heads/';

/**
 * Read the attached local branch without Git's context-dependent short-name
 * disambiguation. A same-named tag can make `--short` return `heads/<name>`,
 * so callers must normalize the full symbolic ref themselves.
 */
export async function readAttachedWorktreeBranch(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await gitExec(['symbolic-ref', '--quiet', 'HEAD'], worktreePath);
    const ref = stdout.trim();
    if (!ref.startsWith(LOCAL_BRANCH_REF_PREFIX)) return null;
    const branch = ref.slice(LOCAL_BRANCH_REF_PREFIX.length);
    return branch || null;
  } catch {
    return null;
  }
}
