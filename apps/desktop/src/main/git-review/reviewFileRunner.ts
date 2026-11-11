/**
 * Request-scoped worktree file reads for git-review.
 *
 * Local review uses the controller filesystem. SSH review installs a backend
 * backed by the controlled-side file service, so a remote POSIX path is never
 * handed to the controller's node:fs APIs.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';

import {
  isPathInside,
  repoRelativeFsPath,
  resolveRepoContainedRealPath,
} from './fsPathGuard.js';

export interface ReviewWorktreePathStat {
  size: number;
  isSymlink: boolean;
}

export interface ReviewFileExecutionBackend {
  lstat(repoRoot: string, gitPath: string): Promise<ReviewWorktreePathStat>;
  readFile(repoRoot: string, gitPath: string, maxBytes: number): Promise<Buffer>;
  readPrefix(repoRoot: string, gitPath: string, maxBytes: number): Promise<Buffer>;
}

const executionBackend = new AsyncLocalStorage<ReviewFileExecutionBackend>();

export function withReviewFileExecutionBackend<T>(
  backend: ReviewFileExecutionBackend,
  task: () => Promise<T>,
): Promise<T> {
  return executionBackend.run(backend, task);
}

function lexicalWorktreePath(repoRoot: string, gitPath: string): string {
  const candidate = repoRelativeFsPath(repoRoot, gitPath);
  if (!isPathInside(repoRoot, candidate)) throw new Error('Review path is outside the repository');
  return candidate;
}

export async function lstatReviewWorktreePath(
  repoRoot: string,
  gitPath: string,
): Promise<ReviewWorktreePathStat> {
  const backend = executionBackend.getStore();
  if (backend) return backend.lstat(repoRoot, gitPath);
  const stat = await fs.lstat(lexicalWorktreePath(repoRoot, gitPath));
  return { size: stat.size, isSymlink: stat.isSymbolicLink() };
}

export async function readReviewWorktreeFile(
  repoRoot: string,
  gitPath: string,
  maxBytes: number,
): Promise<Buffer> {
  const backend = executionBackend.getStore();
  if (backend) return backend.readFile(repoRoot, gitPath, maxBytes);
  const { targetReal } = await resolveRepoContainedRealPath(repoRoot, gitPath);
  const stat = await fs.stat(targetReal);
  if (stat.size > maxBytes) throw new Error('Review file exceeds the read limit');
  return fs.readFile(targetReal);
}

export async function readReviewWorktreePrefix(
  repoRoot: string,
  gitPath: string,
  maxBytes: number,
): Promise<Buffer> {
  const backend = executionBackend.getStore();
  if (backend) return backend.readPrefix(repoRoot, gitPath, maxBytes);
  const { targetReal } = await resolveRepoContainedRealPath(repoRoot, gitPath);
  const handle = await fs.open(targetReal, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
