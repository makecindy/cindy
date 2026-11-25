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
import {
  isLaterProcessThan,
  readDesktopProcessIdentity,
  type DesktopProcessIdentity,
} from '../desktopProcessIdentity.js';
import type { WorkspaceMigrationPhase } from '../../shared/workspaceMigration.js';
import { copyTree, directoryIdentity, entry, inside, inspectTree } from './tree.js';
import {
  beginWorkspaceMigrationStartupProgress,
  type WorkspaceMigrationStartupProgressJob,
} from './startupState.js';

async function normalizeComparePath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  const canonical = await fs
    .realpath(path.dirname(resolved))
    .then(
      (parent) => path.join(parent, path.basename(resolved)),
      () => resolved,
    );
  return process.platform === 'win32' ? path.toNamespacedPath(canonical).toLowerCase() : canonical;
}

const processToken = randomUUID();
// Only a diagnostic for this startup, scoped to the exact owner and receipt.
// Durable recovery still depends on filesystem identities, never this map.
const startupWarnings = new Map<string, { id: string; code: string }>();
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
  /** Last committed physical location, if the logical workspace was already a link. */
  previousTarget?: string;
  processToken: string;
  processIdentity?: DesktopProcessIdentity;
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
    staging: receipt
      ? receipt.target === source
        ? path.join(path.dirname(source), `.workspace-return-${receipt.id}`)
        : receipt.target
      : '',
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
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(receipt)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    assertCurrent?.();
    await fs.rename(temporary, journal);
    await syncDirectory(path.dirname(journal));
    startupWarnings.delete(journal);
  } finally {
    // A partial receipt is disposable; cleanup must not hide the actual write
    // error or turn a committed intent into a spurious failure.
    await fs.rm(temporary, { force: true }).catch(() => undefined);
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
    (value.previousTarget !== undefined &&
      (typeof value.previousTarget !== 'string' || !path.isAbsolute(value.previousTarget))) ||
    typeof value.parentIdentity !== 'string' ||
    typeof value.processToken !== 'string' ||
    (value.processIdentity !== undefined &&
      (!value.processIdentity ||
        !Number.isFinite(value.processIdentity.startedAtMs) ||
        value.processIdentity.startedAtMs <= 0 ||
        typeof value.processIdentity.executablePath !== 'string' ||
        !path.isAbsolute(value.processIdentity.executablePath))) ||
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

async function requesterIsActive(receipt: Receipt): Promise<boolean> {
  if (receipt.processToken === processToken) return true;
  if (!isAlive(receipt.pid)) return false;
  // A live PID can belong to another host after restart. Only an OS identity
  // proving a later birth permits recovery; unknown/legacy evidence protects
  // the possible original writer, including when probing is unavailable.
  if (!receipt.processIdentity) return true;
  const identity = await readDesktopProcessIdentity(receipt.pid);
  return !identity || !isLaterProcessThan(receipt, identity);
}

async function validateTarget(
  ownerRoot: string,
  source: string,
  target: string,
  previousTarget?: string,
): Promise<string> {
  if (!path.isAbsolute(target) || target.length > 4096 || target.includes('\0'))
    throw new Error('ABSOLUTE_TARGET_REQUIRED');
  if (process.platform === 'win32' && (target.startsWith('\\\\') || target.includes(':', 2)))
    throw new Error('LOCAL_DISK_REQUIRED');
  const parent = await fs.realpath(path.dirname(target));
  const resolved = path.join(parent, path.basename(target));
  const physicalOwner = await fs.realpath(ownerRoot);
  if (
    previousTarget &&
    (await normalizeComparePath(resolved)) === (await normalizeComparePath(source))
  )
    return source;
  const physicalSource = previousTarget ?? (await fs.realpath(source));
  if (
    inside(physicalOwner, resolved) ||
    inside(resolved, physicalOwner) ||
    inside(physicalSource, resolved) ||
    inside(resolved, physicalSource)
  )
    throw new Error('TARGET_OVERLAPS_CINDY_DATA');
  return resolved;
}

async function assertBotHome(ownerRoot: string, botId: string) {
  const { source } = locations(ownerRoot, botId);
  // A manually redirected Home/workspace is outside this operation's deletion authority.
  if (
    (await fs.realpath(path.dirname(source))) !==
    path.join(await fs.realpath(ownerRoot), 'bots', botSegment(botId))
  )
    throw new Error('BOT_HOME_IS_REDIRECTED');
}

function activeRedirect(source: string, receipt: Receipt | null): string | undefined {
  if (receipt?.phase === 'completed') return receipt.target === source ? undefined : receipt.target;
  return receipt?.previousTarget;
}

async function preflight(
  ownerRoot: string,
  botId: string,
  target: string,
  existing: Receipt | null,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await assertBotHome(ownerRoot, botId);
  const { source } = locations(ownerRoot, botId);
  const previousTarget = activeRedirect(source, existing);
  if (previousTarget && existing) {
    if (!(await usableWorkspace(ownerRoot, existing)))
      throw new Error('MOVED_WORKSPACE_UNAVAILABLE');
  } else if ((await entry(source))?.isSymbolicLink()) {
    throw new Error('WORKSPACE_ALREADY_REDIRECTED');
  } else if (existing && !(await usableWorkspace(ownerRoot, existing))) {
    throw new Error('SOURCE_PATH_CHANGED');
  }
  const physicalSource = previousTarget ?? source;
  const sourceIdentity = await directoryIdentity(physicalSource);
  const destination = await validateTarget(ownerRoot, source, target, previousTarget);
  if (destination !== source && (await entry(destination))) throw new Error('TARGET_EXISTS');
  const summary = await inspectTree(physicalSource, source, false, signal);
  const disk = await fs.statfs(path.dirname(destination), { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(summary.bytes)) throw new Error('INSUFFICIENT_SPACE');
  return {
    source: physicalSource,
    previousTarget,
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
  const { previousTarget: _previousTarget, ...planned } = await preflight(
    ownerRoot,
    botId,
    target,
    await read(ownerRoot, botId),
    signal,
  );
  return {
    ...planned,
    execution: 'next-host-start',
    scope: 'workspace-only',
    preservesLogicalPath: true,
  };
}

export async function workspaceMoveStatus(ownerRoot: string, botId: string) {
  const receipt = await read(ownerRoot, botId);
  const { source, backup, staging, journal } = locations(ownerRoot, botId, receipt ?? undefined);
  const warning = startupWarnings.get(journal);
  const workspaceAvailable =
    receipt && (receipt.previousTarget || !['pending', 'cancelled'].includes(receipt.phase))
      ? await usableWorkspace(ownerRoot, receipt).catch(() => false)
      : await fs.stat(source).then(
          (info) => info.isDirectory(),
          () => false,
        );
  return {
    scope: 'local',
    botId,
    source,
    currentTarget: activeRedirect(source, receipt),
    workspaceAvailable,
    startupWarning: warning?.id === receipt?.id ? warning?.code : undefined,
    phase: (receipt?.phase ?? 'none') as WorkspaceMigrationPhase,
    target: receipt?.target,
    error: receipt?.error,
    backupRemaining: receipt?.backupRemaining,
    backup: receipt?.previousTarget ?? (receipt ? backup : undefined),
    stagedCopy: receipt?.phase === 'failed' && receipt.target === source &&
      (await sameDirectory(staging, receipt.targetIdentity)) ? staging : undefined,
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
    if ((await normalizeComparePath(target)) === (await normalizeComparePath(existing.target)))
      return workspaceMoveStatus(ownerRoot, botId);
    if (existing.phase !== 'completed') throw new Error('MIGRATION_ALREADY_REGISTERED');
  }
  const planned = await preflight(ownerRoot, botId, target, existing, signal);
  const identity = await readDesktopProcessIdentity(process.pid);
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
      previousTarget: planned.previousTarget,
      parentIdentity: planned.parentIdentity,
      processToken,
      ...(identity ? { processIdentity: identity } : {}),
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
    if (receipt && !['pending', 'failed', 'cancelled'].includes(receipt.phase)) {
      // The mutation lock excludes an active transfer. A stale intermediate
      // receipt can be withdrawn once its original directory is proved live.
      if (receipt.phase === 'completed' || !(await usableWorkspace(ownerRoot, receipt)))
        throw new Error('MIGRATION_CANNOT_CANCEL');
    }
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

async function matchesLocation(
  logical: string,
  physical: string | undefined,
  identity: string | undefined,
): Promise<boolean> {
  if (!physical || physical === logical) return sameDirectory(logical, identity);
  return (await linkedTo(logical, physical)) && (await sameDirectory(physical, identity));
}

/** An intact original or a proved committed link can admit this owner's startup
 * even when recording the outcome failed. Never choose an old copy after commit.
 */
async function usableWorkspace(ownerRoot: string, receipt: Receipt): Promise<boolean> {
  const { source } = locations(ownerRoot, receipt.botId, receipt);
  return receipt.phase === 'completed'
    ? matchesLocation(source, receipt.target, receipt.targetIdentity)
    : matchesLocation(source, receipt.previousTarget, receipt.sourceIdentity);
}

/** A failed cutover restores the previous directory or link without writing to its contents. */
async function restoreOriginal(ownerRoot: string, receipt: Receipt): Promise<void> {
  const { source, backup, staging } = locations(ownerRoot, receipt.botId, receipt);
  // Even if the previous disk is offline, restore its link and let the
  // per-buddy availability guard protect it until the disk returns.
  const oldLink = receipt.previousTarget;
  const hasPreviousEntry = (where: string) =>
    oldLink ? linkedTo(where, oldLink) : sameDirectory(where, receipt.sourceIdentity);
  if (await hasPreviousEntry(source)) return;
  if (!(await hasPreviousEntry(backup)))
    throw new Error('ORIGINAL_WORKSPACE_UNAVAILABLE');
  if (await entry(source)) {
    if (receipt.target === source) {
      if (!(await sameDirectory(source, receipt.targetIdentity)) || (await entry(staging)))
        throw new Error('SOURCE_PATH_CHANGED');
      // Keep the return copy if the cutover could not be committed.
      await fs.rename(source, staging);
    } else {
      if (!(await linkedTo(source, receipt.target))) throw new Error('SOURCE_PATH_CHANGED');
      await fs.unlink(source);
    }
  }
  await fs.rename(backup, source);
  await syncDirectory(path.dirname(source));
}

async function cleanupBackup(
  ownerRoot: string,
  receipt: Receipt,
  verifiedInCurrentRun = false,
): Promise<void> {
  const { source, backup } = locations(ownerRoot, receipt.botId, receipt);
  const oldDirectory = receipt.previousTarget ?? backup;
  try {
    if (await entry(backup)) {
      await assertBotHome(ownerRoot, receipt.botId);
      if (receipt.previousTarget) {
        // The same external path boundary applies to removing a previous
        // location as to creating a new one.
        await validateTarget(ownerRoot, source, receipt.previousTarget, receipt.target);
      }
      if (!(await matchesLocation(source, receipt.target, receipt.targetIdentity)))
        throw new Error('TARGET_UNAVAILABLE');
      const backupMatchesIdentity = await matchesLocation(
        backup,
        receipt.previousTarget,
        receipt.sourceIdentity,
      );
      const digestsMatch =
        backupMatchesIdentity &&
        ((!receipt.previousTarget && verifiedInCurrentRun) ||
          ((await inspectTree(oldDirectory, source)).digest === receipt.digest &&
            (await inspectTree(receipt.target, source)).digest === receipt.digest));
      if (!digestsMatch) {
        receipt.backupRemaining = true;
        receipt.error = 'MOVED_BACKUP_RETAINED_FOR_REVIEW';
        await save(ownerRoot, receipt);
        return;
      }
      // A repeat move's backup entry is a link; remove only the verified old
      // directory and the link the transaction itself renamed.
      if (!(await matchesLocation(backup, receipt.previousTarget, receipt.sourceIdentity)))
        throw new Error('SOURCE_PATH_CHANGED');
      await fs.rm(oldDirectory, { recursive: true });
      if (receipt.previousTarget) {
        await syncDirectory(path.dirname(oldDirectory));
        await fs.unlink(backup);
      }
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

async function execute(
  ownerRoot: string,
  receipt: Receipt,
  progressJob?: WorkspaceMigrationStartupProgressJob,
): Promise<void> {
  const { source, backup, staging } = locations(ownerRoot, receipt.botId, receipt);
  const physicalSource = receipt.previousTarget ?? source;
  const persist = async (phase: Phase) => {
    await save(ownerRoot, { ...receipt, phase });
    receipt.phase = phase;
  };
  await assertBotHome(ownerRoot, receipt.botId);
  try {
    if (receipt.phase === 'switching' || receipt.phase === 'linked') {
      // A crash can leave a verified link without a committed receipt. Finish
      // recording the cutover before allowing any writes through the link.
      if (await matchesLocation(source, receipt.target, receipt.targetIdentity)) {
        progressJob?.update({ phase: 'cleaning', progress: 92 });
        receipt.backupRemaining = !!(await entry(backup));
        await persist('completed');
        await cleanupBackup(ownerRoot, receipt);
        progressJob?.update({ phase: 'cleaning', progress: 100 });
        return;
      }
      await restoreOriginal(ownerRoot, receipt);
      throw new Error('CUTOVER_INTERRUPTED_OR_TARGET_UNAVAILABLE');
    }
    progressJob?.update({ phase: 'preparing', progress: 5, copiedBytes: 0, totalBytes: 0 });
    if (!(await matchesLocation(source, receipt.previousTarget, receipt.sourceIdentity)))
      throw new Error('SOURCE_PATH_CHANGED');
    if (
      (await validateTarget(ownerRoot, source, receipt.target, receipt.previousTarget)) !==
        receipt.target ||
      !(await sameDirectory(path.dirname(receipt.target), receipt.parentIdentity))
    )
      throw new Error('TARGET_PARENT_CHANGED');
    const targetExists = !!(await entry(staging));
    if (
      targetExists &&
      (!['copying', 'prepared'].includes(receipt.phase) ||
        !(await sameDirectory(staging, receipt.targetIdentity)))
    )
      throw new Error('TARGET_EXISTS');
    if (await entry(backup)) throw new Error('BACKUP_EXISTS');
    if (!targetExists) {
      // mkdir is the atomic no-replace operation on both Windows and POSIX.
      // A crash before identity publication leaves only an empty, unclaimed
      // directory, which is retained rather than assumed to be ours.
      await fs.mkdir(staging, { mode: 0o700 });
      await syncDirectory(path.dirname(staging));
      receipt.targetIdentity = await directoryIdentity(staging);
    }
    await persist('copying');
    const before = await inspectTree(physicalSource, source);
    const totalBytes = Number(before.bytes);
    progressJob?.update({
      phase: 'copying',
      progress: 12,
      copiedBytes: 0,
      totalBytes,
    });
    let lastEmitAt = 0;
    await copyTree(
      physicalSource,
      staging,
      true,
      (copiedBytes) => {
        if (!progressJob) return;
        const now = Date.now();
        if (now - lastEmitAt < 100 && copiedBytes < totalBytes) return;
        lastEmitAt = now;
        const ratio = totalBytes > 0 ? Math.min(1, copiedBytes / totalBytes) : 1;
        progressJob.update({
          phase: 'copying',
          progress: 12 + Math.round(ratio * 63),
          copiedBytes: Math.min(copiedBytes, totalBytes),
          totalBytes,
        });
      },
      source,
      receipt.target,
    );
    progressJob?.update({
      phase: 'verifying',
      progress: 76,
      copiedBytes: totalBytes,
      totalBytes,
    });
    const copied = await inspectTree(staging, source);
    if (before.digest !== copied.digest) throw new Error('WORKSPACE_CHANGED');
    receipt.digest = copied.digest;
    await persist('prepared');
    // Test link creation on the SOURCE filesystem (NTFS junction privileges),
    // before renaming the original. Link targets need not be on that filesystem.
    if (receipt.target !== source) {
      const probe = path.join(path.dirname(source), `.workspace-link-probe-${receipt.id}`);
      await fs.symlink(receipt.target, probe, process.platform === 'win32' ? 'junction' : 'dir');
      await fs.unlink(probe);
    }
    if (
      !(await sameDirectory(staging, receipt.targetIdentity)) ||
      !(await matchesLocation(source, receipt.previousTarget, receipt.sourceIdentity)) ||
      !(await sameDirectory(path.dirname(receipt.target), receipt.parentIdentity))
    )
      throw new Error('TARGET_CHANGED');
    progressJob?.update({ phase: 'switching', progress: 86 });
    await persist('switching');
    await fs.rename(source, backup);
    await syncDirectory(path.dirname(source));
    // Verify the moved-aside source once after rename, confirming nothing
    // changed during copy or right before cutover.
    if (
      !(await matchesLocation(backup, receipt.previousTarget, receipt.sourceIdentity)) ||
      (await inspectTree(receipt.previousTarget ?? backup, source)).digest !== receipt.digest
    )
      throw new Error('WORKSPACE_CHANGED');
    if (receipt.target === source) {
      if (await entry(source)) throw new Error('SOURCE_PATH_CHANGED');
      await fs.rename(staging, source);
    } else {
      await fs.symlink(receipt.target, source, process.platform === 'win32' ? 'junction' : 'dir');
    }
    await syncDirectory(path.dirname(source));
    if (!(await matchesLocation(source, receipt.target, receipt.targetIdentity)))
      throw new Error('LINK_VERIFICATION_FAILED');
    await persist('linked');
    // Commit BEFORE cleanup. An interrupted removal must never cause a later
    // startup to replace the now authoritative destination with a partial backup.
    receipt.backupRemaining = true;
    await persist('completed');
    progressJob?.update({ phase: 'cleaning', progress: 96 });
    await cleanupBackup(ownerRoot, receipt, true);
    progressJob?.update({ phase: 'cleaning', progress: 100 });
  } catch (error) {
    const phase = receipt.phase;
    if (phase === 'switching' || phase === 'linked') {
      await restoreOriginal(ownerRoot, receipt);
      delete receipt.backupRemaining;
    }
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
    const receipts: Array<{ journal: string; receipt: Receipt }> = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const journal = path.join(directory, name);
      const receipt = await readJournal(ownerRoot, journal);
      if (!receipt || ['failed', 'cancelled'].includes(receipt.phase)) continue;
      receipts.push({ journal, receipt });
    }
    const runnableCount = exclusiveStartup
      ? (
          await Promise.all(
            receipts.map(async ({ receipt }) =>
              receipt.phase !== 'completed' && !(await requesterIsActive(receipt)),
            ),
          )
        ).filter(Boolean).length
      : 0;
    let progressJob: WorkspaceMigrationStartupProgressJob | undefined;
    let executedIndex = 0;
    try {
      for (const { journal, receipt } of receipts) {
        try {
          if (receipt.phase === 'completed') {
            if (
              exclusiveStartup &&
              receipt.backupRemaining &&
              receipt.error !== 'MOVED_BACKUP_RETAINED_FOR_REVIEW'
            )
              await cleanupBackup(ownerRoot, receipt);
            continue;
          }
          if (await requesterIsActive(receipt)) {
            if (receipt.phase !== 'pending') throw new Error('WORKSPACE_MOVE_IN_PROGRESS');
            continue;
          }
          if (!exclusiveStartup) {
            if (!(await canStartWithPreviousLocation(ownerRoot, receipt)))
              throw new Error('WORKSPACE_MOVE_REQUIRES_EXCLUSIVE_STARTUP');
            startupWarnings.set(journal, {
              id: receipt.id,
              code: 'MIGRATION_WAITING_FOR_EXCLUSIVE_STARTUP',
            });
            continue;
          }
          executedIndex += 1;
          if (!progressJob) {
            progressJob = beginWorkspaceMigrationStartupProgress(
              receipt.id,
              Math.max(1, runnableCount),
            );
          } else {
            progressJob.update({
              phase: 'preparing',
              progress: 5,
              copiedBytes: 0,
              totalBytes: 0,
              currentIndex: executedIndex,
              totalCount: Math.max(executedIndex, runnableCount),
            });
          }
          await execute(ownerRoot, receipt, progressJob);
        } catch (error) {
          if (
            error instanceof Error &&
            [
              'MIGRATION_BUSY',
              'WORKSPACE_MOVE_IN_PROGRESS',
              'WORKSPACE_MOVE_REQUIRES_EXCLUSIVE_STARTUP',
            ].includes(error.message)
          )
            throw error;
          // Once committed, backup cleanup is maintenance and cannot block the
          // account even if the target disk is currently offline. The affected
          // buddy's guard still rejects an unavailable target, without mkdir.
          if (
            receipt.phase !== 'completed' &&
            !(await canStartWithPreviousLocation(ownerRoot, receipt))
          )
            throw error;
          startupWarnings.set(journal, { id: receipt.id, code: 'MIGRATION_RECEIPT_UPDATE_FAILED' });
        }
      }
    } finally {
      progressJob?.finish();
    }
  });
}

async function canStartWithPreviousLocation(ownerRoot: string, receipt: Receipt): Promise<boolean> {
  await assertBotHome(ownerRoot, receipt.botId);
  if (receipt.previousTarget) {
    // Like a completed move with its disk disconnected, leave this buddy
    // unavailable but allow the rest of the owner to start.
    return linkedTo(locations(ownerRoot, receipt.botId).source, receipt.previousTarget);
  }
  return usableWorkspace(ownerRoot, receipt);
}

/** Do not let mkdir self-healing replace a removed link with a fresh empty workspace. */
export async function assertWorkspaceMoveReady(ownerRoot: string, botId: string): Promise<void> {
  const receipt = await read(ownerRoot, botId);
  if (!receipt || (!receipt.previousTarget && ['cancelled', 'pending'].includes(receipt.phase))) return;
  if (await usableWorkspace(ownerRoot, receipt)) return;
  throw new Error(
    receipt.phase === 'completed' || receipt.previousTarget
      ? 'MOVED_WORKSPACE_UNAVAILABLE'
      : 'WORKSPACE_MOVE_RECOVERY_REQUIRED',
  );
}

/**
 * Provision a brand-new buddy's workspace directly under a configured custom root
 * (decoupled from %APPDATA%), linking the canonical logical path `<ownerRoot>/bots/<bot>/workspace`
 * to the physical folder and recording a completed receipt so offline-drive guards apply immediately.
 */
export async function provisionDecoupledWorkspace(
  ownerRoot: string,
  botId: string,
  customRoot: string,
): Promise<string> {
  const { source } = locations(ownerRoot, botId);
  return locked(ownerRoot, async () => {
    await assertWorkspaceMoveReady(ownerRoot, botId);
    if (await entry(source)) return source;

    const rootInfo = await fs.stat(customRoot).catch(() => null);
    if (!rootInfo?.isDirectory()) {
      throw new Error('BUDDY_WORKSPACE_ROOT_UNAVAILABLE');
    }
    const physicalOwner = await fs.realpath(ownerRoot);
    const physicalRoot = await fs.realpath(customRoot);
    if (inside(physicalOwner, physicalRoot) || inside(physicalRoot, physicalOwner)) {
      throw new Error('TARGET_OVERLAPS_CINDY_DATA');
    }

    const baseName = `${botSegment(botId)}-workspace`;
    let physicalTarget = '';
    for (let suffix = 1; suffix <= 99; suffix += 1) {
      const candidate = path.join(physicalRoot, suffix === 1 ? baseName : `${baseName}-${suffix}`);
      if (!(await entry(candidate))) {
        physicalTarget = candidate;
        break;
      }
    }
    if (!physicalTarget) {
      physicalTarget = path.join(physicalRoot, `${baseName}-${randomUUID().slice(0, 8)}`);
    }

    await fs.mkdir(physicalTarget, { mode: 0o700 });
    await syncDirectory(physicalRoot);
    try {
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.symlink(physicalTarget, source, process.platform === 'win32' ? 'junction' : 'dir');
      await syncDirectory(path.dirname(source));
      const targetIdentity = await directoryIdentity(physicalTarget);
      const parentIdentity = await directoryIdentity(physicalRoot);
      const identity = await readDesktopProcessIdentity(process.pid);
      await save(ownerRoot, {
        version: 1,
        id: randomUUID(),
        botId,
        target: physicalTarget,
        parentIdentity,
        sourceIdentity: targetIdentity,
        targetIdentity,
        processToken,
        ...(identity ? { processIdentity: identity } : {}),
        pid: process.pid,
        phase: 'completed',
        backupRemaining: false,
      });
      return source;
    } catch (error) {
      await fs.unlink(source).catch(() => undefined);
      await fs.rm(physicalTarget, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}
