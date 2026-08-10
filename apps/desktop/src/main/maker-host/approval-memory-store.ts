/**
 * Auto-review 批准记忆的 Desktop 持久化。
 *
 * 文件只保存工作区域和操作的 SHA-256 摘要，不保存命令、cwd、项目路径或 URL 明文。
 * 摘要用于固定长度匹配，不作为秘密；文件本身以 owner-only 权限写入。
 * maker-core 负责动作安全边界；这里负责有界存储、跨进程串行和原子替换。
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

import type {
  ApprovalMemoryOrigin,
  ApprovalMemoryStore,
} from '@cindy/maker-core';

import { ownerScopedUserDataPath } from '../appSessionState.js';
import {
  atomicWriteFileSync,
  readAtomicFileSync,
} from '../utils/atomicWriteFile.js';
import { desktopMakerLogger } from './logger-adapter.js';

const log = desktopMakerLogger.child('approval-memory-store');
const MAX_SIGNATURES_PER_WORKSPACE = 500;
const MAX_WORKSPACES = 50;
const FLUSH_DELAY_MS = 1_000;
const LOCK_RETRY_MS = 20;
const LOCK_RETRY_LIMIT = 50;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

interface ApprovalRecord {
  origin: ApprovalMemoryOrigin;
  ts: number;
}

interface ApprovalFile {
  version: 3;
  /** 全量 clear 的代次；变化会使所有 workspace 的活动缓存失效。 */
  clearGeneration: number;
  /** 指定 workspace clear 的代次；key 只保存 workspace 摘要。 */
  workspaceClearGenerations: Record<string, number>;
  workspaces: Record<string, Record<string, ApprovalRecord>>;
}

interface PendingAdd {
  /** 入队时所属 data owner 的文件；切号后不得重新解析到新 owner。 */
  target: string;
  workspaceHash: string;
  signature: string;
  origin: ApprovalMemoryOrigin;
  ts: number;
  /** add 入队时看到的清除代次；flush 持锁后再次比对，防止旧批次复活。 */
  clearToken: string;
}

interface ClearBarrier {
  id: number;
  target: string;
  workspaceHash: string | null;
  blocked: PendingAdd[];
}

interface StoreLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ApprovalMemoryFileStore {
  store: ApprovalMemoryStore;
  flush(): Promise<void>;
  list(workspaceKey?: string): Promise<ApprovalListEntry[]>;
  clear(workspaceKey?: string): Promise<number>;
  getClearGeneration(workspaceKey: string): string;
}

export interface ApprovalListEntry {
  /** 不含路径明文的工作区域摘要。 */
  workspaceHash: string;
  signature: string;
  origin: ApprovalMemoryOrigin;
  ts: number;
}

function workspaceHash(workspaceKey: string): string {
  return `sha256:${createHash('sha256').update(workspaceKey).digest('hex')}`;
}

function emptyFile(): ApprovalFile {
  return {
    version: 3,
    clearGeneration: 0,
    workspaceClearGenerations: {},
    workspaces: {},
  };
}

function finiteGeneration(value: unknown): number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : 0;
}

function generationMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (HASH_PATTERN.test(key)) result[key] = finiteGeneration(value);
  }
  return result;
}

function normalize(raw: unknown): ApprovalFile {
  if (!raw || typeof raw !== 'object') return emptyFile();
  const source = raw as Record<string, unknown>;
  const workspaces: ApprovalFile['workspaces'] = {};
  if (!source.workspaces || typeof source.workspaces !== 'object') return emptyFile();

  for (const [workspace, bucket] of Object.entries(
    source.workspaces as Record<string, unknown>,
  )) {
    if (!HASH_PATTERN.test(workspace) || !bucket || typeof bucket !== 'object') continue;
    const entries: Record<string, ApprovalRecord> = {};
    for (const [signature, record] of Object.entries(bucket as Record<string, unknown>)) {
      if (!HASH_PATTERN.test(signature)) continue;
      const value = record && typeof record === 'object'
        ? record as Record<string, unknown>
        : {};
      entries[signature] = {
        origin: value.origin === 'user' ? 'user' : 'reviewer',
        ts: typeof value.ts === 'number' && Number.isFinite(value.ts) ? value.ts : 0,
      };
    }
    if (Object.keys(entries).length > 0) workspaces[workspace] = entries;
  }
  const state: ApprovalFile = {
    version: 3,
    clearGeneration: finiteGeneration(source.clearGeneration),
    workspaceClearGenerations: generationMap(source.workspaceClearGenerations),
    workspaces,
  };
  evict(state);
  return state;
}

