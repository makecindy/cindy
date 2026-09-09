/**
 * device-link 同机多实例单持有者仲裁(single-owner arbitration)。
 *
 * 问题:多个实例共享同一 userData(同 deviceId)时,relay 服务端对同
 * (userId, deviceId) 是 last-wins 顶号语义 —— 双活实例会无限互踢(4409 循环),
 * 手机端远程连接在实例间漂移("会话壳建在 A、消息发到 B、回传流丢失")。
 *
 * 方案:对一份很小的锁文件持有操作系统文件锁(SQLite EXCLUSIVE,底层是
 * fcntl / LockFileEx)。first-wins:
 *  - 抢到锁的实例持有连接权(onAcquire → client.start())。
 *  - 其余实例保持被动:不发起 relay 连接,只按 retryMs 再试。
 *  - 进程崩溃 / 被杀 / 断电 → OS 释放锁,同伴下一轮即可接手,不用等心跳过期。
 *  - 正常退出 / 登出走 stop() 关连接,锁立刻掉。
 *  - 单纯网络断线**不**让出持有权:锁在本机,与 relay 无关。
 *
 * 不用心跳租约,也不用 PID 探活。进程冻死但未退出时锁不会掉,同伴不会误抢;
 * 这是文件锁相对 15s 过期窗口的取舍。
 *
 * 锁文件按 userId 隔离,不打开聊天库。历史表 device_link_ownership 不再读写。
 *
 * 混版本不回写旧租约:旧进程只认那张表,新进程只认文件锁,两边互相看不见。
 * 同 userData 的 official+dev 若一个仍走心跳、一个已换文件锁,会双连 relay
 * (4409)。同版本之间由文件锁仲裁;跨版本请用 --isolated,或先退出旧进程。
 * 不双写旧表 —— 那会重新绑上聊天库,并让「谁是持有者」出现两套判据。
 *
 * 分层:本模块是纯 main 侧业务逻辑,锁依赖注入(可用内存实现单测),
 * packages/device-link 保持纯传输层不感知仲裁。
 */

import type Database from 'better-sqlite3';

import { createBetterSqliteDatabase } from '../localDb/betterSqliteFactory';

import { createLogger } from '../logger';

const log = createLogger('device-link-ownership');

/** 被动实例重试抢锁的间隔。崩溃后接管延迟由这一拍决定,不是过期窗口。 */
export const DEFAULT_LOCK_RETRY_MS = 500;

function sqliteErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object' || !('code' in err)) return '';
  return String((err as { code: unknown }).code);
}

