import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

import { physicalWorktreeKey, withWorktreeResourceLock } from './resourceLock';
import { isManagedWorktreeDirectoryName } from '../../shared/managedWorktreePaths';
import { notifyWorktreeRecycleOpportunity } from './recycleEvents';
import { isReusedDesktopInstancePid, readDesktopProcessIdentity } from '../desktopProcessIdentity';

function runtimeRoot(): string {
  return path.join(app.getPath('userData'), 'worktree-runtime-leases');
}

/** Map a local cwd (including descendants) to its managed resource. SSH callers skip this helper. */
export function managedWorktreeRoot(value: string): string | null {
  let current = path.resolve(value);
  for (;;) {
    const parent = path.dirname(current);
    if (isManagedWorktreeDirectoryName(path.basename(parent))) return current;
    if (parent === current) return null;
    current = parent;
  }
}

function leaseFile(sessionId: string): string {
  const key = createHash('sha256').update(`${sessionId}:${randomUUID()}`).digest('hex');
  return path.join(runtimeRoot(), `${process.pid}-${key}.json`);
}

const leaseNamePattern = /^\d+-[a-f0-9]{64}\.json$/;
const releaseRequestPattern = /^\d+-[a-f0-9]{64}\.json\.release$/;

/** A startup owns its own file, even when the business task id is reused. */
export interface WorktreeRuntimeLease {
  readonly file: string;
  readonly physicalPath: string;
}

export async function acquireWorktreeRuntimeLease(sessionId: string, cwd: string): Promise<WorktreeRuntimeLease | null> {
  const root = managedWorktreeRoot(cwd);
  if (!root) return null;
  return withWorktreeResourceLock(root, async () => {
    await fs.mkdir(runtimeRoot(), { recursive: true });
    const lease = { file: leaseFile(sessionId), physicalPath: await physicalWorktreeKey(root) };
    // A partial write is intentionally unreadable, hence protective to deletion.
    try {
      await fs.writeFile(lease.file, JSON.stringify({
        version: 1, pid: process.pid, path: lease.physicalPath,
      }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      // No runtime can start after acquisition fails. Only remove this attempt's
      // file; an older/newer runtime of the same task keeps its separate lease.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await fs.unlink(lease.file).catch(() => undefined);
      }
      throw error;
    }
    return lease;
  });
}

export async function releaseWorktreeRuntimeLease(lease: WorktreeRuntimeLease): Promise<void> {
  try { await fs.unlink(lease.file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.unlink(`${lease.file}.release`).catch(() => undefined);
      return;
    }
    // Keep an explicit, durable intent. The lease itself remains protective until
    // a later maintenance pass can prove that this terminal cleanup succeeded.
    try {
      await fs.mkdir(runtimeRoot(), { recursive: true });
      await fs.writeFile(`${lease.file}.release`, JSON.stringify({ version: 1, file: lease.file, path: lease.physicalPath }), { flag: 'wx', mode: 0o600 });
    } catch { /* preserving the lease is the safe fallback */ }
    // Wake the event-driven maintenance loop; it will retry the durable intent
    // while the still-present lease continues to protect the worktree.
    notifyWorktreeRecycleOpportunity(lease.physicalPath);
    throw error;
  }
  await fs.unlink(`${lease.file}.release`).catch(() => undefined);
  notifyWorktreeRecycleOpportunity(lease.physicalPath);
}

/** Retry only release intents written by a terminal close path. Unknown files stay protective. */
export async function retryPendingWorktreeRuntimeLeaseReleases(): Promise<number> {
  let names: string[];
  try { names = await fs.readdir(runtimeRoot()); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let pending = 0;
  for (const name of names.filter((value) => releaseRequestPattern.test(value))) {
    const requestFile = path.join(runtimeRoot(), name);
    try {
      const request = JSON.parse(await fs.readFile(requestFile, 'utf8')) as { version?: number; file?: string; path?: string };
      if (request.version !== 1 || typeof request.file !== 'string' || typeof request.path !== 'string'
        || path.dirname(request.file) !== runtimeRoot() || !leaseNamePattern.test(path.basename(request.file))) {
        pending++;
        continue;
      }
      try { await fs.unlink(request.file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { pending++; continue; }
      }
      await fs.unlink(requestFile).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      notifyWorktreeRecycleOpportunity(request.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') pending++;
    }
  }
  return pending;
}

function pidMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Unknown/older live instances keep terminal task references protected. */
export async function readWorktreeRuntimePaths(): Promise<Set<string> | null> {
  const registry = path.join(app.getPath('userData'), '.dev-instances');
  const names = new Set((await fs.readdir(registry)).map((name) => name.replace(/\.bak$/, '')));
  const compatiblePids = new Set([process.pid]);
  const readRecord = async (name: string): Promise<string> => {
    try { return await fs.readFile(path.join(registry, name), 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return fs.readFile(path.join(registry, `${name}.bak`), 'utf8');
    }
  };
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || !pidMayBeAlive(pid)) continue;
    try {
      const raw = await readRecord(name);
      const record = JSON.parse(raw);
      if (!record || record.pid !== pid) return null;
      // Only unsupported instances can block the entire lease view. Do not add
      // an OS subprocess per compatible instance to the normal recycle path.
      if (record.worktreeLeaseProtocol !== 1) {
        const identity = await readDesktopProcessIdentity(pid);
        // A replacement instance may have registered while the OS query ran.
        if (await readRecord(name) !== raw) return null;
        if (!pidMayBeAlive(pid)) continue;
        if (identity && isReusedDesktopInstancePid(record, identity)) continue;
      }
      if (record.worktreeLeaseProtocol !== 1 || record.pid !== pid) return null;
      compatiblePids.add(pid);
    } catch {
      return null;
    }
  }
  if (process.platform !== 'win32') {
    try {
      const target = await fs.readlink(path.join(app.getPath('userData'), 'SingletonLock'));
      const match = /-(\d+)$/.exec(target);
      if (!match) return null;
      const pid = Number(match[1]);
      if (pidMayBeAlive(pid) && !compatiblePids.has(pid)) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  let leases: string[];
  try {
    leases = await fs.readdir(runtimeRoot());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
  const paths = new Set<string>();
  for (const name of leases) {
    const match = leaseNamePattern.exec(name);
    if (!match) continue;
    // Main may have crashed while a detached child still uses the directory.
    // Only explicit lease release proves that startup stopped; a dead owner PID
    // is not sufficient evidence and its leftover lease remains protective.
    try {
      const lease = JSON.parse(await fs.readFile(path.join(runtimeRoot(), name), 'utf8'));
      if (lease.version !== 1 || typeof lease.path !== 'string') return null;
      paths.add(lease.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  return paths;
}
