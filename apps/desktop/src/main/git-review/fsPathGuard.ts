/**
 * Filesystem path guards for git-review worktree reads.
 *
 * Git paths are repo-relative and validated at IPC/module boundaries. This
 * helper additionally resolves symlinks in intermediate path segments before
 * any worktree file content is read or opened.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export type RepoContainedPathErrorKind = 'missing' | 'outside';

/** Error category used by callers to map path resolution failures to IPC/UI fallbacks. */
export class RepoContainedPathError extends Error {
  readonly kind: RepoContainedPathErrorKind;

  constructor(kind: RepoContainedPathErrorKind, message: string) {
    super(message);
    this.name = 'RepoContainedPathError';
    this.kind = kind;
  }
}

export interface RepoContainedPathDeps {
  realpath: (filePath: string) => Promise<string>;
}

const defaultDeps: RepoContainedPathDeps = {
  realpath: fs.realpath,
};

export function repoRelativeFsPath(repoRoot: string, gitPath: string): string {
  const pathApi = path.posix.isAbsolute(repoRoot) ? path.posix : path;
  return pathApi.join(repoRoot, ...gitPath.split('/'));
}

export function isPathInside(parent: string, child: string): boolean {
  const pathApi = path.posix.isAbsolute(parent) ? path.posix : path;
  const relative = pathApi.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
}

export async function resolveRepoContainedRealPath(
  repoRoot: string,
  gitPath: string,
  depsInput: Partial<RepoContainedPathDeps> = {},
): Promise<{ repoRootReal: string; targetReal: string; candidate: string }> {
  const deps = { ...defaultDeps, ...depsInput };
  const repoRootReal = await deps.realpath(repoRoot);
  const candidate = repoRelativeFsPath(repoRoot, gitPath);
  let targetReal: string;
  try {
    targetReal = await deps.realpath(candidate);
  } catch {
    throw new RepoContainedPathError('missing', 'File does not exist in the working tree');
  }
  if (!isPathInside(repoRootReal, targetReal)) {
    throw new RepoContainedPathError('outside', 'File resolves outside the repository');
  }
  return { repoRootReal, targetReal, candidate };
}
