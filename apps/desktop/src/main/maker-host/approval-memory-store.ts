/**
 * Auto-review 批准记忆的 Desktop 持久化。
 *
 * 文件只保存工作区域和操作的 SHA-256 摘要，不保存命令、cwd、项目路径或 URL 明文。
 * 摘要用于固定长度匹配，不作为秘密；文件本身以 owner-only 权限写入。
 * maker-core 负责动作安全边界；这里负责有界存储、跨进程串行和原子替换。
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
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
  version: 2;
  workspaces: Record<string, Record<string, ApprovalRecord>>;
}

interface PendingAdd {
  /** 入队时所属 data owner 的文件；切号后不得重新解析到新 owner。 */
  target: string;
  workspaceHash: string;
  signature: string;
  origin: ApprovalMemoryOrigin;
  ts: number;
}

interface StoreLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ApprovalMemoryFileStore {
  store: ApprovalMemoryStore;
  flush(): Promise<void>;
  list(workspaceKey?: string): Promise<ApprovalListEntry[]>;
  clear(workspaceKey?: string): Promise<number>;
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
  return { version: 2, workspaces: {} };
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
  const state: ApprovalFile = { version: 2, workspaces };
  evict(state);
  return state;
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
  let flushTimer: NodeJS.Timeout | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.then(() => undefined, () => undefined);
    return result;
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
            for (const addition of additions) {
              const bucket = state.workspaces[addition.workspaceHash]
                ?? (state.workspaces[addition.workspaceHash] = {});
              const existing = bucket[addition.signature];
              bucket[addition.signature] = {
                origin: existing?.origin === 'user' ? 'user' : addition.origin,
                ts: addition.ts,
              };
            }
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
      pendingAdds.push({
        target: resolveFilePath(),
        workspaceHash: workspaceHash(workspaceKey),
        signature,
        origin,
        ts: now(),
      });
      scheduleFlush();
    },
  };

  return {
    store,
    flush,
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
      await flush();
      return enqueue(async () => {
        // flush 是 best-effort：若它刚因锁/I/O 失败把 batch 放回 pending，clear 必须在自己的
        // 串行点一并撤销目标批次，否则退出或下次 flush 会把用户刚清掉的批准重新写回来。
        for (let index = pendingAdds.length - 1; index >= 0; index--) {
          const addition = pendingAdds[index]!;
          if (
            addition.target === target
            && (!selectedWorkspace || addition.workspaceHash === selectedWorkspace)
          ) {
            pendingAdds.splice(index, 1);
          }
        }
        return withFileLock(target, async () => {
          const state = readFileStateUnlocked(target, logger);
          let removed = 0;
          if (selectedWorkspace) {
            removed = Object.keys(state.workspaces[selectedWorkspace] ?? {}).length;
            delete state.workspaces[selectedWorkspace];
          } else {
            for (const bucket of Object.values(state.workspaces)) {
              removed += Object.keys(bucket).length;
            }
            state.workspaces = {};
          }
          writeFileState(target, state);
          return removed;
        });
      });
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
