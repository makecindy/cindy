/**
 * #10568: move a workspace while preserving its logical path. Home/credentials stay put.
 * Requests only persist intent. Execution belongs to cold owner startup, before writers start;
 * never run this from an Agent turn or the bounded quit disposer chain.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { teammateFolderName } from '@cindy/maker-shared/teammate-project';

import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { copyTree, directoryIdentity, entry, inside, inspectTree } from './tree.js';

const processToken = randomUUID();
type Phase =
  | 'pending'
  | 'copying'
  | 'prepared'
  | 'switching'
  | 'linked'
  | 'completed'
  | 'failed'
  | 'cancelled';
interface Receipt {
  version: 1;
  id: string;
  botId: string;
  target: string;
  parentIdentity: string;
  sourceIdentity: string;
  processToken: string;
  pid: number;
  phase: Phase;
  targetIdentity?: string;
  digest?: string;
  error?: string;
  backupRemaining?: boolean;
}
const phases: Phase[] = [
  'pending',
  'copying',
  'prepared',
  'switching',
  'linked',
  'completed',
  'failed',
  'cancelled',
];

function botSegment(botId: string): string {
  if (typeof botId !== 'string' || !botId || botId.length > 200 || !teammateFolderName(botId))
    throw new Error('INVALID_BOT_ID');
  return teammateFolderName(botId);
}

function locations(ownerRoot: string, botId: string, receipt?: Receipt) {
  const source = path.join(ownerRoot, 'bots', botSegment(botId), 'workspace');
  return {
    source,
    journal: path.join(
      ownerRoot,
      'workspace-migrations',
      `${createHash('sha256').update(botId).digest('hex')}.json`,
    ),
    backup: receipt ? path.join(path.dirname(source), `.workspace-before-move-${receipt.id}`) : '',
  };
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return; // Windows cannot open directory handles with Node fs.
  const handle = await fs.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function save(
  ownerRoot: string,
  receipt: Receipt,
  assertCurrent?: () => void,
): Promise<void> {
  const { journal } = locations(ownerRoot, receipt.botId);
  await fs.mkdir(path.dirname(journal), { recursive: true, mode: 0o700 });
  const temporary = `${journal}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    assertCurrent?.();
    await fs.rename(temporary, journal);
    await syncDirectory(path.dirname(journal));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function locked<T>(ownerRoot: string, run: () => Promise<T>): Promise<T> {
  const directory = path.join(ownerRoot, 'workspace-migrations');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  return withCrossProcessLock(
    path.join(directory, '.mutation.lock'),
    { label: 'workspace-migration' },
    async (status) => {
      if (!status.held) throw new Error('MIGRATION_BUSY');
      return run();
    },
  );
}

async function read(ownerRoot: string, botId: string): Promise<Receipt | null> {
  const { journal } = locations(ownerRoot, botId);
  return readJournal(ownerRoot, journal, botId);
}

async function readJournal(
  ownerRoot: string,
  journal: string,
  botId?: string,
): Promise<Receipt | null> {
  if (!(await entry(journal))) return null;
  const bytes = await readBoundedFileNoFollow(journal, 16 * 1024);
  if (!bytes) throw new Error('MIGRATION_RECEIPT_UNREADABLE');
  const value = JSON.parse(bytes.toString('utf8')) as Receipt;
  if (
    value.version !== 1 ||
    (botId !== undefined && value.botId !== botId) ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.target !== 'string' ||
    !path.isAbsolute(value.target) ||
    typeof value.sourceIdentity !== 'string' ||
    typeof value.parentIdentity !== 'string' ||
    typeof value.processToken !== 'string' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !phases.includes(value.phase) ||
    locations(ownerRoot, value.botId).journal !== journal
  )
    throw new Error('MIGRATION_RECEIPT_INVALID');
  return value;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function validateTarget(ownerRoot: string, source: string, target: string): Promise<string> {
  if (!path.isAbsolute(target) || target.length > 4096 || target.includes('\0'))
    throw new Error('ABSOLUTE_TARGET_REQUIRED');
  if (process.platform === 'win32' && (target.startsWith('\\\\') || target.includes(':', 2)))
    throw new Error('LOCAL_DISK_REQUIRED');
  const parent = await fs.realpath(path.dirname(target));
  const resolved = path.join(parent, path.basename(target));
  const physicalOwner = await fs.realpath(ownerRoot);
  const physicalSource = await fs.realpath(source);
  if (
    inside(physicalOwner, resolved) ||
    inside(resolved, physicalOwner) ||
    inside(physicalSource, resolved) ||
    inside(resolved, physicalSource)
  )
    throw new Error('TARGET_OVERLAPS_CINDY_DATA');
  return resolved;
}

async function preflight(ownerRoot: string, botId: string, target: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { source } = locations(ownerRoot, botId);
  // A manually redirected Home/workspace is outside this operation's deletion authority.
  if (
    (await fs.realpath(path.dirname(source))) !==
    path.join(await fs.realpath(ownerRoot), 'bots', botSegment(botId))
  )
    throw new Error('BOT_HOME_IS_REDIRECTED');
  const sourceIdentity = await directoryIdentity(source);
  const destination = await validateTarget(ownerRoot, source, target);
  if (await entry(destination)) throw new Error('TARGET_EXISTS');
  const summary = await inspectTree(source, source, false, signal);
  const disk = await fs.statfs(path.dirname(destination), { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(summary.bytes)) throw new Error('INSUFFICIENT_SPACE');
  return {
    source,
    target: destination,
    sourceIdentity,
    parentIdentity: await directoryIdentity(path.dirname(destination)),
    ...summary,
  };
}

/** Only metadata is scanned while the workspace may have live writers. */
export async function previewWorkspaceMove(
  ownerRoot: string,
  botId: string,
  target: string,
  signal?: AbortSignal,
) {
  return {
    ...(await preflight(ownerRoot, botId, target, signal)),
    execution: 'next-host-start',
    scope: 'workspace-only',
    preservesLogicalPath: true,
  };
}

