import fs from 'node:fs/promises';
import path from 'node:path';

import { gitExec } from './gitExec';
import { physicalWorktreeKey } from './resourceLock';
import { isManagedWorktreeDirectoryName } from '../../shared/managedWorktreePaths';
import type { WorktreeMeta } from './types';

export async function assertManagedResourcePath(meta: WorktreeMeta, registeredPaths: string[]): Promise<void> {
  await assertManagedResourceLocation(meta, registeredPaths);
  const stat = await fs.lstat(meta.path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('redirected worktree directory');
  await assertAbsent(path.join(meta.path, '.worktree-keep'));
}

export async function assertManagedResourceLocation(meta: WorktreeMeta, registeredPaths: string[]): Promise<void> {
  const resolved = path.resolve(meta.path);
  const parent = path.dirname(resolved);
  if (!isManagedWorktreeDirectoryName(path.basename(parent))
    || path.dirname(parent) !== path.resolve(meta.baseRepo)
    || !registeredPaths.some((value) => path.resolve(value) === resolved)) throw new Error('unmanaged worktree path');
  const realParent = await physicalWorktreeKey(path.dirname(meta.path));
  const expectedParent = path.join(await physicalWorktreeKey(meta.baseRepo), path.basename(path.dirname(meta.path)));
  if (realParent !== expectedParent) throw new Error('redirected worktree parent');
}

async function assertAbsent(file: string): Promise<void> {
  try { await fs.lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('worktree is locked or explicitly kept');
}

/** A regular .git link must resolve to this worktree in the expected repository. */
export async function assertWorktreeGitIdentity(meta: WorktreeMeta): Promise<void> {
  const link = await fs.lstat(path.join(meta.path, '.git'));
  if (!link.isFile() || link.isSymbolicLink()) throw new Error('missing worktree Git link');
  const { stdout: root } = await gitExec(['rev-parse', '--show-toplevel'], meta.path);
  if (await physicalWorktreeKey(root.trim()) !== await physicalWorktreeKey(meta.path)) throw new Error('Git root mismatch');
  const args = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
  const { stdout: common } = await gitExec(args, meta.path);
  const { stdout: baseCommon } = await gitExec(args, meta.baseRepo);
  if (!common.trim() || !baseCommon.trim()
    || await physicalWorktreeKey(common.trim()) !== await physicalWorktreeKey(baseCommon.trim())) {
    throw new Error('Git repository mismatch');
  }
  const { stdout: gitDir } = await gitExec(['rev-parse', '--path-format=absolute', '--git-dir'], meta.path);
  const metadataRoot = path.join(await physicalWorktreeKey(common.trim()), 'worktrees');
  if (path.dirname(await physicalWorktreeKey(gitDir.trim())) !== metadataRoot) throw new Error('Git worktree metadata mismatch');
  for (const name of ['locked', 'index.lock', 'HEAD.lock']) await assertAbsent(path.join(gitDir.trim(), name));
  // A parent snapshot preserves gitlink OIDs, not the submodule's objects/index.
  // worktree remove --force deletes modules/ too, including child-only commits.
  await assertAbsent(path.join(gitDir.trim(), 'modules'));
  const { stdout: entries } = await gitExec(['ls-files', '--stage', '-z'], meta.path);
  if (entries.split('\0').some((entry) => entry.startsWith('160000 '))) {
    throw new Error('submodule recovery is not supported; preserving worktree');
  }
}
