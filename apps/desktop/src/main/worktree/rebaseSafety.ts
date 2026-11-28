import path from 'node:path';
import { lstat } from 'node:fs/promises';

type GitRead = (...args: string[]) => Promise<string>;

/** Refuse automatic history rewriting when it could drop merge-only edits or overwrite ignored files. */
export async function isSafeAutomaticRebase(
  checkoutPath: string,
  localRef: string,
  remoteRef: string,
  git: GitRead,
): Promise<boolean> {
  try {
    const base = (await git('merge-base', localRef, remoteRef)).trim();
    if (!base) return false;
    if ((await git('rev-list', '--min-parents=2', `${base}..${localRef}`)).trim()) return false;
    // Only remote additions can collide with an ignored local path. Tree-only diff avoids blob reads.
    const added = (
      await git('diff', '--no-renames', '--diff-filter=A', '--name-only', '-z', base, remoteRef)
    )
      .split('\0')
      .filter(Boolean);
    if (added.length > 200) return false;
    const existing = (
      await Promise.all(
        added.map(async (file) => {
          try {
            await lstat(path.join(checkoutPath, file));
            return file;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          }
        }),
      )
    ).filter((file): file is string => file !== null);
    if (existing.length === 0) return true;
    try {
      return !(await git('check-ignore', '--no-index', '-z', '--', ...existing));
    } catch (error) {
      if ((error as { exitCode?: number }).exitCode === 1) return true;
      throw error;
    }
  } catch {
    return false;
  }
}