export async function workspaceMoveStatus(ownerRoot: string, botId: string) {
  const receipt = await read(ownerRoot, botId);
  const { source, backup } = locations(ownerRoot, botId, receipt ?? undefined);
  const workspaceAvailable =
    receipt?.phase === 'completed'
      ? await linkedTo(source, receipt.target).then(
          async (linked) => linked && (await sameDirectory(receipt.target, receipt.targetIdentity)),
          () => false,
        )
      : await fs.stat(source).then(
          (info) => info.isDirectory(),
          () => false,
        );
  return {
    scope: 'local',
    botId,
    source,
    workspaceAvailable,
    phase: receipt?.phase ?? 'none',
    target: receipt?.target,
    error: receipt?.error,
    backupRemaining: receipt?.backupRemaining,
    backup: receipt ? backup : undefined,
    historyDirectory: path.join(
      ownerRoot,
      'workspace-migrations',
      'history',
      createHash('sha256').update(botId).digest('hex'),
    ),
  };
}

/** assertCurrent closes the account/task change window immediately before intent is committed. */
export async function requestWorkspaceMove(
  ownerRoot: string,
  botId: string,
  target: string,
  assertCurrent: () => void,
  signal?: AbortSignal,
) {
  const assertLive = () => {
    signal?.throwIfAborted();
    assertCurrent();
  };
  return locked(ownerRoot, () => requestMove(ownerRoot, botId, target, assertLive, signal));
}

