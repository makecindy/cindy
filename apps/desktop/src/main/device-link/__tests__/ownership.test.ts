/**
 * device-link 单持有者仲裁测试:
 *  - DeviceLinkOwnershipArbiter 状态机(注入内存锁)
 *  - createSqliteExclusiveFileLock 的跨连接互斥(真 better-sqlite3 文件)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  DeviceLinkOwnershipArbiter,
  createSqliteExclusiveFileLock,
  isSqliteLockContention,
  type OwnershipLock,
} from '../ownership';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function memoryLock(): OwnershipLock {
  let held = false;
  return {
    tryAcquire() {
      if (held) return false;
      held = true;
      return true;
    },
    release() {
      held = false;
    },
    isHeld() {
      return held;
    },
  };
}

function makeArbiter(opts: { lock: OwnershipLock | null; retryMs?: number }) {
  const onAcquire = vi.fn();
  const onDemote = vi.fn();
  const onStandbyChanged = vi.fn();
  const arbiter = new DeviceLinkOwnershipArbiter({
    getLock: () => opts.lock,
    onAcquire,
    onDemote,
    onStandbyChanged,
    retryMs: opts.retryMs ?? 500,
  });
  return { arbiter, onAcquire, onDemote, onStandbyChanged };
}

describe('DeviceLinkOwnershipArbiter', () => {
  it('空锁 → 认领成功并回调 onAcquire', () => {
    const lock = memoryLock();
    const { arbiter, onAcquire } = makeArbiter({ lock });
    arbiter.tick();
    expect(arbiter.isOwner()).toBe(true);
    expect(onAcquire).toHaveBeenCalledTimes(1);
    expect(lock.isHeld()).toBe(true);
  });

  it('锁已被他人持有 → 保持被动不抢', () => {
    const lock = memoryLock();
    expect(lock.tryAcquire()).toBe(true);
    const { arbiter, onAcquire } = makeArbiter({ lock });
    arbiter.tick();
    expect(arbiter.isOwner()).toBe(false);
    expect(arbiter.isStandby()).toBe(true);
    expect(onAcquire).not.toHaveBeenCalled();
  });

  it('他人释放后下一轮立刻接管', () => {
    const lock = memoryLock();
    expect(lock.tryAcquire()).toBe(true);
    const { arbiter, onAcquire } = makeArbiter({ lock });
    arbiter.tick();
    expect(arbiter.isOwner()).toBe(false);
    lock.release();
    arbiter.tick();
    expect(arbiter.isOwner()).toBe(true);
    expect(onAcquire).toHaveBeenCalledTimes(1);
  });

  it('持有者不再续期;锁仍在则不重复回调', () => {
    const lock = memoryLock();
    const { arbiter, onAcquire } = makeArbiter({ lock });
    arbiter.tick();
    arbiter.tick();
    arbiter.tick();
    expect(onAcquire).toHaveBeenCalledTimes(1);
    expect(arbiter.isOwner()).toBe(true);
  });

  it('锁丢失 → onDemote 且不抢回(直到锁再次可拿)', () => {
    const lock = memoryLock();
    const { arbiter, onDemote } = makeArbiter({ lock });
    arbiter.tick();
    lock.release();
    arbiter.tick();
    expect(arbiter.isOwner()).toBe(false);
    expect(onDemote).toHaveBeenCalledTimes(1);
  });

  it('stop() → 释放锁 + onDemote;幸存实例可立即接管', () => {
    const lock = memoryLock();
    const a = makeArbiter({ lock });
    a.arbiter.tick();
    void a.arbiter.stop();
    expect(a.onDemote).toHaveBeenCalledTimes(1);
    expect(lock.isHeld()).toBe(false);

    const b = makeArbiter({ lock });
    b.arbiter.tick();
    expect(b.arbiter.isOwner()).toBe(true);
  });

  it('getLock 未就绪(null / 抛错)→ 跳过不崩;就绪后下一轮认领', () => {
    let lock: OwnershipLock | null = null;
    const onAcquire = vi.fn();
    const arbiter = new DeviceLinkOwnershipArbiter({
      getLock: () => {
        if (!lock) throw new Error('userData not ready');
        return lock;
      },
      onAcquire,
      onDemote: vi.fn(),
    });
    arbiter.tick();
    expect(onAcquire).not.toHaveBeenCalled();
    lock = memoryLock();
    arbiter.tick();
    expect(onAcquire).toHaveBeenCalledTimes(1);
  });

  it('持有者期间 getLock 变 null → 自我降级停 client', () => {
    let lock: OwnershipLock | null = memoryLock();
    const onDemote = vi.fn();
    const arbiter = new DeviceLinkOwnershipArbiter({
      getLock: () => lock,
      onAcquire: vi.fn(),
      onDemote,
    });
    arbiter.tick();
    expect(arbiter.isOwner()).toBe(true);
    lock = null;
    arbiter.tick();
    expect(arbiter.isOwner()).toBe(false);
    expect(onDemote).toHaveBeenCalledTimes(1);
  });

  it('store 未就绪时亚秒级快速重试,就绪后立即认领', async () => {
    vi.useFakeTimers();
    try {
      let lock: OwnershipLock | null = null;
      const onAcquire = vi.fn();
      const arbiter = new DeviceLinkOwnershipArbiter({
        getLock: () => lock,
        onAcquire,
        onDemote: vi.fn(),
        retryMs: 500,
      });
      arbiter.start();
      expect(onAcquire).not.toHaveBeenCalled();
      lock = memoryLock();
      await vi.advanceTimersByTimeAsync(500);
      expect(onAcquire).toHaveBeenCalledTimes(1);
      void arbiter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('锁初始化失败(非竞争)→ 不假装他人持有,下一轮再试', () => {
    const lock: OwnershipLock = {
      tryAcquire() {
        throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
      },
      release() {},
      isHeld() {
        return false;
      },
    };
    const { arbiter, onAcquire, onStandbyChanged } = makeArbiter({ lock });
    arbiter.tick();
    expect(arbiter.isOwner()).toBe(false);
    expect(arbiter.isStandby()).toBe(false);
    expect(onAcquire).not.toHaveBeenCalled();
    expect(onStandbyChanged).not.toHaveBeenCalled();
  });

  it('失去持有权、接管和 stop 都会翻转待命状态', () => {
    const lock = memoryLock();
    const { arbiter, onStandbyChanged } = makeArbiter({ lock });
    arbiter.tick();
    expect(arbiter.isStandby()).toBe(false);
    expect(onStandbyChanged).not.toHaveBeenCalled();
    lock.release();
    arbiter.tick();
    expect(arbiter.isStandby()).toBe(true);
    expect(onStandbyChanged).toHaveBeenLastCalledWith(true);
    arbiter.tick();
    expect(arbiter.isOwner()).toBe(true);
    expect(onStandbyChanged).toHaveBeenLastCalledWith(false);
    void arbiter.stop();
    expect(arbiter.isStandby()).toBe(false);
  });
});

describe('createSqliteExclusiveFileLock', () => {
  function openTempLock(): { dir: string; lockPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cindy-ownership-lock-'));
    return { dir, lockPath: join(dir, 'device-link.lock.db') };
  }

  function openLock(lockPath: string) {
    return createSqliteExclusiveFileLock(lockPath, (file) => new Database(file, { timeout: 0 }));
  }

  it('同一文件上至多一把锁;释放后同伴立刻能拿', () => {
    const { dir, lockPath } = openTempLock();
    const a = openLock(lockPath);
    const b = openLock(lockPath);
    try {
      expect(a.tryAcquire()).toBe(true);
      expect(b.tryAcquire()).toBe(false);
      expect(a.tryAcquire()).toBe(true);
      a.release();
      expect(b.tryAcquire()).toBe(true);
      expect(a.tryAcquire()).toBe(false);
    } finally {
      a.release();
      b.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('持有者关连接(模拟崩溃收尾)后同伴可接手', () => {
    const { dir, lockPath } = openTempLock();
    const a = openLock(lockPath);
    const b = openLock(lockPath);
    try {
      expect(a.tryAcquire()).toBe(true);
      a.release();
      expect(b.tryAcquire()).toBe(true);
    } finally {
      a.release();
      b.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SQLITE_BUSY 视为竞争;其它 sqlite 错误向上抛', () => {
    const { dir, lockPath } = openTempLock();
    try {
      const busy = createSqliteExclusiveFileLock(lockPath, () => {
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      });
      expect(busy.tryAcquire()).toBe(false);

      const io = createSqliteExclusiveFileLock(lockPath, () => {
        throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
      });
      expect(() => io.tryAcquire()).toThrow(/disk I\/O error/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isSqliteLockContention 只认忙/锁,不把 IO 错误当占用', () => {
    expect(
      isSqliteLockContention(
        Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
      ),
    ).toBe(true);
    expect(
      isSqliteLockContention(Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' })),
    ).toBe(false);
    expect(isSqliteLockContention(new Error('database is locked'))).toBe(true);
  });

  it('双仲裁器共享同一文件锁:任意时刻至多一个持有者', () => {
    const { dir, lockPath } = openTempLock();
    const lockA = openLock(lockPath);
    const lockB = openLock(lockPath);
    const a = makeArbiter({ lock: lockA });
    const b = makeArbiter({ lock: lockB });
    try {
      a.arbiter.tick();
      b.arbiter.tick();
      expect(a.arbiter.isOwner()).toBe(true);
      expect(b.arbiter.isOwner()).toBe(false);
      void a.arbiter.stop();
      b.arbiter.tick();
      expect(b.arbiter.isOwner()).toBe(true);
    } finally {
      void a.arbiter.stop();
      void b.arbiter.stop();
      lockA.release();
      lockB.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
