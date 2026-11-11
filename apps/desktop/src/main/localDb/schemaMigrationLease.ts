/**
 * 跨进程 schema migration 读写租约。
 *
 * passive 共享库实例持有多 owner reader lease 直至关闭 DB；primary / packaged 启动
 * migration 前必须原子取得唯一 writer lease。reader 的「写入后再检查 writer」与 writer
 * 的「建锁后再扫描 reader」共同消除启动检查和后续 migration 之间的 TOCTOU。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFileNoFollowSync } from '../utils/readBoundedFile';
import { readSchemaMigrationBootIdentity } from './schemaMigrationBootIdentity';

export type SchemaLeaseFailureReason =
  'writer-active' | 'readers-active' | 'lock-corrupt' | 'lock-unreadable' | 'recovery-busy';

export interface SchemaMigrationLease {
  kind: 'reader' | 'writer';
  release(): void;
}

export type AcquireSchemaMigrationLeaseResult =
  | { acquired: true; lease: SchemaMigrationLease }
  | { acquired: false; reason: SchemaLeaseFailureReason; activeReaderCount?: number };

export type EnsureSchemaMigrationReaderLeaseResult =
  | { acquired: true; newlyAcquired: boolean }
  | { acquired: false; reason: SchemaLeaseFailureReason };

export type SchemaStartupLeaseResult =
  | {
      acquired: true;
      kind: 'reader' | 'writer';
      lease: SchemaMigrationLease;
      newlyAcquired: boolean;
    }
  | {
      acquired: false;
      reason: SchemaLeaseFailureReason;
      activeReaderCount?: number;
    };

export interface AcquireSchemaStartupLeaseOptions {
  dbFilePath: string;
  packaged: boolean;
  sharedPassive: boolean;
  readerLifecycle?: SchemaMigrationReaderLeaseLifecycle;
}

/**
 * Select the startup lease without deciding how the caller presents failures.
 * Packaged instances may join existing readers, but only as a reader; this keeps
 * the actual fallback branch small and directly testable without Electron.
 */
export async function acquireSchemaStartupLease(
  options: AcquireSchemaStartupLeaseOptions,
): Promise<SchemaStartupLeaseResult> {
  const readerLifecycle = options.readerLifecycle ?? new SchemaMigrationReaderLeaseLifecycle();
  if (options.sharedPassive) {
    const result = await readerLifecycle.ensure(options.dbFilePath);
    return result.acquired
      ? {
          acquired: true,
          kind: 'reader',
          lease: readerLifecycleLease(readerLifecycle, result),
          newlyAcquired: result.newlyAcquired,
        }
      : result;
  }

  const writer = await acquireSchemaMigrationWriterLease(options.dbFilePath);
  if (writer.acquired) {
    return { acquired: true, kind: 'writer', lease: writer.lease, newlyAcquired: true };
  }
  if (!options.packaged || writer.reason !== 'readers-active') return writer;

  const packagedReader = await readerLifecycle.ensure(options.dbFilePath);
  return packagedReader.acquired
    ? {
        acquired: true,
        kind: 'reader',
        lease: readerLifecycleLease(readerLifecycle, packagedReader),
        newlyAcquired: packagedReader.newlyAcquired,
      }
    : packagedReader;
}

function readerLifecycleLease(
  lifecycle: SchemaMigrationReaderLeaseLifecycle,
  result: EnsureSchemaMigrationReaderLeaseResult,
): SchemaMigrationLease {
  return {
    kind: 'reader',
    release: () => {
      if ('newlyAcquired' in result && result.newlyAcquired) lifecycle.release();
    },
  };
}

interface LeaseOwner {
  pid: number;
  token: string;
  createdAt: string;
}

function leasePaths(dbFilePath: string): { writer: string; readers: string } {
  return {
    writer: `${dbFilePath}.schema-writer.lock`,
    readers: `${dbFilePath}.schema-readers`,
  };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function parseOwner(bytes: Buffer): LeaseOwner | null {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as Partial<LeaseOwner> | null;
    if (
      !parsed ||
      typeof parsed.pid !== 'number' ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.token !== 'string' ||
      parsed.token.length === 0 ||
      typeof parsed.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.createdAt))
    ) {
      return null;
    }
    return parsed as LeaseOwner;
  } catch {
    return null;
  }
}