async function requestMove(
  ownerRoot: string,
  botId: string,
  target: string,
  assertCurrent: () => void,
  signal?: AbortSignal,
) {
  const existing = await read(ownerRoot, botId);
  if (existing && !['failed', 'cancelled'].includes(existing.phase)) {
    if (path.resolve(target) === existing.target) return workspaceMoveStatus(ownerRoot, botId);
    throw new Error('MIGRATION_ALREADY_REGISTERED');
  }
  const planned = await preflight(ownerRoot, botId, target, signal);
  assertCurrent();
  if (existing) {
    // Retain previous copy/recovery paths when a failed attempt is replaced.
    const history = path.join(
      ownerRoot,
      'workspace-migrations',
      'history',
      createHash('sha256').update(botId).digest('hex'),
    );
    await fs.mkdir(history, { recursive: true, mode: 0o700 });
    const historyFile = path.join(history, `${existing.id}.json`);
    const contents = JSON.stringify(existing);
    const file = await fs
      .open(historyFile, 'wx', 0o600)
      .catch(async (error: NodeJS.ErrnoException) => {
        if (
          error.code !== 'EEXIST' ||
          (await readBoundedFileNoFollow(historyFile, 16 * 1024))?.toString('utf8') !== contents
        )
          throw error;
        return null;
      });
    if (file) {
      try {
        await file.writeFile(contents);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await syncDirectory(history);
  }
  await save(
    ownerRoot,
    {
      version: 1,
      id: randomUUID(),
      botId,
      target: planned.target,
      sourceIdentity: planned.sourceIdentity,
      parentIdentity: planned.parentIdentity,
      processToken,
      pid: process.pid,
      phase: 'pending',
    },
    assertCurrent,
  );
  return workspaceMoveStatus(ownerRoot, botId);
}

export async function cancelWorkspaceMove(
  ownerRoot: string,
  botId: string,
  assertCurrent: () => void,
) {
  return locked(ownerRoot, async () => {
    const receipt = await read(ownerRoot, botId);
    if (receipt && !['pending', 'failed', 'cancelled'].includes(receipt.phase))
      throw new Error('MIGRATION_CANNOT_CANCEL');
    assertCurrent();
    if (receipt) await save(ownerRoot, { ...receipt, phase: 'cancelled' }, assertCurrent);
    return workspaceMoveStatus(ownerRoot, botId);
  });
}

async function sameDirectory(dir: string, identity: string | undefined): Promise<boolean> {
  return (
    !!identity &&
    (await directoryIdentity(dir).then(
      (value) => value === identity,
      () => false,
    ))
  );
}

async function linkedTo(source: string, target: string): Promise<boolean> {
  if (!(await entry(source))?.isSymbolicLink()) return false;
  const raw = path.resolve(path.dirname(source), await fs.readlink(source));
  const pointed = await fs.realpath(path.dirname(raw)).then(
    (parent) => path.join(parent, path.basename(raw)),
    () => raw,
  );
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.toNamespacedPath(value).toLowerCase() : value;
  return normalize(pointed) === normalize(target);
}

/** A failed cutover restores the *original* directory; it never copies the staged data back over it. */
async function restoreOriginal(ownerRoot: string, receipt: Receipt): Promise<void> {
  const { source, backup } = locations(ownerRoot, receipt.botId, receipt);
  if (await sameDirectory(source, receipt.sourceIdentity)) return;
  if (!(await sameDirectory(backup, receipt.sourceIdentity)))
    throw new Error('ORIGINAL_WORKSPACE_UNAVAILABLE');
  if (await entry(source)) {
    if (!(await linkedTo(source, receipt.target))) throw new Error('SOURCE_PATH_CHANGED');
    await fs.unlink(source); // unlink the junction itself, never recursively follow it.
  }
  await fs.rename(backup, source);
  await syncDirectory(path.dirname(source));
}

async function cleanupBackup(ownerRoot: string, receipt: Receipt): Promise<void> {
  const { source, backup } = locations(ownerRoot, receipt.botId, receipt);
  try {
    if (await entry(backup)) {
      if (
        !(await linkedTo(source, receipt.target)) ||
        !(await sameDirectory(receipt.target, receipt.targetIdentity))
      )
        throw new Error('TARGET_UNAVAILABLE');
      if (
        !(await sameDirectory(backup, receipt.sourceIdentity)) ||
        (await inspectTree(backup, source)).digest !== receipt.digest ||
        (await inspectTree(receipt.target, source)).digest !== receipt.digest
      ) {
        receipt.backupRemaining = true;
        receipt.error = 'MOVED_BACKUP_RETAINED_FOR_REVIEW';
        await save(ownerRoot, receipt);
        return;
      }
      await fs.rm(backup, { recursive: true });
      await syncDirectory(path.dirname(backup));
    }
    receipt.backupRemaining = false;
    delete receipt.error;
  } catch {
    receipt.backupRemaining = !!(await entry(backup));
    receipt.error = 'MOVED_BACKUP_CLEANUP_INCOMPLETE';
  }
  await save(ownerRoot, receipt);
}

async function execute(ownerRoot: string, receipt: Receipt): Promise<void> {
  const { source, backup } = locations(ownerRoot, receipt.botId, receipt);
  const persist = async (phase: Phase) => {
    receipt.phase = phase;
    await save(ownerRoot, receipt);
  };
  try {
    if (receipt.phase === 'switching' || receipt.phase === 'linked') {
      // A crash can occur between any two persisted steps. A proved link is already
      // committed; never roll it back over writes from a later successful startup.
      if (
        (await linkedTo(source, receipt.target)) &&
        (await sameDirectory(receipt.target, receipt.targetIdentity))
      ) {
        receipt.backupRemaining = !!(await entry(backup));
        await persist('completed');
        await cleanupBackup(ownerRoot, receipt);
        return;
      }
      await restoreOriginal(ownerRoot, receipt);
      throw new Error('CUTOVER_INTERRUPTED_OR_TARGET_UNAVAILABLE');
    }
    if (!(await sameDirectory(source, receipt.sourceIdentity)))
      throw new Error('SOURCE_PATH_CHANGED');
    if (
      (await validateTarget(ownerRoot, source, receipt.target)) !== receipt.target ||
      !(await sameDirectory(path.dirname(receipt.target), receipt.parentIdentity))
    )
      throw new Error('TARGET_PARENT_CHANGED');
    const targetExists = !!(await entry(receipt.target));
    if (
      targetExists &&
      (!['copying', 'prepared'].includes(receipt.phase) ||
        !(await sameDirectory(receipt.target, receipt.targetIdentity)))
    )
      throw new Error('TARGET_EXISTS');
    if (await entry(backup)) throw new Error('BACKUP_EXISTS');
    if (!targetExists) {
      // mkdir is the atomic no-replace operation on both Windows and POSIX.
      // A crash before identity publication leaves only an empty, unclaimed
      // directory, which is retained rather than assumed to be ours.
      await fs.mkdir(receipt.target, { mode: 0o700 });
      await syncDirectory(path.dirname(receipt.target));
      receipt.targetIdentity = await directoryIdentity(receipt.target);
    }
    await persist('copying');
    const before = await inspectTree(source);
    await copyTree(source, receipt.target, true);
    const copied = await inspectTree(receipt.target, source);
    const after = await inspectTree(source);
    if (before.digest !== copied.digest || before.digest !== after.digest)
      throw new Error('WORKSPACE_CHANGED');
    receipt.digest = copied.digest;
    await persist('prepared');
    // Test link creation on the SOURCE filesystem (NTFS junction privileges),
    // before renaming the original. Link targets need not be on that filesystem.
    const probe = path.join(path.dirname(source), `.workspace-link-probe-${receipt.id}`);
    await fs.symlink(receipt.target, probe, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.unlink(probe);
    if (
      !(await sameDirectory(receipt.target, receipt.targetIdentity)) ||
      !(await sameDirectory(source, receipt.sourceIdentity)) ||
      !(await sameDirectory(path.dirname(receipt.target), receipt.parentIdentity))
    )
      throw new Error('TARGET_CHANGED');
    await persist('switching');
    await fs.rename(source, backup);
    await syncDirectory(path.dirname(source));
    if ((await inspectTree(backup, source)).digest !== receipt.digest)
      throw new Error('WORKSPACE_CHANGED');
    await fs.symlink(receipt.target, source, process.platform === 'win32' ? 'junction' : 'dir');
    await syncDirectory(path.dirname(source));
    if (
      !(await linkedTo(source, receipt.target)) ||
      (await inspectTree(await fs.realpath(source), source)).digest !== receipt.digest
    )
      throw new Error('LINK_VERIFICATION_FAILED');
    await persist('linked');
    // Commit BEFORE cleanup. An interrupted removal must never cause a later
    // startup to replace the now authoritative destination with a partial backup.
    receipt.backupRemaining = true;
    await persist('completed');
    await cleanupBackup(ownerRoot, receipt);
  } catch (error) {
    const phase = receipt.phase;
    if (phase === 'switching' || phase === 'linked') await restoreOriginal(ownerRoot, receipt);
    if (phase === 'completed') throw error; // committed target stays authoritative.
    receipt.error = error instanceof Error ? error.message : 'MIGRATION_FAILED';
    await persist('failed');
  }
}

/**
 * Caller holds the owner's exclusive startup lease and has not exposed DB/services.
 * Same-process account switches and live requesters are deferred, never "paused" here.
 */
export async function recoverWorkspaceMovesAtStartup(
  ownerRoot: string,
  exclusiveStartup: boolean,
): Promise<void> {
  const directory = path.join(ownerRoot, 'workspace-migrations');
  const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (!names.some((name) => name.endsWith('.json'))) return;
  await locked(ownerRoot, async () => {
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const receipt = await readJournal(ownerRoot, path.join(directory, name));
      if (!receipt || ['failed', 'cancelled'].includes(receipt.phase)) continue;
      if (receipt.phase === 'completed') {
        if (
          exclusiveStartup &&
          receipt.backupRemaining &&
          receipt.error !== 'MOVED_BACKUP_RETAINED_FOR_REVIEW'
        )
          await cleanupBackup(ownerRoot, receipt);
        continue;
      }
      if (receipt.processToken === processToken || isAlive(receipt.pid)) {
        if (receipt.phase !== 'pending') throw new Error('WORKSPACE_MOVE_IN_PROGRESS');
        continue;
      }
      if (!exclusiveStartup) throw new Error('WORKSPACE_MOVE_REQUIRES_EXCLUSIVE_STARTUP');
      await execute(ownerRoot, receipt);
    }
  });
}

/** Do not let mkdir self-healing replace a removed link with a fresh empty workspace. */
export async function assertWorkspaceMoveReady(ownerRoot: string, botId: string): Promise<void> {
  const receipt = await read(ownerRoot, botId);
  if (!receipt || receipt.phase === 'cancelled' || receipt.phase === 'pending') return;
  const { source } = locations(ownerRoot, botId, receipt);
  if (receipt.phase === 'completed') {
    if (
      !(await linkedTo(source, receipt.target)) ||
      !(await sameDirectory(receipt.target, receipt.targetIdentity))
    )
      throw new Error('MOVED_WORKSPACE_UNAVAILABLE');
  } else if (receipt.phase !== 'failed' || !(await sameDirectory(source, receipt.sourceIdentity))) {
    throw new Error('WORKSPACE_MOVE_RECOVERY_REQUIRED');
  }
}
