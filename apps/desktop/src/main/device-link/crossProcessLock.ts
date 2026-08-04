/**
 * crossProcessLock —— 同一台机器上多个 Cindy 实例之间的建议性文件锁。
 * ---------------------------------------------------------------------------
 * 为什么需要:dev 实例与打包实例可以共用同一个 userData(见 devStartupStatus.ts),于是
 * 「读 → 改 → 整份写回」「先扫描再删除」这类临界区在两个进程之间会互相覆盖 —— 后落位的
 * 那次赢,而另一边以为自己成功了(review: codex P1,镜像缓存的队列与清理都撞过)。
 *
 * 用 `open(lock, 'wx')` 做锁:同目录、O_EXCL 语义在 Windows / macOS / Linux 都可靠。
 *
 * 陈旧锁的接管**不能只看时间**:临界区可能包含递归删除,正常持锁跑过 10 秒完全可能。
 * 只按 mtime 抢锁会把活着的持有者挤掉,它随后还会在 finally 里删掉别人的锁。所以:
 *  - 锁内容写 `{ pid, startedAt }`,持锁期间每 2 秒 touch 一次 mtime(心跳);
 *  - 只有「mtime 陈旧」**且**「owner pid 已经不在」才接管 —— 共享 userData 必然同机,
 *    `process.kill(pid, 0)` 是可靠的存活判定;读不到锁 / 读不出内容一律保守不接管;
 *  - 等不到锁就把 `held=false` 交给调用方**自行降级**(绝不无限等待:登出 / teardown 都会
 *    经过这些临界区,卡住比降级更糟);
 *  - 释放时先确认锁里还是自己的 pid,再删。
 */

import fsp from 'node:fs/promises';

import { createLogger } from '../logger';

const log = createLogger('device-link:cross-process-lock');

/** 超过这个年龄的锁**可能**是崩溃残留(还要再验 owner 存活)。 */
const LOCK_STALE_MS = 10_000;
/** 抢锁最长等待;之后交给调用方降级。 */
const LOCK_WAIT_MS = 3_000;
const LOCK_RETRY_MS = 40;
/** 一次调用里最多接管几次陈旧锁(正常只需 1 次;更多说明有人在高频重建,该降级)。 */
const MAX_TAKEOVERS = 3;
/** 持锁期间刷新 mtime 的间隔:让「陈旧」只对真正死掉的持有者成立。 */
const LOCK_HEARTBEAT_MS = 2_000;

/**
 * 没拿到锁时**为什么**没拿到:
 *  - `busy`:锁一直被别人持着(EEXIST 直到超时)→ 另一个进程正在临界区里,调用方应当避让;
 *  - `unavailable`:锁根本建不出来(EMFILE / EACCES / 只读目录…)→ 无从判断有没有别人,
 *    调用方通常应当**照常做事**(best-effort),否则在这些环境里功能会被静默关掉。
 */
export type LockStatus = { held: true } | { held: false; reason: 'busy' | 'unavailable' };

export interface FileLockOptions {
  /** 日志里用来标识这把锁(如 'purge-queue' / 'mirror-cache')。 */
  label: string;
  /** 抢不到锁时最长等待毫秒数,默认 3 秒。 */
  waitMs?: number;
}

/**
 * 拿着 `lockPath` 这把跨进程锁执行 `task`。`held=false` 表示没拿到(调用方自行降级)。
 * 无论是否拿到都会执行 task —— 由调用方决定"降级怎么做"。
 */
export async function withCrossProcessLock<T>(
  lockPath: string,
  opts: FileLockOptions,
  task: (status: LockStatus) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  let held = false;
  let reason: 'busy' | 'unavailable' = 'unavailable';
  // 接管次数上限:正常最多一次(删掉陈旧锁 → 下一轮建成功)。反复"删得掉却又立刻 EEXIST"
  // 说明有人在高频重建锁,那时该降级而不是继续跟它抢。
  let takeovers = 0;
  for (;;) {
    try {
      const handle = await fsp.open(lockPath, 'wx');
      await handle
        .writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8')
        .catch(() => undefined);
      await handle.close().catch(() => undefined);
      held = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        // 锁**建不出来**(EMFILE / EACCES / 目录不存在…):无从判断有没有别人在临界区。
        reason = 'unavailable';
        break;
      }
      if (takeovers < MAX_TAKEOVERS && (await canTakeOverLock(lockPath))) {
        log.warn(`taking over stale ${opts.label} lock from a dead owner`);
        takeovers += 1;
        const removed = await fsp
          .rm(lockPath, { force: true })
          .then(() => true)
          .catch(() => false);
        if (removed) continue;
        // 删不掉(Windows 上 EPERM / EBUSY 最常见:别的进程还开着句柄)。原先是 catch 掉再
        // `continue`,而"陈旧 + owner 已死"的判定下一轮仍然成立 —— 于是这里会变成没有退避、
        // 没有截止时间的空转,把调用方永久卡住(review: copilot)。删不掉就当"有人在临界区"
        // 降级退出:内容写会跳过(安全方向),清理路径照常执行。
        log.warn(`${opts.label} stale lock is undeletable; proceeding in degraded mode`);
        reason = 'busy';
        break;
      }
      if (Date.now() >= deadline) {
        log.warn(`${opts.label} lock busy; proceeding in degraded mode`);
        reason = 'busy';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
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
    if (held) await releaseOwnLock(lockPath, opts.label);
  }
}

/** 只有「心跳早已停」且「owner 进程确实不在了」才允许接管。 */
async function canTakeOverLock(lock: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(lock);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // 只有"锁文件真的没了"才算可以重新抢;EACCES / EPERM 这类读不到锁的情况必须保守。
    if (code === 'ENOENT' || code === 'ENOTDIR') return true;
    return false;
  }
  if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;
  const owner = await readLockOwnerPid(lock);
  if (owner === 'unreadable') return false; // 读不出来 ≠ 持有者已死
  if (owner === null) return true; // 能读但不是本模块写的(陈旧残留)
  if (owner === process.pid) return true; // 本进程上一轮崩在临界区里(心跳早停)
  try {
    process.kill(owner, 0);
    return false; // owner 还活着
  } catch (err) {
    // ESRCH = 进程不在了;EPERM = 进程在但不属于当前用户(保守认为活着)
    return (err as NodeJS.ErrnoException)?.code !== 'EPERM';
  }
}

/**
 * 锁文件里的 owner pid。三态:number = 正常;null = 能读但不是本模块写的;
 * 'unreadable' = 读不出来(不能据此判定持有者已死)。
 */
async function readLockOwnerPid(lock: string): Promise<number | null | 'unreadable'> {
  let raw: string;
  try {
    raw = await fsp.readFile(lock, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return 'unreadable';
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const pid = (parsed as { pid?: unknown }).pid;
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {
    // 能读但不是合法 JSON:按陈旧残留处理。
  }
  return null;
}

/** 释放前确认锁里还是自己的 pid:别人接管过之后不能替他删。 */
async function releaseOwnLock(lock: string, label: string): Promise<void> {
  const owner = await readLockOwnerPid(lock);
  if (owner === 'unreadable') return; // 读不出来就别乱删别人的锁
  if (owner !== null && owner !== process.pid) {
    log.warn(`${label} lock was taken over; leaving it to its new owner`);
    return;
  }
  await fsp.rm(lock, { force: true }).catch(() => undefined);
}

export const __testing = { staleMs: LOCK_STALE_MS, heartbeatMs: LOCK_HEARTBEAT_MS };