function clearToken(state: ApprovalFile, workspaceHashValue: string): string {
  return `${state.clearGeneration}:${state.workspaceClearGenerations[workspaceHashValue] ?? 0}`;
}

/**
 * 轻量、无恢复副作用的代次读取，供同步的记忆命中路径和 add 入队使用。
 * 主文件正处于 atomicWriteFileSync 的备份交换窗口时返回哨兵；flush 会在持锁后重新
 * 读取完整状态，哨兵批次不会被写回，因而不会把旧批准复活。
 */
function readClearTokenSync(target: string, workspaceHashValue: string): string {
  try {
    const raw = readFileSync(target, 'utf8');
    if (!raw) return clearToken(emptyFile(), workspaceHashValue);
    return clearToken(normalize(JSON.parse(raw)), workspaceHashValue);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // 区分“首次还没有批准文件”和 atomicWriteFileSync 的备份交换窗口：对活动记忆
      // 两者都应先失效；flush 在持锁后会把首次写入的 `missing` 批次特判为可接受。
      return 'missing';
    }
    return 'unavailable';
  }
}

function evict(state: ApprovalFile): void {
  for (const [workspace, bucket] of Object.entries(state.workspaces)) {
    const newest = Object.entries(bucket)
      .sort(([, a], [, b]) => b.ts - a.ts)
      .slice(0, MAX_SIGNATURES_PER_WORKSPACE);
    state.workspaces[workspace] = Object.fromEntries(newest);
  }

  const newestWorkspaces = Object.entries(state.workspaces)
    .sort(([, a], [, b]) => {
      const newest = (bucket: Record<string, ApprovalRecord>): number =>
        Object.values(bucket).reduce((max, record) => Math.max(max, record.ts), 0);
      return newest(b) - newest(a);
    })
    .slice(0, MAX_WORKSPACES);
  state.workspaces = Object.fromEntries(newestWorkspaces);
}

/**
 * 仅允许在 `withFileLock` 临界区内调用。
 * `readAtomicFileSync` 会在主文件缺失时恢复 `.bak`，所以它不是无副作用的普通读取。
 */
