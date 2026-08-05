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

export interface SchemaMigrationLease {
  kind: 'reader' | 'writer';
  release(): void;
}

export type AcquireSchemaMigrationLeaseResult =
  | { acquired: true; lease: SchemaMigrationLease }
  | { acquired: false; reason: 'writer-active' | 'readers-active'; activeReaderCount?: number };

export type EnsureSchemaMigrationReaderLeaseResult =
  { acquired: true; newlyAcquired: boolean } | { acquired: false; reason: 'writer-active' };

export type SchemaStartupLeaseResult =
  | {
      acquired: true;
      kind: 'reader' | 'writer';
      lease: SchemaMigrationLease;
      newlyAcquired: boolean;
    }
  | {
      acquired: false;
      reason: 'writer-active' | 'readers-active';
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
export function acquireSchemaStartupLease(
  options: AcquireSchemaStartupLeaseOptions,
): SchemaStartupLeaseResult {
  const readerLifecycle = options.readerLifecycle ?? new SchemaMigrationReaderLeaseLifecycle();
  if (options.sharedPassive) {
    const result = readerLifecycle.ensure(options.dbFilePath);
    return result.acquired
      ? {
          acquired: true,
          kind: 'reader',
          lease: readerLifecycleLease(readerLifecycle, result),
          newlyAcquired: result.newlyAcquired,
        }
      : result;
  }

  const writer = acquireSchemaMigrationWriterLease(options.dbFilePath);
  if (writer.acquired) {
    return { acquired: true, kind: 'writer', lease: writer.lease, newlyAcquired: true };
  }
  if (!options.packaged || writer.reason !== 'readers-active') return writer;

  const packagedReader = readerLifecycle.ensure(options.dbFilePath);
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

function readOwner(filePath: string): LeaseOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<LeaseOwner>;
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isSafeInteger(parsed.pid) ||
      typeof parsed.token !== 'string' ||
      typeof parsed.createdAt !== 'string'
    ) {
      return null;
    }
    return parsed as LeaseOwner;
  } catch {
    return null;
  }
}

function removeIfDead(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return true;
  const owner = readOwner(filePath);
  // 内容损坏时 fail closed，避免误删一个正在创建的租约。
  if (!owner || isProcessAlive(owner.pid)) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return !fs.existsSync(filePath);
  }
}

function writeOwnerExclusive(filePath: string, owner: LeaseOwner): boolean {
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
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
  const current = readOwner(filePath);
  if (!current || current.token !== owner.token || current.pid !== owner.pid) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* 退出 / 失败清理 best effort；下次会按 pid 清死租约。 */
  }
}

function activeReaderFiles(readersDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(readersDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const active: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(readersDir, entry);
    if (!removeIfDead(filePath)) active.push(filePath);
  }
  return active;
}

/** passive 在打开 / 检查共享 DB 前获取，并持有到 `closeDb()`。 */
export function acquireSchemaMigrationReaderLease(
  dbFilePath: string,
): AcquireSchemaMigrationLeaseResult {
  const paths = leasePaths(dbFilePath);
  removeIfDead(paths.writer);
  if (fs.existsSync(paths.writer)) return { acquired: false, reason: 'writer-active' };

  fs.mkdirSync(paths.readers, { recursive: true, mode: 0o700 });
  const owner = createOwner();
  const readerPath = path.join(paths.readers, `${owner.pid}-${owner.token}.json`);
  if (!writeOwnerExclusive(readerPath, owner)) {
    return { acquired: false, reason: 'writer-active' };
  }

  // writer 可能在第一次检查与 reader 原子写入之间抢到锁；此时 reader 必须让路。
  removeIfDead(paths.writer);
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
}

/** primary / packaged 在任何 migration 或 schema DDL repair 前获取。 */
export function acquireSchemaMigrationWriterLease(
  dbFilePath: string,
): AcquireSchemaMigrationLeaseResult {
  const paths = leasePaths(dbFilePath);
  removeIfDead(paths.writer);
  const owner = createOwner();
  if (!writeOwnerExclusive(paths.writer, owner)) {
    return { acquired: false, reason: 'writer-active' };
  }

  const readers = activeReaderFiles(paths.readers);
  if (readers.length > 0) {
    releaseOwnedFile(paths.writer, owner);
    return { acquired: false, reason: 'readers-active', activeReaderCount: readers.length };
  }

  return {
    acquired: true,
    lease: {
      kind: 'writer',
      release: () => releaseOwnedFile(paths.writer, owner),
    },
  };
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

  ensure(dbFilePath: string): EnsureSchemaMigrationReaderLeaseResult {
    if (this.lease && this.dbFilePath === dbFilePath) {
      return { acquired: true, newlyAcquired: false };
    }
    this.release();
    const result = acquireSchemaMigrationReaderLease(dbFilePath);
    if (!result.acquired) return { acquired: false, reason: 'writer-active' };
    this.lease = result.lease;
    this.dbFilePath = dbFilePath;
    return { acquired: true, newlyAcquired: true };
  }

  closeConnection(preserveSchemaMigrationLease = false): void {
    if (!preserveSchemaMigrationLease) this.release();
  }

  release(): void {
    this.lease?.release();
    this.lease = null;
    this.dbFilePath = null;
  }
}
