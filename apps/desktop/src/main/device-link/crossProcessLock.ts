import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { createLogger } from '../logger';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';

/**
 * Cross-process locking has two intentionally separate policies.
 *
 * `withCrossProcessLock` is the ordinary/advisory tier: it provides real
 * mutual exclusion, while the caller decides whether `busy` / `unavailable`
 * means fail, defer, skip an optimization, or take a separately safe fallback.
 * "Advisory" describes the ownership-proof and recovery policy; it does not
 * mean callers may ignore a failed acquisition.
 *
 * `withSecurityBoundaryLock` is reserved for transitions where accepting the
 * wrong owner would cross an authorization boundary. Its stronger identity and
 * durable recovery rules are fixed by the API. Do not merge the tiers into one
 * option-driven lock: that makes a security invariant removable at call sites
 * and pushes the strict Windows failure surface back onto ordinary writes.
 */
const log = createLogger('device-link:cross-process-lock');

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;
const LOCK_RETRY_MS = 40;
const MAX_TAKEOVERS = 3;
const LOCK_HEARTBEAT_MS = 2_000;
const LEGACY_PID_REUSE_TOLERANCE_MS = 2_000;
const REMOVE_RETRY_ATTEMPTS = 3;
const EMPTY_DIR_REMOVE_RETRY_ATTEMPTS = 5;
const RELEASE_GATE_WAIT_MS = 3_000;
const execFileAsync = promisify(execFile);

type ExecFileResult = { stdout: string };
type ExecFileRunner = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    timeout: number;
    windowsHide?: boolean;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<ExecFileResult>;

export type LockStatus = { held: true } | { held: false; reason: 'busy' | 'unavailable' };

export interface FileLockOptions {
  label: string;
  waitMs?: number;
}

interface LockRecord {
  pid: number;
  startedAt: number;
  nonce: string | null;
  processStartIdentity: string | null;
  state: 'held' | 'released';
}

type ReadLockRecord = LockRecord | 'missing' | 'malformed' | 'unreadable';
interface MalformedLockIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}
type StaleLockCandidate =
  | { kind: 'record'; record: LockRecord }
  | { kind: 'malformed'; identity: MalformedLockIdentity };
interface ProcessIdentity {
  key: string;
  startedAtMs: number | null;
}
type ProcessIdentityProbe =
  | { status: 'found'; identity: ProcessIdentity }
  | { status: 'missing' }
  | { status: 'unavailable' };
type ProcessIdentityProbeOverride = (pid: number) => Promise<ProcessIdentityProbe>;
type PublishedLock = {
  handle: Awaited<ReturnType<typeof fsp.open>>;
  nonce: string;
  record: LockRecord;
};
type AdvisoryPublishedLock = {
  nonce: string;
};
type AdvisoryLockRecord = {
  pid: number;
  nonce: string | null;
};
type AdvisoryStaleCandidate = {
  identity: MalformedLockIdentity;
  record: AdvisoryLockRecord | null;
};
type AdvisoryReclaimGate = {
  dirPath: string;
  filePath: string;
  nonce: string;
  heartbeat: ReturnType<typeof setInterval>;
};
type ReclaimGate = {
  dirPath: string;
  filePath: string;
  lock: PublishedLock;
  heartbeat: ReturnType<typeof setInterval>;
};

let currentProcessIdentityPromise: Promise<ProcessIdentity | null> | null = null;
let processIdentityProbeOverride: ProcessIdentityProbeOverride | null = null;
// A release gate whose final rename/fsync failed may still be ours. Keep its
// nonce so the same process can recover it before treating the gate as busy.
const pendingOwnRecordRecovery = new Map<string, string>();
const pendingAdvisoryRecovery = new Map<string, string>();
const pendingOwnGateCleanup = new Set<string>();

function gateReleaseMarkerPath(gatePath: string): string {
  return `${gatePath}.released`;
}

/**
 * Lightweight cross-process advisory lock for caches and ordinary durable stores.
 *
 * Callers retain ownership of the degradation policy through `LockStatus`. This
 * path keeps the legacy canonical file shape, adding a nonce-bound owner record
 * and rename isolation for safe release/takeover. It deliberately avoids the
 * strict tier's process-identity commands and hard-link/fsync publication on
 * the ordinary hot path. A nonce-bound release marker is only a Windows cleanup
 * fallback when a gate file outlives bounded deletion retries. Plugin approval
 * boundaries require the stronger protocol on every transition, but imposing
 * its full state machine on every cache/settings write enlarged the Windows
 * failure surface.
 */