type RecordSnapshot =
  | { state: 'missing' | 'unreadable' }
  | {
      state: 'readable';
      owner: LeaseOwner | null;
      fingerprint: string;
      identity: string;
      bytes: Buffer;
    };

function sidecarPath(filePath: string, suffix: string): string {
  const parent = path.dirname(filePath);
  return path.basename(parent).endsWith('.schema-readers')
    ? path.join(
        path.dirname(parent),
        `${path.basename(parent)}.${path.basename(filePath)}${suffix}`,
      )
    : `${filePath}${suffix}`;
}

function readRecord(filePath: string): RecordSnapshot {
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    const bytes = readBoundedFileNoFollowSync(filePath, 16 * 1024);
    const after = fs.lstatSync(filePath, { bigint: true });
    const identity = (stat: fs.BigIntStats) =>
      [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
    if (!bytes || !before.isFile() || identity(before) !== identity(after)) {
      return { state: 'unreadable' };
    }
    return {
      state: 'readable',
      owner: parseOwner(bytes),
      bytes,
      // Rename may change ctime; these fields and the bytes must survive isolation.
      identity: [after.dev, after.ino, after.size, after.mtimeNs, after.birthtimeNs].join(':'),
      fingerprint: crypto.createHash('sha256').update(identity(after)).update(bytes).digest('hex'),
    };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

/** Flush a private candidate before publishing, without ever replacing an incumbent. */
function writeOwnerExclusive(filePath: string, owner: LeaseOwner): boolean {
  // Reader candidates live outside the readers directory: old clients scan every entry there.
  const stagingPath = sidecarPath(filePath, `.candidate-${owner.pid}-${owner.token}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(stagingPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(stagingPath, filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(stagingPath);
    } catch {
      /* Private interrupted candidates never grant a lease. */
    }
  }
}

/** Called only under the per-database transition lock. No age-based takeover. */
async function clearInactiveRecord(filePath: string): Promise<SchemaLeaseFailureReason | null> {
  const record = readRecord(filePath);
  if (record.state === 'missing') return null;
  if (record.state !== 'readable') return 'lock-unreadable';
  const observationPath = sidecarPath(filePath, '.recovery-observation');
  if (record.owner) {
    if (isProcessAlive(record.owner.pid)) return 'writer-active';
  } else {
    const boot = await readSchemaMigrationBootIdentity();
    if (!boot) return 'lock-corrupt';
    let previous: { boot?: string; fingerprint?: string } | null = null;
    try {
      const bytes = readBoundedFileNoFollowSync(observationPath, 4096);
      previous = bytes ? JSON.parse(bytes.toString('utf8')) : null;
    } catch {
      /* An absent or unreadable observation is not recovery evidence. */
    }
    if (
      !previous ||
      typeof previous.boot !== 'string' ||
      previous.boot === boot ||
      previous.fingerprint !== record.fingerprint
    ) {
      // An unknown owner could be a suspended legacy publisher. Remember this exact
      // file and require a DIFFERENT kernel boot generation before isolating it.
      const candidate = `${observationPath}.${crypto.randomUUID()}.tmp`;
      let fd: number | undefined;
      try {
        fd = fs.openSync(candidate, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ boot, fingerprint: record.fingerprint }), 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(candidate, observationPath);
      } catch {
        return 'lock-unreadable';
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try {
          fs.unlinkSync(candidate);
        } catch {
          /* best effort */
        }
      }
      return 'lock-corrupt';
    }
  }

  const current = readRecord(filePath);
  if (current.state === 'missing') return null;
  if (current.state !== 'readable' || current.fingerprint !== record.fingerprint) {
    return 'recovery-busy';
  }
  // Retain the bytes for support; reader backups must not be scanned as live readers.
  const backup = sidecarPath(filePath, `.schema-lease-backup-${crypto.randomUUID()}`);
  try {
    fs.renameSync(filePath, backup);
    const isolated = readRecord(backup);
    if (
      isolated.state !== 'readable' ||
      isolated.identity !== record.identity ||
      !isolated.bytes.equals(record.bytes)
    ) {
      // A legacy client does not take our transition gate. Never grant a lease if
      // it replaced the record between our last check and the rename. Restore
      // without overwriting any incumbent, and retain the backup for support.
      try {
        fs.linkSync(backup, filePath);
      } catch {
        /* A competing owner or IO error must not turn this into an acquisition. */
      }
      return 'recovery-busy';
    }
    try {
      fs.unlinkSync(observationPath);
    } catch {
      /* A stale observation cannot match a new inode. */
    }
    return null;
  } catch {
    return 'lock-unreadable';
  }
}

async function withLeaseTransition(
  dbFilePath: string,
  task: () => Promise<AcquireSchemaMigrationLeaseResult>,
): Promise<AcquireSchemaMigrationLeaseResult> {
  const gate = `${dbFilePath}.schema-transition`;
  // Put the boot generation in the immutable directory entry, not mutable JSON.
  // A live PID in another boot cannot belong to the crashed gate publisher.
  const boot = await readSchemaMigrationBootIdentity();
  const bootTag = boot ? crypto.createHash('sha256').update(boot).digest('hex') : null;
  const marker = `owner-${process.pid}-${crypto.randomUUID()}${bootTag ? `-boot-${bootTag}` : ''}`;
  const candidate = `${gate}.${marker}.candidate`;
  let held = false;
  try {
    fs.mkdirSync(candidate, { mode: 0o700 });
    fs.writeFileSync(path.join(candidate, marker), '', { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // A complete NONEMPTY directory is published atomically. It cannot
        // replace another nonempty gate on Windows, Linux or macOS.
        fs.renameSync(candidate, gate);
        held = true;
        return await task();
      } catch (error) {
        if (held) throw error;
        let entries: string[];
        try {
          if (!fs.lstatSync(gate).isDirectory()) {
            return { acquired: false, reason: 'lock-unreadable' };
          }
          entries = fs.readdirSync(gate);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw readError;
        }
        if (entries.length > 0) {
          const owner =
            entries.length === 1 &&
            /^owner-([1-9]\d*)-[a-f0-9-]{36}(?:-boot-([a-f0-9]{64}))?$/.exec(entries[0]);
          if (!owner) return { acquired: false, reason: 'lock-unreadable' };
          const fromPreviousBoot = Boolean(bootTag && owner[2] && owner[2] !== bootTag);
          if (!fromPreviousBoot && isProcessAlive(Number(owner[1]))) {
            return { acquired: false, reason: 'recovery-busy' };
          }
          // Only unlink this unique dead owner's marker. A delayed reclaimer
          // must never delete a successor's marker (even after PID reuse).
          try {
            fs.unlinkSync(path.join(gate, entries[0]));
          } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
          }
        }
        try {
          fs.rmdirSync(gate);
        } catch (removeError) {
          const code = (removeError as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw removeError;
        }
      }
    }
    return { acquired: false, reason: 'recovery-busy' };
  } catch {
    return { acquired: false, reason: 'lock-unreadable' };
  } finally {
    // Crashing between unlink and rmdir leaves an empty, safely reclaimable gate.
    // rmdir (never recursive deletion) cannot remove a newly published owner.
    const directory = held ? gate : candidate;
    try {
      fs.unlinkSync(path.join(directory, marker));
    } catch {
      /* best effort */
    }
    try {
      fs.rmdirSync(directory);
    } catch {
      /* A successor's nonempty directory must be left intact. */
    }
  }
}

function createOwner(): LeaseOwner {
  return {
    pid: process.pid,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
}

function releaseOwnedFile(filePath: string, owner: LeaseOwner): void {
  const current = readRecord(filePath);
  if (
    current.state !== 'readable' ||
    current.owner?.token !== owner.token ||
    current.owner.pid !== owner.pid
  )
    return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* 退出 / 失败清理 best effort；下次会按 pid 清死租约。 */
  }
}

async function activeReaderFiles(
  readersDir: string,
): Promise<{ count: number; failure?: SchemaLeaseFailureReason }> {
  let entries: string[];
  try {
    entries = fs.readdirSync(readersDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { count: 0 };
    throw err;
  }
  let count = 0;
  for (const entry of entries) {
    const filePath = path.join(readersDir, entry);
    const failure = await clearInactiveRecord(filePath);
    if (failure === 'writer-active') count++;
    else if (failure) return { count, failure };
  }
  return { count };
}

/** passive 在打开 / 检查共享 DB 前获取，并持有到 `closeDb()`。 */
export async function acquireSchemaMigrationReaderLease(
  dbFilePath: string,
): Promise<AcquireSchemaMigrationLeaseResult> {
  return withLeaseTransition(dbFilePath, async () => {
    const paths = leasePaths(dbFilePath);
    const failure = await clearInactiveRecord(paths.writer);
    if (failure) return { acquired: false, reason: failure };

    fs.mkdirSync(paths.readers, { recursive: true, mode: 0o700 });
    const owner = createOwner();
    const readerPath = path.join(paths.readers, `${owner.pid}-${owner.token}.json`);
    if (!writeOwnerExclusive(readerPath, owner)) {
      return { acquired: false, reason: 'writer-active' };
    }

    // writer 可能在第一次检查与 reader 原子写入之间抢到锁；此时 reader 必须让路。
    // Old clients do not take the transition lock, so keep the original double check.
    if (fs.existsSync(paths.writer)) {
      releaseOwnedFile(readerPath, owner);
      return { acquired: false, reason: 'writer-active' };
    }

    return {
      acquired: true,
      lease: {
        kind: 'reader',
        release: () => releaseOwnedFile(readerPath, owner),
      },
    };
  });
}

/** primary / packaged 在任何 migration 或 schema DDL repair 前获取。 */
export async function acquireSchemaMigrationWriterLease(
  dbFilePath: string,
): Promise<AcquireSchemaMigrationLeaseResult> {
  return withLeaseTransition(dbFilePath, async () => {
    const paths = leasePaths(dbFilePath);
    const failure = await clearInactiveRecord(paths.writer);
    if (failure) return { acquired: false, reason: failure };
    const owner = createOwner();
    if (!writeOwnerExclusive(paths.writer, owner)) {
      return { acquired: false, reason: 'writer-active' };
    }

    let admitted = false;
    try {
      const readers = await activeReaderFiles(paths.readers);
      if (readers.failure || readers.count > 0) {
        return {
          acquired: false,
          reason: readers.failure ?? 'readers-active',
          activeReaderCount: readers.count,
        };
      }
      admitted = true;
      return {
        acquired: true,
        lease: { kind: 'writer', release: () => releaseOwnedFile(paths.writer, owner) },
      };
    } finally {
      if (!admitted) releaseOwnedFile(paths.writer, owner);
    }
  });
}

/**
 * main 进程持有的 passive reader lease 生命周期槽。
 *
 * DB worker takeover 只关闭 main-side connection，必须 `closeConnection(true)` 保留租约；
 * logout / account switch / app quit 才用默认关闭释放。类本身 Electron 无关，便于用真实
 * 文件租约验证 takeover 与退出行为，而不是只做源码字符串断言。
 */
export class SchemaMigrationReaderLeaseLifecycle {
  private lease: SchemaMigrationLease | null = null;
  private dbFilePath: string | null = null;
  private generation = 0;
  private pending: {
    dbFilePath: string;
    result: Promise<EnsureSchemaMigrationReaderLeaseResult>;
  } | null = null;

  async ensure(dbFilePath: string): Promise<EnsureSchemaMigrationReaderLeaseResult> {
    if (this.lease && this.dbFilePath === dbFilePath) {
      return { acquired: true, newlyAcquired: false };
    }
    if (this.pending?.dbFilePath === dbFilePath) {
      const result = await this.pending.result;
      return result.acquired ? { acquired: true, newlyAcquired: false } : result;
    }
    this.release();
    const generation = this.generation;
    const result = acquireSchemaMigrationReaderLease(dbFilePath).then(
      (acquired): EnsureSchemaMigrationReaderLeaseResult => {
        if (generation !== this.generation) {
          if (acquired.acquired) acquired.lease.release();
          return { acquired: false, reason: 'recovery-busy' };
        }
        if (!acquired.acquired) return acquired;
        this.lease = acquired.lease;
        this.dbFilePath = dbFilePath;
        return { acquired: true, newlyAcquired: true };
      },
    );
    this.pending = { dbFilePath, result };
    try {
      return await result;
    } finally {
      if (this.pending?.result === result) this.pending = null;
    }
  }

  closeConnection(preserveSchemaMigrationLease = false): void {
    if (!preserveSchemaMigrationLease) this.release();
  }

  release(): void {
    this.generation++;
    this.pending = null;
    this.lease?.release();
    this.lease = null;
    this.dbFilePath = null;
  }
}
