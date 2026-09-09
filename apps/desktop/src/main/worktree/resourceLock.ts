import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { withCrossProcessLock } from '../device-link/crossProcessLock';

const heldResources = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

/** Resolve aliases even while the leaf directory is absent during restore. */
export async function physicalWorktreeKey(value: string): Promise<string> {
  let cursor = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = path.join(await fs.realpath(cursor), ...suffix);
      return process.platform === 'win32' ? real.toLowerCase() : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function worktreeResourceId(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** One physical directory, across tasks, aliases and Cindy processes. */
export async function withWorktreeResourceLock<T>(value: string, task: () => Promise<T>): Promise<T> {
  const key = await physicalWorktreeKey(value);
  const inherited = heldResources.getStore();
  if (inherited?.get(key)?.active) return task();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const lockPath = path.join(os.tmpdir(), `cindy-worktree-${uid}-${worktreeResourceId(key)}.lock`);
  return withCrossProcessLock(lockPath, { label: 'worktree-resource', waitMs: 10_000 }, async (lock) => {
    if (!lock.held) throw new Error('worktree resource is busy');
    const token = { active: true };
    try {
      return await heldResources.run(new Map([...(inherited ?? []), [key, token]]), task);
    } finally {
      token.active = false;
    }
  });
}

/** Stable physical ordering prevents overlapping batch status/move operations from deadlocking. */
export async function withWorktreeResourceLocks<T>(values: readonly string[], task: () => Promise<T>): Promise<T> {
  const keys = [...new Set(await Promise.all(values.map(physicalWorktreeKey)))].sort();
  const acquire = (index: number): Promise<T> => keys[index]
    ? withWorktreeResourceLock(keys[index], () => acquire(index + 1)) : task();
  return acquire(0);
}