export async function withCrossProcessLock<T>(
  lockPath: string,
  opts: FileLockOptions,
  task: (status: LockStatus) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  let held = false;
  let reason: 'busy' | 'unavailable' = 'unavailable';
  let takeovers = 0;
  let ownLock: AdvisoryPublishedLock | null = null;

  for (;;) {
    await recoverPendingAdvisoryLock(lockPath);
    if (await ordinaryReclaimInProgress(lockPath)) {
      reason = 'busy';
      if (Date.now() >= deadline) break;
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      ownLock = await publishAdvisoryLock(lockPath);
      if (await ordinaryReclaimInProgress(lockPath)) {
        await releaseAdvisoryLock(lockPath, opts.label, ownLock);
        ownLock = null;
        reason = 'busy';
        if (Date.now() >= deadline) break;
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      held = true;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      // Windows may transiently report these while a recently removed path is
      // still being released by the filesystem. Keep them inside the bounded
      // retry loop instead of disabling the caller immediately.
      if (code !== 'EEXIST' && code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') {
        reason = 'unavailable';
        break;
      }
      const stale = takeovers < MAX_TAKEOVERS
        ? await inspectStaleAdvisoryLock(lockPath)
        : null;
      if (stale) {
        takeovers += 1;
        const takeover = await quarantineAdvisoryLock(lockPath, stale);
        if (takeover === 'taken' || takeover === 'changed') continue;
        reason = 'busy';
        break;
      }
      if (Date.now() >= deadline) {
        reason = 'busy';
        break;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  const heartbeat = held
    ? setInterval(() => {
        const now = new Date();
        void fsp.utimes(lockPath, now, now).catch(() => undefined);
      }, LOCK_HEARTBEAT_MS)
    : null;
  heartbeat?.unref?.();

  try {
    return await task(held ? { held: true } : { held: false, reason });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (held && ownLock) await releaseAdvisoryLock(lockPath, opts.label, ownLock);
  }
}

/**
 * Strict lock for plugin approval and skill-projection security boundaries.
 *
 * The policy is intentionally fixed: exact process identity, nonce-bound
 * publication/release, no takeover of malformed records, and recoverable
 * reclaim gates. Keeping this as a separate API prevents ordinary callers from
 * accidentally inheriting security-boundary lifecycle complexity.
 */
export async function withSecurityBoundaryLock<T>(
  lockPath: string,
  opts: FileLockOptions,
  task: (status: LockStatus) => Promise<T>,
): Promise<T> {
  let held = false;
  let reason: 'busy' | 'unavailable' = 'unavailable';
  let ownLock: PublishedLock | null = null;
  let takeovers = 0;
  let publishingAfterTakeover = false;
  const processIdentity = await getProcessIdentity(process.pid);
  // Do not charge the first process-identity probe against the caller's wait
  // budget. On Windows the initial CIM/WMIC lookup can take several seconds.
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  if (!processIdentity) {
    return task({ held: false, reason: 'unavailable' });
  }

  for (;;) {
    await recoverPendingOwnRecord(lockPath);
    if (await reclaimInProgress(lockPath)) {
      reason = 'busy';
      if (Date.now() >= deadline) break;
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      const publishedLock = await publishLockRecord(lockPath, processIdentity?.key ?? null);
      if (!publishedLock) throw Object.assign(new Error('lock exists'), { code: 'EEXIST' });
      const { nonce } = publishedLock;
      const [published, reclaiming] = await Promise.all([
        readLockRecord(lockPath, true),
        reclaimInProgress(lockPath),
      ]);
      if (reclaiming || typeof published === 'string' || published.nonce !== nonce) {
        await cleanupPublishedLock(lockPath, opts.label, publishedLock);
        reason = 'busy';
        if (Date.now() >= deadline) break;
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      ownLock = publishedLock;
      held = true;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // EEXIST = 锁被别人持着(正常竞争)。
      // EBUSY / EPERM / EACCES 在 Windows 上可能是文件刚被删除但 FS 还没完全释放,
      // 和 EEXIST 一样走重试而不是立刻判 unavailable;有 deadline 兜底不会无限等。
      if (code !== 'EEXIST' && code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') {
        // 锁**建不出来**(EMFILE / 目录不存在…):无从判断有没有别人在临界区。
        reason = 'unavailable';
        break;
      }

      if (
        publishingAfterTakeover
        && (Date.now() >= deadline || takeovers >= MAX_TAKEOVERS)
      ) {
        reason = 'busy';
        break;
      }
      publishingAfterTakeover = false;

      if (takeovers < MAX_TAKEOVERS) {
        const stale = await inspectStaleLock(
          lockPath,
          false,
          true,
        );
        if (stale) {
          log.warn(`taking over stale ${opts.label} lock from a dead owner`);
          const takeover = await quarantineStaleLock(
            lockPath,
            stale,
            true,
          );
          if (takeover === 'taken') {
            takeovers += 1;
            // A slow but successful stale-owner check may consume waitMs. Give
            // the caller one immediate publication attempt, then enforce the
            // deadline before considering another takeover. The final
            // takeover still gets this publication attempt if the path is now
            // empty, but a competing record cannot trigger a fourth takeover.
            publishingAfterTakeover = true;
            continue;
          }
          if (takeover === 'reclaiming' || takeover === 'changed' || takeover === 'retry') {
            reason = 'busy';
            if (Date.now() >= deadline) break;
            await sleep(LOCK_RETRY_MS);
            continue;
          }
          takeovers += 1;
          if (takeovers >= MAX_TAKEOVERS) {
            reason = 'busy';
            break;
          }
          reason = 'busy';
          break;
        }
      }

      if (Date.now() >= deadline) {
        reason = 'busy';
        break;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  const heartbeat = held
    ? setInterval(() => {
        const now = new Date();
        void ownLock?.handle.utimes(now, now).catch(() => undefined);
      }, LOCK_HEARTBEAT_MS)
    : null;
  heartbeat?.unref?.();

  try {
    return await task(held ? { held: true } : { held: false, reason });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (held && ownLock) await cleanupPublishedLock(lockPath, opts.label, ownLock);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function inspectStaleLock(
  lockPath: string,
  allowMalformedTakeover = false,
  requireCompleteRecord = false,
): Promise<StaleLockCandidate | null> {
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(lockPath);
  } catch {
    return null;
  }
  const record = await readLockRecord(lockPath, requireCompleteRecord);
  if (record === 'missing' || record === 'unreadable') return null;
  if (typeof record !== 'string' && record.state === 'released') {
    return { kind: 'record', record };
  }
  if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return null;
  if (record === 'malformed') {
    return allowMalformedTakeover
      ? { kind: 'malformed', identity: malformedLockIdentity(stat) }
      : null;
  }
  // Reference time for "when was the lock created": prefer birthtime, but
  // fall back to mtime when birthtime is unavailable or 0 (several Linux
  // filesystems and containers report 0). A null reference previously made the
  // legacy PID-reuse check fail open (owner assumed active), which broke stale
  // takeover on those platforms.
  const createdAtMs = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
    ? stat.birthtimeMs
    : (Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0 ? stat.mtimeMs : null);
  return (await isRecordOwnerActive(record, createdAtMs))
    ? null
    : { kind: 'record', record };
}

/** Only a stale record whose owner is definitely gone may be reclaimed. */
async function inspectStaleAdvisoryLock(
  lockPath: string,
): Promise<AdvisoryStaleCandidate | null> {
  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await fsp.lstat(lockPath);
  } catch {
    return null;
  }
  if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return null;

  const record = await readAdvisoryLockRecord(lockPath);
  if (record === 'unreadable') return null;
  if (record === null) {
    return {
      identity: malformedLockIdentity(stat),
      record: null,
    };
  }
  try {
    process.kill(record.pid, 0);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ESRCH') return null;
  }
  return {
    identity: malformedLockIdentity(stat),
    record,
  };
}

async function publishAdvisoryLock(lockPath: string): Promise<AdvisoryPublishedLock> {
  const nonce = crypto.randomUUID();
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  let created = false;
  try {
    // The canonical path must remain a directly-created regular file: released
    // clients and older Cindy versions already coordinate through this shape.
    handle = await fsp.open(lockPath, 'wx');
    created = true;
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce }),
      'utf8',
    );
    await handle.close();
    handle = null;
    return { nonce };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await fsp.rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readAdvisoryLockRecord(
  lockPath: string,
): Promise<AdvisoryLockRecord | null | 'unreadable'> {
  let raw: string;
  try {
    raw = await fsp.readFile(lockPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return 'unreadable';
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const pid = (value as { pid?: unknown }).pid;
      const nonce = (value as { nonce?: unknown }).nonce;
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
        return {
          pid,
          nonce: typeof nonce === 'string' && nonce !== '' ? nonce : null,
        };
      }
    }
  } catch {
    // Legacy advisory locks treated readable malformed stale data as residue.
  }
  return null;
}

function sameAdvisoryCandidate(
  left: AdvisoryStaleCandidate | null,
  right: AdvisoryStaleCandidate,
): boolean {
  if (!left) return false;
  return sameMalformedLockIdentity(left.identity, right.identity)
    && left.record?.pid === right.record?.pid
    && left.record?.nonce === right.record?.nonce;
}

async function quarantineAdvisoryLock(
  lockPath: string,
  expected: AdvisoryStaleCandidate,
): Promise<'taken' | 'changed' | 'busy' | 'failed'> {
  // Only crash recovery pays for the reclaim gate. Cooperating acquisitions
  // check it both before and after publication, so a successor cannot enter
  // its task while the stale canonical path is being isolated.
  const gate = await acquireAdvisoryReclaimGate(lockPath, 0);
  if (!gate) return 'busy';
  const quarantinePath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    const current = await inspectStaleAdvisoryLock(lockPath);
    if (!sameAdvisoryCandidate(current, expected)) return 'changed';
    try {
      await fsp.rename(lockPath, quarantinePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'changed' : 'failed';
    }
    const moved = await inspectAdvisoryCandidate(quarantinePath);
    if (!sameAdvisoryCandidate(moved, expected)) {
      await restoreMovedPathSafely(quarantinePath, lockPath);
      return 'failed';
    }
    await removePathWithRetry(quarantinePath);
    return await pathExists(quarantinePath) ? 'failed' : 'taken';
  } finally {
    await releaseAdvisoryReclaimGate(gate);
  }
}

async function inspectAdvisoryCandidate(
  lockPath: string,
): Promise<AdvisoryStaleCandidate | null> {
  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await fsp.lstat(lockPath);
  } catch {
    return null;
  }
  const record = await readAdvisoryLockRecord(lockPath);
  if (record === 'unreadable') return null;
  return {
    identity: malformedLockIdentity(stat),
    record,
  };
}

async function releaseAdvisoryLock(
  lockPath: string,
  label: string,
  lock: AdvisoryPublishedLock,
): Promise<void> {
  const gate = await acquireAdvisoryReclaimGate(lockPath);
  if (!gate) {
    pendingAdvisoryRecovery.set(lockPath, lock.nonce);
    log.warn(`${label} lock release gate is busy; leaving a recoverable owner record`);
    return;
  }
  const releasePath = `${lockPath}.release-${process.pid}-${crypto.randomUUID()}`;
  try {
    const current = await readAdvisoryLockRecord(lockPath);
    // The nonce, not the PID, is the ownership token. The same long-lived
    // process may already have acquired a successor after an earlier release
    // failure, and the predecessor must never remove that successor.
    if (current === 'unreadable' || current === null || current.nonce !== lock.nonce) {
      log.warn(`${label} lock was taken over; leaving it to its new owner`);
      return;
    }
    try {
      await fsp.rename(lockPath, releasePath);
    } catch {
      pendingAdvisoryRecovery.set(lockPath, lock.nonce);
      return;
    }
    const moved = await readAdvisoryLockRecord(releasePath);
    if (moved !== 'unreadable' && moved !== null && moved.nonce === lock.nonce) {
      pendingAdvisoryRecovery.delete(lockPath);
      await removePathWithRetry(releasePath);
    } else {
      await restoreMovedPathSafely(releasePath, lockPath);
      log.warn(`${label} lock identity changed during release; preserving the isolated record`);
    }
  } finally {
    await releaseAdvisoryReclaimGate(gate);
  }
}

async function recoverPendingAdvisoryLock(lockPath: string): Promise<void> {
  const nonce = pendingAdvisoryRecovery.get(lockPath);
  if (!nonce) return;
  const current = await readAdvisoryLockRecord(lockPath);
  if (current === 'unreadable') return;
  if (current === null || current.nonce !== nonce) {
    pendingAdvisoryRecovery.delete(lockPath);
    return;
  }
  await releaseAdvisoryLock(lockPath, 'advisory recovery', { nonce });
}

async function ordinaryReclaimInProgress(lockPath: string): Promise<boolean> {
  await cleanupPendingOwnGates();
  return reclaimInProgress(lockPath);
}

async function acquireAdvisoryReclaimGate(
  lockPath: string,
  waitMs = RELEASE_GATE_WAIT_MS,
): Promise<AdvisoryReclaimGate | null> {
  await cleanupPendingOwnGates();
  const deadline = Date.now() + waitMs;
  const dirPath = reclaimGateDirPath(lockPath);
  do {
    if (await legacyReclaimInProgress(lockPath)) {
      if (Date.now() >= deadline) return null;
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      await fsp.mkdir(dirPath, { recursive: true });
    } catch {
      return null;
    }
    const nonce = crypto.randomUUID();
    const filePath = path.join(dirPath, `gate-${process.pid}-${nonce}.json`);
    let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
    try {
      // Keep the shared `gate-*` name and complete LockRecord shape so strict
      // and older contenders observe this lightweight recovery gate. The
      // estimated self identity avoids CIM/WMIC on the advisory path; freshness
      // and the nonce-bound file name protect the short reclaim transaction.
      handle = await fsp.open(filePath, 'wx');
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        nonce,
        processStartIdentity: estimateCurrentProcessIdentity().key,
        state: 'held',
      } satisfies LockRecord), 'utf8');
      await handle.close();
      handle = null;
    } catch {
      await handle?.close().catch(() => undefined);
      await removePathWithRetry(filePath);
      return null;
    }

    const heartbeat = setInterval(() => {
      const now = new Date();
      void fsp.utimes(filePath, now, now).catch(() => undefined);
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    const gate = { dirPath, filePath, nonce, heartbeat };
    for (;;) {
      const winner = await findActiveReclaimGate(dirPath);
      if (winner === filePath) return gate;
      if (winner === null || Date.now() >= deadline) {
        await releaseAdvisoryReclaimGate(gate);
        break;
      }
      await sleep(LOCK_RETRY_MS);
    }
    if (Date.now() >= deadline) return null;
  } while (true);
}

async function releaseAdvisoryReclaimGate(gate: AdvisoryReclaimGate): Promise<void> {
  clearInterval(gate.heartbeat);
  const current = await readLockRecord(gate.filePath, true);
  if (typeof current !== 'string' && current.nonce === gate.nonce) {
    await removePathWithRetry(gate.filePath);
    // A Windows filesystem filter can keep the gate file undeletable beyond
    // our bounded retry window. Publish the same nonce-bound release proof as
    // the strict tier so the next contender can distinguish this dead gate
    // from a live owner and finish the cleanup without weakening ownership.
    if (await pathExists(gate.filePath)) {
      await publishGateReleaseMarker(gate.filePath, gate.nonce).catch((error) => {
        log.warn('advisory reclaim gate release marker could not be published', error);
      });
    }
  }
  if (await pathExists(gate.filePath)) {
    pendingOwnGateCleanup.add(gate.filePath);
  } else {
    await removePathWithRetry(gateReleaseMarkerPath(gate.filePath));
  }
  await removeEmptyDirectoryWithRetry(gate.dirPath);
}

async function readLockRecord(
  lockPath: string,
  requireCompleteRecord = false,
): Promise<ReadLockRecord> {
  const lockDir = path.dirname(lockPath);
  let lockRealDir: string;
  try {
    // Keep the root and file on the same realpath implementation. On Windows,
    // Node's sync and async variants can preserve different component casing;
    // mixing their spellings makes a valid lock record fail containment.
    lockRealDir = await fsp.realpath(lockDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    return 'unreadable';
  }
  let bytes: Buffer | null;
  try {
    bytes = await readBoundedFileNoFollow(lockPath, 4 * 1024, {
      containWithin: lockRealDir,
      nonBlocking: true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    return 'unreadable';
  }
  if (bytes === null) return 'unreadable';
  const raw = bytes.toString('utf8');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'malformed';
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.pid !== 'number' ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.startedAt !== 'number' ||
      !Number.isFinite(value.startedAt)
    ) {
      return 'malformed';
    }
    const noncePresent = Object.prototype.hasOwnProperty.call(value, 'nonce');
    const identityPresent = Object.prototype.hasOwnProperty.call(value, 'processStartIdentity');
    const statePresent = Object.prototype.hasOwnProperty.call(value, 'state');
    if (
      requireCompleteRecord
      && (
        !noncePresent
        || typeof value.nonce !== 'string'
        || !isValidNonce(value.nonce)
        || !identityPresent
        || typeof value.processStartIdentity !== 'string'
        || parseRecordedProcessStartMs(value.processStartIdentity) === null
        || !statePresent
        || (value.state !== 'held' && value.state !== 'released')
      )
    ) {
      return 'malformed';
    }
    if (
      noncePresent
      && value.nonce !== null
      && (typeof value.nonce !== 'string' || value.nonce === '')
    ) {
      return 'malformed';
    }
    if (
      identityPresent
      && value.processStartIdentity !== null
      && (
        typeof value.processStartIdentity !== 'string'
        || value.processStartIdentity === ''
        || parseRecordedProcessStartMs(value.processStartIdentity) === null
      )
    ) {
      return 'malformed';
    }
    if (statePresent && value.state !== 'held' && value.state !== 'released') {
      return 'malformed';
    }
    return {
      pid: value.pid,
      startedAt: value.startedAt,
      nonce: typeof value.nonce === 'string' && value.nonce !== '' ? value.nonce : null,
      processStartIdentity:
        typeof value.processStartIdentity === 'string' && value.processStartIdentity !== ''
          ? value.processStartIdentity
          : null,
      state: value.state === 'released' ? 'released' : 'held',
    };
  } catch {
    return 'malformed';
  }
}

async function publishLockRecord(
  targetPath: string,
  processStartIdentity: string | null,
): Promise<PublishedLock | null> {
  const nonce = crypto.randomUUID();
  const candidatePath = `${targetPath}.candidate-${process.pid}-${nonce}.tmp`;
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(candidatePath, 'wx');
    const record: LockRecord = {
      pid: process.pid,
      startedAt: Date.now(),
      nonce,
      processStartIdentity,
      state: 'held',
    };
    await handle.writeFile(JSON.stringify(record), 'utf8');
    await handle.sync();
    try {
      // A hard link publishes the already-flushed inode atomically and refuses
      // to replace an existing target on every supported desktop platform.
      await fsp.link(candidatePath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        await handle.close().catch(() => undefined);
        handle = null;
        return null;
      }
      throw error;
    }
    await fsp.rm(candidatePath, { force: true }).catch(() => undefined);
    return { handle, nonce, record };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  } finally {
    await fsp.rm(candidatePath, { force: true }).catch(() => undefined);
  }
}

async function quarantineStaleLock(
  lockPath: string,
  expected: StaleLockCandidate,
  requireCompleteRecord = false,
): Promise<'taken' | 'reclaiming' | 'changed' | 'retry' | 'failed'> {
  const gate = await acquireReclaimGate(lockPath, 0);
  if (!gate) return 'reclaiming';
  const quarantinePath = `${lockPath}.reclaim-${process.pid}-${crypto.randomUUID()}`;
  let quarantineMatchesExpected = false;
  try {
    const current = await inspectStaleLock(
      lockPath,
      expected.kind === 'malformed',
      requireCompleteRecord,
    );
    if (!sameStaleCandidate(current, expected)) return 'changed';
    try {
      await fsp.rename(lockPath, quarantinePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'changed' : 'failed';
    }
    if (!(await pathMatchesStaleCandidate(quarantinePath, expected, requireCompleteRecord))) {
      await restoreMovedPathSafely(quarantinePath, lockPath);
      return 'retry';
    }
    quarantineMatchesExpected = true;
    return 'taken';
  } finally {
    if (quarantineMatchesExpected) await removePathWithRetry(quarantinePath);
    await releaseReclaimGate(gate);
  }
}

async function reclaimInProgress(
  lockPath: string,
  requireProcessIdentity = true,
): Promise<boolean> {
  if (await legacyReclaimInProgress(lockPath)) return true;
  return (await findActiveReclaimGate(
    reclaimGateDirPath(lockPath),
    requireProcessIdentity,
  )) !== null;
}

async function legacyReclaimInProgress(lockPath: string): Promise<boolean> {
  const gatePath = `${lockPath}.reclaim`;
  let exists = true;
  try {
    await fsp.stat(gatePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    exists = code !== 'ENOENT' && code !== 'ENOTDIR';
  }
  if (!exists) return false;
  const expected = await inspectStaleLock(gatePath, false);
  if (!expected) return true;

  const quarantinePath = `${gatePath}-stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fsp.rename(gatePath, quarantinePath);
  } catch {
    return true;
  }
  let result = true;
  try {
    if (!(await pathMatchesStaleCandidate(quarantinePath, expected))) {
      await restoreMovedPathSafely(quarantinePath, gatePath);
      result = true;
    } else {
      result = false;
    }
  } finally {
    // A mismatched file is never removed here: it may be a live successor.
    if (
      await pathExists(quarantinePath)
      && await pathMatchesStaleCandidate(quarantinePath, expected)
    ) {
      await removePathWithRetry(quarantinePath);
    }
  }
  return result;
}

function reclaimGateDirPath(lockPath: string): string {
  return `${lockPath}.reclaim.d`;
}

async function cleanupPendingOwnGates(): Promise<void> {
  for (const file of [...pendingOwnGateCleanup]) {
    await removePathWithRetry(file);
    if (!(await pathExists(file))) {
      await removePathWithRetry(gateReleaseMarkerPath(file));
      pendingOwnGateCleanup.delete(file);
    }
  }
}

async function findActiveReclaimGate(
  dirPath: string,
  requireProcessIdentity = true,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dirPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : dirPath;
  }

  const active: Array<{ filePath: string; record: LockRecord }> = [];
  for (const entry of entries) {
    if (!entry.startsWith('gate-') || !entry.endsWith('.json')) continue;
    const filePath = path.join(dirPath, entry);
    let stat: Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      continue;
    }
    const record = await readLockRecord(filePath, requireProcessIdentity);
    if (record === 'missing') continue;
    // A leftover .released sidecar from a previous gate instance shares the
    // same locked file name — its nonce must match the current gate record's
    // nonce, else it belongs to a different instance and must be ignored.
    const expectedNonce = typeof record !== 'string' ? (record.nonce ?? undefined) : undefined;
    if (await hasValidGateReleaseMarker(filePath, expectedNonce)) {
      await removePathWithRetry(filePath);
      // Keep the release proof while Windows still retains the gate path. If
      // the marker were removed first, the next contender would reinterpret
      // the same fresh file as a live owner and block until it became stale.
      if (!(await pathExists(filePath))) {
        await removePathWithRetry(gateReleaseMarkerPath(filePath));
      }
      continue;
    }
    if (typeof record === 'string') {
      const fresh = Date.now() - stat.mtimeMs <= LOCK_STALE_MS;
      if (
        fresh
        || (requireProcessIdentity && await isMalformedGateOwnerActive(filePath, stat))
      ) return filePath;
      await removePathWithRetry(filePath);
      if (await pathExists(filePath)) return filePath;
      continue;
    }
    if (record.state === 'released') {
      await removePathWithRetry(filePath);
      continue;
    }
    const fresh = Date.now() - stat.mtimeMs <= LOCK_STALE_MS;
    const createdAtMs = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
      ? stat.birthtimeMs
      : (Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0 ? stat.mtimeMs : null);
    if (fresh || await isRecordOwnerActive(record, createdAtMs)) {
      active.push({ filePath, record });
    } else {
      // Gate paths contain a never-reused nonce, so deleting a dead contender
      // cannot remove a successor that later acquired the same logical gate.
      await removePathWithRetry(filePath);
    }
  }
  active.sort((left, right) =>
    left.record.startedAt - right.record.startedAt
    || (left.record.nonce ?? '').localeCompare(right.record.nonce ?? '')
    || left.filePath.localeCompare(right.filePath));
  return active[0]?.filePath ?? null;
}

async function isMalformedGateOwnerActive(
  filePath: string,
  stat: Stats,
): Promise<boolean> {
  const match = /^gate-(\d+)-[0-9a-f-]+\.json$/i.exec(path.basename(filePath));
  if (!match) return true;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  const createdAtMs = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
    ? stat.birthtimeMs
    : stat.mtimeMs;
  return isRecordOwnerActive(
    {
      pid,
      startedAt: stat.mtimeMs,
      nonce: null,
      processStartIdentity: null,
      state: 'held',
    },
    createdAtMs,
  );
}

async function acquireReclaimGate(
  lockPath: string,
  waitMs = RELEASE_GATE_WAIT_MS,
  requireProcessIdentity = true,
): Promise<ReclaimGate | null> {
  await cleanupPendingOwnGates();
  const deadline = Date.now() + waitMs;
  do {
    if (await legacyReclaimInProgress(lockPath)) {
      if (Date.now() >= deadline) return null;
      await sleep(LOCK_RETRY_MS);
      continue;
    }

    const dirPath = reclaimGateDirPath(lockPath);
    try {
      await fsp.mkdir(dirPath, { recursive: true });
    } catch {
      return null;
    }
    const filePath = path.join(dirPath, `gate-${process.pid}-${crypto.randomUUID()}.json`);
    let lock: PublishedLock | null = null;
    try {
      lock = await publishLockRecord(
        filePath,
        requireProcessIdentity
          ? ((await getProcessIdentity(process.pid))?.key ?? null)
          : null,
      );
    } catch {
      return null;
    }
    if (!lock) return null;

    const heartbeat = setInterval(() => {
      const now = new Date();
      void lock?.handle.utimes(now, now).catch(() => undefined);
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    const gate: ReclaimGate = { dirPath, filePath, lock, heartbeat };
    for (;;) {
      const winner = await findActiveReclaimGate(dirPath, requireProcessIdentity);
      if (winner === filePath) return gate;
      if (winner === null || Date.now() >= deadline) {
        await releaseReclaimGate(gate);
        break;
      }
      await sleep(LOCK_RETRY_MS);
    }
    if (Date.now() >= deadline) return null;
  } while (true);
}

function sameRecord(left: LockRecord, right: LockRecord): boolean {
  return left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.nonce === right.nonce
    && left.processStartIdentity === right.processStartIdentity
    && left.state === right.state;
}

function sameLockOwner(left: LockRecord, right: LockRecord): boolean {
  return left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.nonce === right.nonce
    && left.processStartIdentity === right.processStartIdentity;
}

function malformedLockIdentity(stat: {
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  mtimeMs: number;
}): MalformedLockIdentity {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: Number(stat.size),
    mtimeMs: stat.mtimeMs,
  };
}

function sameMalformedLockIdentity(
  left: MalformedLockIdentity,
  right: MalformedLockIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function sameStaleCandidate(
  left: StaleLockCandidate | null,
  right: StaleLockCandidate,
): boolean {
  if (!left || left.kind !== right.kind) return false;
  if (left.kind === 'record' && right.kind === 'record') {
    return sameRecord(left.record, right.record);
  }
  return left.kind === 'malformed'
    && right.kind === 'malformed'
    && sameMalformedLockIdentity(left.identity, right.identity);
}

async function pathMatchesStaleCandidate(
  file: string,
  expected: StaleLockCandidate,
  requireCompleteRecord = false,
): Promise<boolean> {
  if (expected.kind === 'record') {
    const moved = await readLockRecord(file, requireCompleteRecord);
    return typeof moved !== 'string' && sameRecord(moved, expected.record);
  }
  try {
    const [stat, moved] = await Promise.all([fsp.stat(file), readLockRecord(file)]);
    return moved === 'malformed'
      && sameMalformedLockIdentity(malformedLockIdentity(stat), expected.identity);
  } catch {
    return false;
  }
}

async function isRecordOwnerActive(
  record: LockRecord,
  lockCreatedAtMs: number | null,
): Promise<boolean> {
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM' || code === 'EACCES') return true;
    // Some Windows runtimes report EINVAL for signal 0. Let the process-start
    // identity query decide when possible; if it also fails, the caller below
    // remains fail-closed.
  }
  const identityProbe = processIdentityProbeOverride
    ? await processIdentityProbeOverride(record.pid)
    : await probeProcessIdentity(record.pid);
  if (identityProbe.status === 'missing') return false;
  if (identityProbe.status === 'unavailable') return true;
  const currentIdentity = identityProbe.identity;
  // Exact process identity is the strongest signal and must be checked before
  // the self-pid shortcut: after a crash + PID reuse the OS may hand our pid to
  // this process while the lock still records the dead instance's identity, so
  // a mismatching identity on our own pid is a reused-pid takeover target (and
  // skipping the comparison would leave strict callers permanently busy).
  if (record.processStartIdentity) {
    return processIdentitiesMatch(record.processStartIdentity, currentIdentity);
  }
  // No recorded identity: the current process is always the live holder of a
  // lock it wrote — its start time cannot be compared against the lock's
  // creation time reliably (a long-lived worker can predate the lock while a
  // short-lived one starts after it), so a record naming our own pid is never
  // a PID-reuse takeover target without an identity to disprove it.
  if (record.pid === process.pid) return true;
  // Legacy record without a processStartIdentity: kill(pid, 0) succeeded, so
  // the pid is alive. We cannot distinguish a still-running original holder
  // from a reused pid, and a live holder must never be squeezed out of its lock
  // (it may be mid-drain/cleanup with an old mtime). Treat a live non-self pid
  // as the active holder (fail closed). A PID-reuse takeover is only sound when
  // the exact process identity was recorded in the lock, so this is the
  // platform-independent, timing-independent safe answer.
  return true;
}

async function getProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (pid === process.pid) {
    currentProcessIdentityPromise ??= readProcessIdentity(pid);
    return currentProcessIdentityPromise;
  }
  return readProcessIdentity(pid);
}

async function readProcessIdentity(
  pid: number,
  runCommand: ExecFileRunner = execFileAsync as ExecFileRunner,
): Promise<ProcessIdentity | null> {
  const probe = await probeProcessIdentity(pid, runCommand);
  if (probe.status === 'found') return probe.identity;
  return pid === process.pid ? estimateCurrentProcessIdentity() : null;
}

async function probeProcessIdentity(
  pid: number,
  runCommand: ExecFileRunner = execFileAsync as ExecFileRunner,
): Promise<ProcessIdentityProbe> {
  if (process.platform === 'win32') {
    const fromPowershell = await readWindowsIdentityWithPowershell(pid, runCommand);
    if (fromPowershell.status !== 'unavailable') return fromPowershell;
    const fromWmic = await readWindowsIdentityWithWmic(pid, runCommand);
    return fromWmic;
  }
  try {
    const { stdout } = await runCommand(
      'ps',
      ['-p', String(pid), '-o', 'lstart='],
      {
        encoding: 'utf8',
        timeout: 5_000,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
      },
    );
    const value = stdout.trim().replace(/\s+/g, ' ');
    // A successful command with no parseable identity is not affirmative
    // proof that the process is gone. `process.kill(pid, 0)` already handles
    // the OS-level missing case; keep ambiguous `ps` output fail-closed.
    if (!value) return { status: 'unavailable' };
    const parsed = Date.parse(`${value} UTC`);
    const identity = processIdentityFromStartMs(parsed, value);
    return identity ? { status: 'found', identity } : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

async function readWindowsIdentityWithPowershell(
  pid: number,
  runCommand: ExecFileRunner,
): Promise<ProcessIdentityProbe> {
  try {
    const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}`
      + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const script =
      `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop; `
      + `if ($null -eq $p) { 'MISSING' } else { $p.CreationDate.ToUniversalTime().Ticks }`;
    const { stdout } = await runCommand(
      powershell,
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
    );
    const value = stdout.trim();
    if (value === 'MISSING') return { status: 'missing' };
    if (!/^\d+$/.test(value)) return { status: 'unavailable' };
    const ticks = Number(value);
    const identity = processIdentityFromStartMs(ticks / 10_000 - 62_135_596_800_000);
    return identity ? { status: 'found', identity } : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

async function readWindowsIdentityWithWmic(
  pid: number,
  runCommand: ExecFileRunner,
): Promise<ProcessIdentityProbe> {
  try {
    const wmic = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wbem\\WMIC.exe`;
    const { stdout } = await runCommand(
      wmic,
      ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
    );
    const match = stdout.match(/CreationDate=(\d{14})\.(\d{1,6})([+-]\d{3})/i);
    if (!match) {
      return /^\s*No Instance\(s\) Available\.\s*$/i.test(stdout)
        ? { status: 'missing' }
        : { status: 'unavailable' };
    }
    const stamp = match[1];
    const micros = match[2].padEnd(6, '0');
    const offsetMinutes = Number(match[3]);
    const localMs = Date.UTC(
      Number(stamp.slice(0, 4)),
      Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8)),
      Number(stamp.slice(8, 10)),
      Number(stamp.slice(10, 12)),
      Number(stamp.slice(12, 14)),
      Number(micros.slice(0, 3)),
    );
    const identity = processIdentityFromStartMs(localMs - offsetMinutes * 60_000);
    return identity ? { status: 'found', identity } : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

function estimateCurrentProcessIdentity(): ProcessIdentity {
  return processIdentityFromStartMs(Date.now() - process.uptime() * 1_000)!;
}

function processIdentityFromStartMs(
  startedAtMs: number,
  legacyKey?: string,
): ProcessIdentity | null {
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  const normalized = Math.round(startedAtMs);
  return { key: legacyKey ?? `start-ms:${normalized}`, startedAtMs: normalized };
}

function isValidNonce(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseRecordedProcessStartMs(key: string): number | null {
  const normalized = /^start-ms:(\d+)$/.exec(key);
  if (normalized) {
    const value = Number(normalized[1]);
    return value > 0 && Number.isFinite(value) ? value : null;
  }
  if (/^\d{15,}$/.test(key)) {
    const ticks = Number(key);
    const value = ticks / 10_000 - 62_135_596_800_000;
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const parsed = Date.parse(`${key} UTC`);
  return Number.isFinite(parsed) ? parsed : null;
}

function processIdentitiesMatch(recordedKey: string, current: ProcessIdentity): boolean {
  if (recordedKey === current.key) return true;
  const recordedStartedAtMs = parseRecordedProcessStartMs(recordedKey);
  return recordedStartedAtMs !== null
    && current.startedAtMs !== null
    && Math.abs(recordedStartedAtMs - current.startedAtMs) <= LEGACY_PID_REUSE_TOLERANCE_MS;
}

async function markReleased(lock: PublishedLock): Promise<void> {
  const released: LockRecord = { ...lock.record, state: 'released' };
  const originalText = JSON.stringify(lock.record);
  const releasedText = JSON.stringify(released);
  try {
    await writeAllAt(lock.handle, releasedText);
    await lock.handle.truncate(Buffer.byteLength(releasedText));
    await lock.handle.sync();
    lock.record = released;
  } catch (error) {
    // A partial write must never be left as the canonical lock record. Restore
    // the held record when possible; if that also fails, callers remain
    // fail-closed and retain the nonce for the next safe recovery attempt.
    try {
      await writeAllAt(lock.handle, originalText);
      await lock.handle.truncate(Buffer.byteLength(originalText));
      await lock.handle.sync();
      lock.record = { ...lock.record, state: 'held' };
    } catch (restoreError) {
      log.error('lock release record could not be restored after a short write', restoreError);
    }
    throw error;
  }
}

async function writeAllAt(
  handle: Awaited<ReturnType<typeof fsp.open>>,
  text: string,
): Promise<void> {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten <= 0) throw new Error('lock record write made no progress');
    offset += result.bytesWritten;
  }
}

async function cleanupPublishedLock(
  lockPath: string,
  label: string,
  lock: PublishedLock,
): Promise<void> {
  const gate = await acquireReclaimGate(lockPath);
  if (!gate) {
    pendingOwnRecordRecovery.set(lockPath, lock.nonce);
    await markReleased(lock).catch((error) => {
      log.warn(`${label} lock could not be flushed before release`, error);
    });
    await lock.handle.close().catch(() => undefined);
    log.warn(`${label} lock release gate is busy; leaving a recoverable released record`);
    return;
  }

  const releasePath = `${lockPath}.release-${process.pid}-${crypto.randomUUID()}`;
  try {
    const current = await readLockRecord(lockPath);
    if (typeof current === 'string' || !sameLockOwner(current, lock.record)) {
      await lock.handle.close().catch(() => undefined);
      log.warn(`${label} lock identity changed before release; preserving current lock`);
      return;
    }
    try {
      await markReleased(lock);
    } catch (error) {
      pendingOwnRecordRecovery.set(lockPath, lock.nonce);
      log.warn(`${label} lock could not be flushed before release`, error);
      // Keep the canonical record held until a later nonce-checked recovery.
      // Moving an uncertain record would allow another process to acquire the
      // lock without knowing whether the release state reached durable storage.
      await lock.handle.close().catch(() => undefined);
      return;
    }
    await lock.handle.close().catch(() => undefined);
    try {
      await fsp.rename(lockPath, releasePath);
    } catch {
      pendingOwnRecordRecovery.set(lockPath, lock.nonce);
      return;
    }
    const moved = await readLockRecord(releasePath);
    if (typeof moved !== 'string' && moved.nonce === lock.nonce) {
      await removePathWithRetry(releasePath);
    } else {
      log.warn(`${label} lock identity changed during release; preserving the isolated record`);
    }
  } finally {
    await releaseReclaimGate(gate);
  }
}

async function releaseReclaimGate(gate: ReclaimGate): Promise<void> {
  clearInterval(gate.heartbeat);
  let releasedRecordDurable = false;
  try {
    await markReleased(gate.lock);
    releasedRecordDurable = true;
  } catch (error) {
    log.warn('lock reclaim gate could not be flushed before release', error);
    await publishGateReleaseMarker(gate.filePath, gate.lock.nonce).catch((markerError) => {
      log.warn('lock reclaim gate release marker could not be published', markerError);
    });
  }
  await gate.lock.handle.close().catch(() => undefined);
  await removePathWithRetry(gate.filePath);
  if (await pathExists(gate.filePath)) {
    pendingOwnGateCleanup.add(gate.filePath);
  } else if (!releasedRecordDurable) {
    await removePathWithRetry(gateReleaseMarkerPath(gate.filePath));
  }
  await removeEmptyDirectoryWithRetry(gate.dirPath);
}

async function publishGateReleaseMarker(gatePath: string, nonce: string): Promise<void> {
  const markerPath = gateReleaseMarkerPath(gatePath);
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(markerPath, 'wx');
    await writeAllAt(handle, JSON.stringify({
      gateFile: path.basename(gatePath),
      nonce,
    }));
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await hasValidGateReleaseMarker(gatePath, nonce))) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function hasValidGateReleaseMarker(gatePath: string, expectedNonce?: string): Promise<boolean> {
  const markerPath = gateReleaseMarkerPath(gatePath);
  const gateDir = path.dirname(gatePath);
  let gateRealDir: string;
  try {
    // This record is read asynchronously below, so anchor the root with the
    // same async realpath representation (see readLockRecord above).
    gateRealDir = await fsp.realpath(gateDir);
  } catch {
    return false;
  }
  let bytes: Buffer | null;
  try {
    bytes = await readBoundedFileNoFollow(markerPath, 4 * 1024, {
      containWithin: gateRealDir,
      nonBlocking: true,
    });
  } catch {
    return false;
  }
  if (bytes === null) return false;
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (
      !value
      || typeof value !== 'object'
      || Array.isArray(value)
    ) return false;
    const obj = value as Record<string, unknown>;
    if (obj.gateFile !== path.basename(gatePath)) return false;
    if (typeof obj.nonce !== 'string' || !isValidNonce(obj.nonce)) return false;
    if (expectedNonce !== undefined && obj.nonce !== expectedNonce) return false;
    return true;
  } catch {
    return false;
  }
}

async function recoverPendingOwnRecord(file: string): Promise<void> {
  const nonce = pendingOwnRecordRecovery.get(file);
  if (!nonce) return;

  const gate = await acquireReclaimGate(file);
  if (!gate) return;
  try {
    const record = await readLockRecord(file);
    if (record === 'missing' || (typeof record !== 'string' && record.nonce !== nonce)) {
      pendingOwnRecordRecovery.delete(file);
      return;
    }
    if (
      typeof record === 'string'
      || record.pid !== process.pid
      || record.nonce !== nonce
    ) {
      return;
    }

    const recoveryPath = `${file}.recover-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fsp.rename(file, recoveryPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') pendingOwnRecordRecovery.delete(file);
      return;
    }

    const moved = await readLockRecord(recoveryPath);
    if (typeof moved !== 'string' && moved.pid === process.pid && moved.nonce === nonce) {
      pendingOwnRecordRecovery.delete(file);
      await removePathWithRetry(recoveryPath);
      return;
    }

    await restoreMovedPathSafely(recoveryPath, file);
  } finally {
    await releaseReclaimGate(gate);
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fsp.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Restore a moved record without replacing a successor that won the path. */
async function restoreMovedPathSafely(from: string, to: string): Promise<void> {
  try {
    await fsp.link(from, to);
    await removePathWithRetry(from);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') return;
  }
}

async function removePathWithRetry(file: string): Promise<void> {
  for (let attempt = 0; attempt < REMOVE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fsp.rm(file, { force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') return;
      if (attempt + 1 < REMOVE_RETRY_ATTEMPTS) await sleep(LOCK_RETRY_MS * (attempt + 1));
    }
  }
}

/** Retry only empty-directory removal; never delete a contender recursively. */
async function removeEmptyDirectoryWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < EMPTY_DIR_REMOVE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fsp.rmdir(dir);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'ENOTEMPTY') {
        return;
      }
      if (attempt + 1 < EMPTY_DIR_REMOVE_RETRY_ATTEMPTS) {
        await sleep(LOCK_RETRY_MS * (attempt + 1));
      }
    }
  }
}

export const __testing = {
  staleMs: LOCK_STALE_MS,
  heartbeatMs: LOCK_HEARTBEAT_MS,
  getProcessIdentity,
  readProcessIdentity,
  probeProcessIdentity,
  readWindowsIdentityWithPowershell,
  readWindowsIdentityWithWmic,
  removeEmptyDirectoryWithRetry,
  parseRecordedProcessStartMs,
  processIdentitiesMatch,
  setProcessIdentityProbeOverride(override: ProcessIdentityProbeOverride | null): void {
    processIdentityProbeOverride = override;
  },
};
