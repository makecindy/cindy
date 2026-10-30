import fs from 'node:fs/promises';
import path from 'node:path';

import { isManagedWorktreeDirectoryName } from '../../shared/managedWorktreePaths';
import { withCrossProcessLock } from '../device-link/crossProcessLock';
import { createLogger } from '../logger';
import { gitExec } from './gitExec';
import { gitPathOutput } from './gitPathOutput';

const log = createLogger('worktree:exclude');

/**
 * Keep a directory Cindy is about to populate out of its parent repo's untracked
 * scan. Only local exclude rules are appended; tracked files and .gitignore are
 * untouched. Failure is an optimization miss, never a worktree creation failure.
 */
export async function ensureManagedWorktreeExcluded(baseRepo: string, worktreePath: string): Promise<void> {
  const parent = path.dirname(path.resolve(worktreePath));
  const directoryName = path.basename(parent);
  if (path.dirname(parent) !== path.resolve(baseRepo) || !isManagedWorktreeDirectoryName(directoryName)) return;

  try {
    // Git resolves gitfiles / separate git dirs; never assume baseRepo/.git is a directory.
    const { stdout } = await gitExec(['rev-parse', '--git-path', 'info/exclude'], baseRepo, { timeoutMs: 2_000 });
    const gitPath = gitPathOutput(stdout);
    if (!gitPath) throw new Error('Git exclude path unavailable');
    const exclude = path.resolve(baseRepo, gitPath);
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    await withCrossProcessLock(`${exclude}.cindy.lock`, { label: 'worktree:exclude', waitMs: 500 }, async (status) => {
      if (!status.held) return;
      // Do not rewrite a user-managed symlink, special file, or unusually large exclude.
      const stat = await fs.lstat(exclude).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat && (!stat.isFile() || stat.size > 1024 * 1024)) return;
      const content = stat ? await fs.readFile(exclude, 'utf8') : '';
      const rule = `/${directoryName}/`;
      if (content.split(/\r?\n/).includes(rule)) return;
      const newline = content.includes('\r\n') ? '\r\n' : '\n';
      const separator = content && !content.endsWith('\n') ? newline : '';
      // Append instead of replacing the file so unrelated user rules are preserved.
      await fs.appendFile(exclude, `${separator}${rule}${newline}`);
    });
  } catch (error) {
    log.warn('Could not update managed worktree exclusion', {
      code: (error as NodeJS.ErrnoException).code ?? 'EXCLUDE_UPDATE_FAILED',
    });
  }
}