function readFileStateUnlocked(target: string, logger: StoreLogger): ApprovalFile {
  let raw: string | null;
  try {
    raw = readAtomicFileSync(target);
  } catch (error) {
    // I/O / backup 恢复失败不能降级成空状态：flush 会保留 batch，下次再试。
    logger.warn('approval memory file unreadable; refusing to replace it', {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  if (raw === null) return emptyFile();
  try {
    return normalize(JSON.parse(raw));
  } catch (error) {
    // 内容已损坏时按空状态恢复；权限面只会收紧，不会从坏文件加载任何批准。
    logger.warn('approval memory file contains invalid JSON; starting empty', {
      message: error instanceof Error ? error.message : String(error),
    });
    return emptyFile();
  }
}

const wait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

interface FileLockOwner {
  pid: number;
  ownerId: string;
}

function parseLockOwner(raw: string): FileLockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<FileLockOwner>;
    return Number.isInteger(value.pid) && (value.pid ?? 0) > 0 && typeof value.ownerId === 'string'
      ? { pid: value.pid!, ownerId: value.ownerId }
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 代表进程存在但当前进程无权 signal；只有 ESRCH 才能确认 owner 已死亡。
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

async function releaseOwnedLock(lockPath: string, owner: FileLockOwner): Promise<void> {
  try {
    const current = parseLockOwner(await fs.readFile(lockPath, 'utf8'));
    if (current?.pid === owner.pid && current.ownerId === owner.ownerId) {
      await fs.unlink(lockPath);
    }
  } catch {
    // 锁清理是 best-effort；下次会确认 owner 进程是否仍存活。
  }
}

/**
 * 把带完整 owner 的候选文件用 hard link 原子发布为公共锁。
 *
 * 直接 `open(lockPath, 'wx')` 会先暴露一个空文件、再异步写 owner；进程若在两步之间挂起，
 * 其它实例无法区分「仍持锁」和「已经崩溃」，按年龄删除就会穿透 live owner。候选文件在
 * 私有名字下写完后再 link，公共 lockPath 要么不存在，要么从第一次可见起就可解析。
 */
async function tryAcquireFileLock(lockPath: string, owner: FileLockOwner): Promise<boolean> {
  const candidatePath = `${lockPath}.${owner.pid}.${owner.ownerId}.candidate`;
  try {
    await fs.writeFile(candidatePath, JSON.stringify(owner), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await fs.link(candidatePath, lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await fs.unlink(candidatePath).catch(() => undefined);
  }
}

async function withFileLock<T>(target: string, task: () => Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
    const owner: FileLockOwner = { pid: process.pid, ownerId: randomUUID() };
    if (!await tryAcquireFileLock(lockPath, owner)) {
      try {
        const observed = await fs.readFile(lockPath, 'utf8');
        const activeOwner = parseLockOwner(observed);
        if (activeOwner && !processIsAlive(activeOwner.pid)) {
          // 内容二次比对后再删，避免回收检查期间锁已换主。
          if (await fs.readFile(lockPath, 'utf8') === observed) {
            await fs.unlink(lockPath);
          }
          continue;
        }
        // 旧版本可能留下无法解析 owner 的锁。它也可能来自仍存活但被挂起的进程，无法安全
        // 回收；保持 fail-closed，等锁消失或本次操作超时，不以 mtime 猜测 owner 生死。
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      }
      await wait(LOCK_RETRY_MS);
      continue;
    }

    try {
      return await task();
    } finally {
      await releaseOwnedLock(lockPath, owner);
    }
  }
  throw new Error('approval memory lock timed out');
}

function writeFileState(target: string, state: ApprovalFile): void {
  // 公共实现覆盖 Windows rename 不能直接替换已有目标的 EPERM/EEXIST，
  // 并用 .bak 交换保证第二步失败时旧文件仍可恢复。
  atomicWriteFileSync(target, JSON.stringify(state));
}

/** 创建可注入文件路径的 store；生产单例与测试共用这一实现。 */
export function createApprovalMemoryFileStore(
  resolveFilePath: () => string,
  options: {
    logger?: StoreLogger;
    flushDelayMs?: number;
    now?: () => number;
  } = {},
): ApprovalMemoryFileStore {
  const logger = options.logger ?? log;
  const flushDelayMs = options.flushDelayMs ?? FLUSH_DELAY_MS;
  const now = options.now ?? Date.now;
  const pendingAdds: PendingAdd[] = [];
  const clearListeners = new Set<(workspaceKey?: string) => void>();
  const activeClears = new Map<number, ClearBarrier>();
  let flushTimer: NodeJS.Timeout | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let nextClearId = 0;

  const notifyClear = (workspaceKey?: string): void => {
    for (const listener of clearListeners) {
      try {
        listener(workspaceKey);
      } catch (error) {
        // A stale/closed harness must not make a successful disk revocation look like a failed
        // clear operation. The listener is best-effort; the file is already durably updated.
        logger.warn('approval memory clear listener failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const matchesBarrier = (addition: PendingAdd, barrier: ClearBarrier): boolean =>
    addition.target === barrier.target
    && (barrier.workspaceHash === null || addition.workspaceHash === barrier.workspaceHash);

  const takePendingForBarrier = (barrier: ClearBarrier): void => {
    for (let index = pendingAdds.length - 1; index >= 0; index--) {
      const addition = pendingAdds[index]!;
      if (!matchesBarrier(addition, barrier)) continue;
      barrier.blocked.push(addition);
      pendingAdds.splice(index, 1);
    }
  };

  const flush = async (): Promise<void> => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await enqueue(async () => {
      if (pendingAdds.length === 0) return;
      const batch = pendingAdds.splice(0, pendingAdds.length);
      const additionsByTarget = new Map<string, PendingAdd[]>();
      for (const addition of batch) {
        const additions = additionsByTarget.get(addition.target) ?? [];
        additions.push(addition);
        additionsByTarget.set(addition.target, additions);
      }
      for (const [target, additions] of additionsByTarget) {
        try {
          await withFileLock(target, async () => {
            const state = readFileStateUnlocked(target, logger);
            let accepted = 0;
            for (const addition of additions) {
              // A clear in another Desktop process may have committed while this batch was
              // waiting for the lock. Compare the enqueue snapshot with the live state under
              // that same lock; stale additions are deliberately dropped, never replayed.
              const liveToken = clearToken(state, addition.workspaceHash);
              if (
                addition.clearToken !== liveToken
                && !(addition.clearToken === 'missing' && liveToken === '0:0')
              ) continue;
              const bucket = state.workspaces[addition.workspaceHash]
                ?? (state.workspaces[addition.workspaceHash] = {});
              const existing = bucket[addition.signature];
              bucket[addition.signature] = {
                origin: existing?.origin === 'user' ? 'user' : addition.origin,
                ts: addition.ts,
              };
              accepted += 1;
            }
            if (accepted === 0) return;
            evict(state);
            writeFileState(target, state);
          });
        } catch (error) {
          // 写失败不改变权限判定；只保留失败 owner 的批次，其他 owner 已落盘的批次不重放。
          pendingAdds.unshift(...additions);
          logger.warn('approval memory flush failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, flushDelayMs);
    flushTimer.unref?.();
  };

  const store: ApprovalMemoryStore = {
    async load(workspaceKey: string): Promise<ReadonlySet<string>> {
      const target = resolveFilePath();
      await flush();
      return enqueue(() => withFileLock(target, async () => {
        const state = readFileStateUnlocked(target, logger);
        return new Set(Object.keys(state.workspaces[workspaceHash(workspaceKey)] ?? {}));
      }));
    },
    add(workspaceKey, signature, origin): void {
      if (!workspaceKey || !HASH_PATTERN.test(signature)) return;
      const target = resolveFilePath();
      const workspaceHashValue = workspaceHash(workspaceKey);
      pendingAdds.push({
        target,
        workspaceHash: workspaceHashValue,
        signature,
        origin,
        ts: now(),
        clearToken: readClearTokenSync(target, workspaceHashValue),
      });
      // A matching clear owns the pending batch until its lock/write boundary completes. Avoid
      // starting a competing timer in that window; a failed clear re-schedules in its finally.
      const heldByClear = [...activeClears.values()].some((barrier) =>
        target === barrier.target
        && (barrier.workspaceHash === null || barrier.workspaceHash === workspaceHashValue));
      if (!heldByClear) scheduleFlush();
    },
    getClearGeneration(workspaceKey): string {
      return readClearTokenSync(resolveFilePath(), workspaceHash(workspaceKey));
    },
    subscribeClear(listener): (() => void) {
      clearListeners.add(listener);
      return () => clearListeners.delete(listener);
    },
  };

  return {
    store,
    flush,
    getClearGeneration(workspaceKey: string): string {
      return store.getClearGeneration!(workspaceKey);
    },
    async list(workspaceKey?: string): Promise<ApprovalListEntry[]> {
      const target = resolveFilePath();
      await flush();
      return enqueue(() => withFileLock(target, async () => {
        const state = readFileStateUnlocked(target, logger);
        const selectedWorkspace = workspaceKey ? workspaceHash(workspaceKey) : null;
        const entries: ApprovalListEntry[] = [];
        for (const [workspace, bucket] of Object.entries(state.workspaces)) {
          if (selectedWorkspace && workspace !== selectedWorkspace) continue;
          for (const [signature, record] of Object.entries(bucket)) {
            entries.push({ workspaceHash: workspace, signature, ...record });
          }
        }
        return entries.sort((a, b) => b.ts - a.ts);
      }));
    },
    async clear(workspaceKey?: string): Promise<number> {
      const target = resolveFilePath();
      const selectedWorkspace = workspaceKey ? workspaceHash(workspaceKey) : null;
      const barrier: ClearBarrier = {
        id: ++nextClearId,
        target,
        workspaceHash: selectedWorkspace,
        blocked: [],
      };
      activeClears.set(barrier.id, barrier);
      let completed = false;
      try {
        // Keep the barrier active while the pre-clear flush waits for a writer. Any add arriving
        // in this window is held out of the queue and removed again at the lock boundary below.
        await flush();
        const removed = await enqueue(async () => {
          // First pass catches batches returned by a failed pre-clear flush.
          takePendingForBarrier(barrier);
          return withFileLock(target, async () => {
            // Second pass is the atomic revocation point requested by the review: add() may have
            // run while withFileLock was waiting, so it must be removed while the target is held.
            takePendingForBarrier(barrier);
            const state = readFileStateUnlocked(target, logger);
            let count = 0;
            if (selectedWorkspace) {
              count = Object.keys(state.workspaces[selectedWorkspace] ?? {}).length;
              delete state.workspaces[selectedWorkspace];
              state.workspaceClearGenerations[selectedWorkspace] =
                (state.workspaceClearGenerations[selectedWorkspace] ?? 0) + 1;
            } else {
              for (const bucket of Object.values(state.workspaces)) {
                count += Object.keys(bucket).length;
              }
              state.workspaces = {};
              state.clearGeneration += 1;
              state.workspaceClearGenerations = {};
            }
            // Keep the barrier active through the write. This catches an add that arrives after
            // the second pass but before the lock is released; it is restored only if writing
            // fails, never allowed to resurrect a successfully cleared approval.
            takePendingForBarrier(barrier);
            writeFileState(target, state);
            takePendingForBarrier(barrier);
            // Notify only after the replacement succeeds. The persisted generation is the
            // cross-process signal; this listener remains the low-latency same-process path.
            notifyClear(workspaceKey);
            completed = true;
            return count;
          });
        });
        return removed;
      } finally {
        if (completed) {
          // releaseOwnedLock() itself awaits filesystem cleanup. An add can arrive in that tiny
          // post-write window while the barrier is still registered; it is newer than the clear
          // boundary and must be retained, then scheduled normally after the barrier is removed.
          const blockedBeforeLateAdds = barrier.blocked.length;
          takePendingForBarrier(barrier);
          const lateAdds = barrier.blocked.splice(blockedBeforeLateAdds);
          if (lateAdds.length > 0) {
            pendingAdds.unshift(...lateAdds);
          }
        }
        activeClears.delete(barrier.id);
        if (!completed && barrier.blocked.length > 0) {
          // A failed clear must retain the old best-effort persistence semantics. Requeue the
          // temporarily held additions instead of silently losing a legitimate approval.
          pendingAdds.unshift(...barrier.blocked);
        }
        // Adds can arrive while a failed clear is still waiting for the lock, after the final
        // takePendingForBarrier() pass. Once the barrier is removed they must be scheduled too.
        if (pendingAdds.length > 0) {
          scheduleFlush();
        }
      }
    },
  };
}

const singleton = createApprovalMemoryFileStore(
  () => ownerScopedUserDataPath('auto-review-approvals.json'),
);

export const approvalMemoryStore = singleton.store;
export const flushApprovalMemoryStore = singleton.flush;
export const listApprovals = singleton.list;
export const clearApprovals = singleton.clear;
