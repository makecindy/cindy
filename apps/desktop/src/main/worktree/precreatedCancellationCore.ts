/**
 * Cancelled worktree creations, shared by Desktop and the Node Host. Moved verbatim from
 * precreatedCancellation.ts, which now builds the Desktop instance. The userData directory
 * (Electron's app) arrives as a port; every other import is unchanged.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withCrossProcessLock } from '../device-link/crossProcessLock';

// A cancelled creation id must never be reused, including after a restart. An
// empty, exclusively-created file is an atomic tombstone; no user content or
// recovery key is stored. Unlike a negative DB query it also fences late calls.

/** The Desktop-only reads, resolved by each launcher. */
export interface PrecreatedCancellationPorts {
  app: { getPath(name: 'userData'): string };
}

/** One instance per launcher; the former module state lives in it. */
export function createPrecreatedCancellation(ports: PrecreatedCancellationPorts) {
const { app } = ports;

// A cancelled creation id must never be reused, including after a restart. An
// empty, exclusively-created file is an atomic tombstone; no user content or
// recovery key is stored. Unlike a negative DB query it also fences late calls.
function marker(sessionId: string): string {
  return path.join(app.getPath('userData'), 'worktree-cancelled-creations',
    createHash('sha256').update(sessionId).digest('hex'));
}

/** Serialize creation/registration and cancellation across processes sharing a profile. */
async function withPrecreatedSessionOperationLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const lockPath = `${marker(sessionId)}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return withCrossProcessLock(lockPath, { label: 'precreated-worktree', waitMs: 10_000 }, async (status) => {
    if (!status.held) throw new Error('PRECONDITION_FAILED: Worktree creation or cancellation is still in progress');
    return task();
  });
}

function assertPrecreatedSessionNotCancelled(sessionId: string): void {
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

function sealPrecreatedSessionCancellation(sessionId: string): void {
  const file = marker(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

return { withPrecreatedSessionOperationLock, assertPrecreatedSessionNotCancelled, sealPrecreatedSessionCancellation };
}