/** SQLITE_BUSY / LOCKED 是同伴持锁;其它错误不能当成「有人占用」。 */
export function isSqliteLockContention(err: unknown): boolean {
  const code = sqliteErrorCode(err);
  if (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    code === 'SQLITE_BUSY_SNAPSHOT' ||
    code === 'SQLITE_BUSY_RECOVERY' ||
    code === 'SQLITE_BUSY_TIMEOUT' ||
    code === '5' ||
    code === '6'
  ) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

export interface OwnershipLock {
  /** 非阻塞:拿到返回 true,已被他人持有返回 false */
  tryAcquire(): boolean;
  /** 幂等释放;未持有时是 no-op */
  release(): void;
  isHeld(): boolean;
}

export interface OwnershipArbiterOptions {
  /**
   * 取当前账号对应的锁。登录初期 / 登出关库返回 null,该轮跳过,
   * 靠 retryMs 自愈。换账号时应返回另一把锁(旧锁由调用方先 release)。
   */
  getLock: () => OwnershipLock | null;
  onAcquire: () => void;
  onDemote: () => void;
  onStandbyChanged?: (standby: boolean) => void;
  retryMs?: number;
}

/**
 * 单持有者仲裁器。生命周期由宿主驱动:
 *  - start():登录后调用,开始参与仲裁(幂等)。
 *  - stop():登出 / 退出时调用,若持有则释放并回调 onDemote。
 * 只有被动实例需要定时重试;持有者只在锁丢失或账号切换时降级。
 */
export class DeviceLinkOwnershipArbiter {
  private readonly retryMs: number;
  private readonly opts: OwnershipArbiterOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private owner = false;
  private stopped = false;
  private standby = false;

  constructor(options: OwnershipArbiterOptions) {
    this.opts = options;
    this.retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  }

  isOwner(): boolean {
    return this.owner;
  }

  isStandby(): boolean {
    return this.standby;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.tick();
    }, this.retryMs);
    this.timer.unref?.();
    this.tick();
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.setStandby(false);
    const lock = this.safeGetLock();
    lock?.release();
    if (this.owner) this.demote('stopped');
    return Promise.resolve();
  }

  /** 单轮仲裁。异常一律吞掉留给下一轮。 */
  tick(): void {
    if (this.stopped) return;
    const lock = this.safeGetLock();
    if (!lock) {
      if (this.owner) this.demote('lock-unavailable');
      return;
    }
    if (this.owner) {
      if (!lock.isHeld()) this.demote('lock-lost');
      return;
    }
    let acquired = false;
    try {
      acquired = lock.tryAcquire();
    } catch (err) {
      log.warn('ownership lock acquire failed (will retry)', err);
      return;
    }
    if (acquired) {
      this.promote();
      return;
    }
    this.setStandby(true);
  }

  private safeGetLock(): OwnershipLock | null {
    try {
      return this.opts.getLock();
    } catch {
      return null;
    }
  }

  private promote(): void {
    this.owner = true;
    this.setStandby(false);
    log.info('became device-link owner (file-lock)');
    try {
      this.opts.onAcquire();
    } catch (err) {
      log.error('onAcquire callback failed', err);
    }
  }

  private demote(reason: string): void {
    this.owner = false;
    this.setStandby(reason !== 'stopped' && reason !== 'lock-unavailable');
    log.info(`no longer device-link owner (${reason})`);
    try {
      this.opts.onDemote();
    } catch (err) {
      log.error('onDemote callback failed', err);
    }
  }

  private setStandby(next: boolean): void {
    if (this.standby === next) return;
    this.standby = next;
    try {
      this.opts.onStandbyChanged?.(next);
    } catch (err) {
      log.error('onStandbyChanged callback failed', err);
    }
  }
}

/**
 * 用独立小库持有 SQLite EXCLUSIVE 锁。聊天库完全不参与。
 * busy_timeout=0:抢不到立刻失败,由仲裁器下一拍再试。
 */
export function createSqliteExclusiveFileLock(
  lockPath: string,
  openDatabase?: (lockPath: string) => Database.Database,
): OwnershipLock {
  const open =
    openDatabase ??
    ((file) =>
      createBetterSqliteDatabase(file, {
        timeout: 0,
      }));
  let db: Database.Database | null = null;

  const closeQuietly = (handle: Database.Database): void => {
    try {
      handle.exec('ROLLBACK');
    } catch {
      // 没有事务
    }
    try {
      handle.close();
    } catch {
      // 已关
    }
  };

  return {
    tryAcquire() {
      if (db) return true;
      let handle: Database.Database | null = null;
      try {
        handle = open(lockPath);
        handle.pragma('journal_mode = DELETE');
        handle.pragma('busy_timeout = 0');
        handle.exec('BEGIN EXCLUSIVE');
        handle.exec('CREATE TABLE IF NOT EXISTS ownership_lock (id INTEGER PRIMARY KEY NOT NULL)');
        db = handle;
        return true;
      } catch (err) {
        if (handle) closeQuietly(handle);
        if (isSqliteLockContention(err)) return false;
        log.warn('ownership lock initialize failed', err);
        throw err;
      }
    },
    release() {
      if (!db) return;
      closeQuietly(db);
      db = null;
    },
    isHeld() {
      return db !== null;
    },
  };
}
