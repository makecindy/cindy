import fs from 'node:fs/promises';
import path from 'node:path';

/** Standard linked-worktree files for filesystem unit tests; no Git subprocess. */
export async function createLinkedWorktreeMetadata(worktree: string): Promise<string> {
  const root = await fs.realpath(worktree);
  const gitDir = path.join(path.dirname(path.dirname(root)), '.git', 'worktrees', path.basename(root));
  await fs.mkdir(gitDir, { recursive: true });
  await fs.writeFile(path.join(root, '.git'), `gitdir: ${gitDir}\n`);
  await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
  await fs.writeFile(path.join(gitDir, 'gitdir'), `${path.join(root, '.git')}\n`);
  return path.join(gitDir, 'locked');
}
