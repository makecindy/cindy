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

/** Source borrowing can cross release/dev/isolated profiles on the same machine. */
function sharedRuntimeRoot(): string {
  return path.join(app.getPath('appData'), 'Cindy', 'shared-worktree-runtime-leases');
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

function leaseFile(sessionId: string, directory: string): string {
  const key = createHash('sha256').update(`${sessionId}:${randomUUID()}`).digest('hex');
  return path.join(directory, `${process.pid}-${key}.json`);
}

const leaseNamePattern = /^\d+-[a-f0-9]{64}\.json$/;
const releaseRequestPattern = /^\d+-[a-f0-9]{64}\.json\.release$/;

interface RuntimeKeepSentinel {
  /** Older release receipts omit this and refer to the in-tree keep marker. */
  file?: string;
  content: string;
  identity: string;
}

/** A startup owns its own file, even when the business task id is reused. */
export interface WorktreeRuntimeLease {
  readonly file: string;
  readonly physicalPath: string;
  readonly sharedFile?: string;
  readonly keepSentinel?: RuntimeKeepSentinel;
}

export async function acquireWorktreeRuntimeLease(
  sessionId: string,
  cwd: string,
  options: { crossProfile?: boolean } = {},
): Promise<WorktreeRuntimeLease | null> {
  const root = managedWorktreeRoot(cwd);
  if (!root) return null;
  return withWorktreeResourceLock(root, async () => {
    const lease = await publishRuntimeLease(sessionId, await physicalWorktreeKey(root), runtimeRoot());
    if (!options.crossProfile) return lease;
    let shared: WorktreeRuntimeLease | undefined;
    let keepSentinel: RuntimeKeepSentinel | undefined;
    try {
      // Publish both under the deletion lock. Keep the original profile copy
      // readable by existing clients sharing this userData.
      shared = await publishRuntimeLease(sessionId, lease.physicalPath, sharedRuntimeRoot());
      // Older profiles already check Git's external worktree lock before
      // recycling or pool reset. Build-time git clean cannot remove this file.
      keepSentinel = await acquireRuntimeKeepSentinel(shared);
      if (keepSentinel) {
        // Ownership lives with a real borrower, not merely in a recognizable
        // marker body that a user could have copied or edited. Existing v1
        // readers ignore the additional field; a partial write fails closed.
        await fs.writeFile(shared.file, JSON.stringify({
          version: 1, pid: process.pid, path: lease.physicalPath, keepSentinel,
        }));
      }
      return { ...lease, sharedFile: shared.file, keepSentinel };
    } catch (error) {
      await releaseWorktreeRuntimeLease({ ...lease, sharedFile: shared?.file, keepSentinel }).catch(() => undefined);
      throw error;
    }
  });
}

async function publishRuntimeLease(sessionId: string, physicalPath: string, directory: string): Promise<WorktreeRuntimeLease> {
  await fs.mkdir(directory, { recursive: true });
  const lease = { file: leaseFile(sessionId, directory), physicalPath };
  // A partial write is intentionally unreadable, hence protective to deletion.
  try {
    await fs.writeFile(lease.file, JSON.stringify({
      version: 1, pid: process.pid, path: physicalPath,
    }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // Only this acquisition's partial write may be removed.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await fs.unlink(lease.file).catch(() => undefined);
    }
    throw error;
  }
  return lease;
}

/** Validate Git's linked-worktree metadata before writing outside the source. */
async function runtimeGitLockFile(root: string): Promise<string> {
  const link = path.join(root, '.git');
  const linkStat = await fs.lstat(link);
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) throw new Error('project requires a linked Git worktree');
  const match = /^gitdir: (.+)$/.exec((await fs.readFile(link, 'utf8')).trim());
  if (!match) throw new Error('invalid worktree Git link');
  const gitDir = await physicalWorktreeKey(path.resolve(root, match[1]!));
  const common = await physicalWorktreeKey(path.resolve(gitDir, (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim()));
  const backlink = await physicalWorktreeKey(path.resolve(gitDir, (await fs.readFile(path.join(gitDir, 'gitdir'), 'utf8')).trim()));
  if (path.dirname(gitDir) !== path.join(common, 'worktrees') || backlink !== link
    || gitDir === root || gitDir.startsWith(`${root}${path.sep}`)) {
    throw new Error('worktree Git metadata must belong to the source and remain outside it');
  }
  return path.join(gitDir, 'locked');
}

async function acquireRuntimeKeepSentinel(lease: WorktreeRuntimeLease): Promise<RuntimeKeepSentinel | undefined> {
  const file = await runtimeGitLockFile(lease.physicalPath);
  const newContent = JSON.stringify({ kind: 'cindy-runtime-lock', version: 1, nonce: randomUUID() });
  let created = false;
  try {
    await fs.writeFile(file, newContent, { flag: 'wx', mode: 0o600 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // Never overwrite a user's existing Git lock, including files/directories.
  await fs.stat(file);
  const identity = await fs.lstat(file);
  if (!identity.isFile() || identity.isSymbolicLink()) return undefined;
  let content: string;
  try { content = await fs.readFile(file, 'utf8'); } catch { return undefined; }
  const marker = { file, content, identity: `${identity.dev}:${identity.ino}:${identity.birthtimeMs}` };
  if (created) return content === newContent ? marker : undefined;
  const directory = path.dirname(lease.file);
  for (const name of await fs.readdir(directory)) {
    if (!leaseNamePattern.test(name) || name === path.basename(lease.file)) continue;
    try {
      const other = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
      if (other.version !== 1 || typeof other.path !== 'string') throw new Error('unreadable worktree lease');
      if (other.path === lease.physicalPath && other.keepSentinel?.file === file && other.keepSentinel?.content === content
        && other.keepSentinel?.identity === marker.identity) return marker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

/** Called under the same physical lock as acquisition and old owner recyclers. */
async function releaseRuntimeKeepSentinel(lease: WorktreeRuntimeLease): Promise<void> {
  const marker = lease.keepSentinel;
  if (!marker) return;
  const file = marker.file ?? path.join(lease.physicalPath, '.worktree-keep');
  try {
    const identity = await fs.lstat(file);
    if (!identity.isFile() || identity.isSymbolicLink()
      || `${identity.dev}:${identity.ino}:${identity.birthtimeMs}` !== marker.identity
      || await fs.readFile(file, 'utf8') !== marker.content) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // Every cross-profile borrower publishes here before creating/joining the
  // sentinel. Crashed borrowers remain references until explicit I/O teardown.
  const directory = path.dirname(lease.file);
  for (const name of await fs.readdir(directory)) {
    if (!leaseNamePattern.test(name) || name === path.basename(lease.file)) continue;
    try {
      const other = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
      if (other.version !== 1 || typeof other.path !== 'string') throw new Error('unreadable worktree lease');
      if (other.path === lease.physicalPath) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await fs.unlink(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

export async function releaseWorktreeRuntimeLease(lease: WorktreeRuntimeLease): Promise<void> {
  const files: WorktreeRuntimeLease[] = [{ file: lease.file, physicalPath: lease.physicalPath }];
  if (lease.sharedFile) files.push({ file: lease.sharedFile, physicalPath: lease.physicalPath, keepSentinel: lease.keepSentinel });
  const results = await Promise.allSettled(files.map(releaseRuntimeLeaseFile));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

async function removeRuntimeLeaseFile(lease: WorktreeRuntimeLease): Promise<void> {
  if (lease.keepSentinel) {
    await withWorktreeResourceLock(lease.physicalPath, async () => {
      await releaseRuntimeKeepSentinel(lease);
      await fs.unlink(lease.file);
    });
  } else await fs.unlink(lease.file);
}

async function releaseRuntimeLeaseFile(lease: WorktreeRuntimeLease): Promise<void> {
  try { await removeRuntimeLeaseFile(lease); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.unlink(`${lease.file}.release`).catch(() => undefined);
      return;
    }
    // Keep an explicit, durable intent. The lease itself remains protective until
    // a later maintenance pass can prove that this terminal cleanup succeeded.
    try {
      await fs.mkdir(path.dirname(lease.file), { recursive: true });
      await fs.writeFile(`${lease.file}.release`, JSON.stringify({ version: 1, file: lease.file, path: lease.physicalPath, keepSentinel: lease.keepSentinel }), { flag: 'wx', mode: 0o600 });
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
  let pending = 0;
  for (const directory of [runtimeRoot(), sharedRuntimeRoot()]) {
    pending += await retryPendingRuntimeLeaseReleasesIn(directory);
  }
  return pending;
}

async function retryPendingRuntimeLeaseReleasesIn(directory: string): Promise<number> {
  let names: string[];
  try { names = await fs.readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let pending = 0;
  for (const name of names.filter((value) => releaseRequestPattern.test(value))) {
    const requestFile = path.join(directory, name);
    try {
      const request = JSON.parse(await fs.readFile(requestFile, 'utf8')) as { version?: number; file?: string; path?: string; keepSentinel?: RuntimeKeepSentinel };
      if (request.version !== 1 || typeof request.file !== 'string' || typeof request.path !== 'string'
        || path.dirname(request.file) !== directory || !leaseNamePattern.test(path.basename(request.file))
        || (request.keepSentinel !== undefined && (!request.keepSentinel
          || typeof request.keepSentinel.content !== 'string' || typeof request.keepSentinel.identity !== 'string'
          || (request.keepSentinel.file !== undefined && (typeof request.keepSentinel.file !== 'string'
            || !path.isAbsolute(request.keepSentinel.file) || path.basename(request.keepSentinel.file) !== 'locked'))))) {
        pending++;
        continue;
      }
      try {
        await removeRuntimeLeaseFile({ file: request.file, physicalPath: request.path, keepSentinel: request.keepSentinel });
      } catch (error) {
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
  const reusedInstanceRecords = new Map<number, string>();
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
        if (identity && isReusedDesktopInstancePid(record, identity)) {
          reusedInstanceRecords.set(pid, raw);
          continue;
        }
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
      if (pidMayBeAlive(pid) && !compatiblePids.has(pid)) {
        const raw = reusedInstanceRecords.get(pid);
        if (!raw) return null;
        // A stale SingletonLock can reference the same reused PID as an old
        // registration. Revalidate before waiving it: another runtime or lock
        // owner may have appeared since the registry scan. Child leases below
        // remain independent protection, even when this lock is proven stale.
        try {
          const identity = await readDesktopProcessIdentity(pid);
          if (!identity || !isReusedDesktopInstancePid(JSON.parse(raw), identity)
            || await readRecord(`${pid}.json`) !== raw
            || await fs.readlink(path.join(app.getPath('userData'), 'SingletonLock')) !== target) return null;
        } catch {
          return null;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  const paths = new Set<string>();
  for (const directory of [runtimeRoot(), sharedRuntimeRoot()]) {
    let leases: string[];
    try {
      leases = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of leases) {
      if (!leaseNamePattern.test(name)) continue;
      // Main may have crashed while a detached child still uses the directory.
      // Only explicit release proves source I/O stopped, across every profile.
      try {
        const lease = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
        if (lease.version !== 1 || typeof lease.path !== 'string') return null;
        paths.add(lease.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
    }
  }
  return paths;
}
