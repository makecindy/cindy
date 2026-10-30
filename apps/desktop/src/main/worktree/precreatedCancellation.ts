import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { withCrossProcessLock } from '../device-link/crossProcessLock';

// A cancelled creation id must never be reused, including after a restart. An
// empty, exclusively-created file is an atomic tombstone; no user content or
// recovery key is stored. Unlike a negative DB query it also fences late calls.
function marker(sessionId: string): string {
  return path.join(app.getPath('userData'), 'worktree-cancelled-creations',
    createHash('sha256').update(sessionId).digest('hex'));
}

/** Serialize creation/registration and cancellation across processes sharing a profile. */
export async function withPrecreatedSessionOperationLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const lockPath = `${marker(sessionId)}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return withCrossProcessLock(lockPath, { label: 'precreated-worktree', waitMs: 10_000 }, async (status) => {
    if (!status.held) throw new Error('PRECONDITION_FAILED: Worktree creation or cancellation is still in progress');
    return task();
  });
}

export function assertPrecreatedSessionNotCancelled(sessionId: string): void {
  const file = marker(sessionId);
  try {
    // Windows can return ENOENT for a child of a non-directory. Check the
    // store itself before treating a missing marker as permission to create.
    const root = fs.lstatSync(path.dirname(file));
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid worktree cancellation store');
    fs.statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('PRECONDITION_FAILED: Worktree creation was cancelled; create a new task');
}

export function sealPrecreatedSessionCancellation(sessionId: string): void {
  const file = marker(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
