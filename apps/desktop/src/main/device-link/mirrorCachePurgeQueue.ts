/**
 * mirrorCachePurgeQueue —— 「镜像缓存没清干净」的重试队列(持久 + 内存兜底)。
 * ---------------------------------------------------------------------------
 * `mirrorCacheStore` 的两条隐私路径都可能删不掉东西(Windows 文件锁、权限、并发写):
 *  - `clearAll()`:登出 / 切账号 / 会话失效,要清掉上一个账号的整份远程聊天缓存;
 *  - `clearDevice()`:对端撤销访问 / 关闭被控 / 本机禁用控制,要清掉那台设备的正文。
 * 两者都不该因为删除失败就阻断主流程(卡住登出比缓存暫留更糟),但也**不能只记一行日志**
 * —— 那样账号边界照常推进,明文缓存无限期留在盘上,既没有重试也没有痕迹(review: codex P1)。
 *
 * 这里提供可重试的记录,两个时机各消化一次:下一次进程启动(device-link 服务初始化后)、
 * 以及下一次账号边界 teardown。
 *
 * 记录分两级:
 *  - 整根条目(`clearAll` 失败):删掉整棵缓存目录;
 *  - 文件级条目(`clearDevice` 失败):只删列出的文件,不动别人的缓存。
 *
 * 双写:落盘 JSON(跨重启)+ 进程内内存表(userData 只读 / 满 / 被锁时的兜底,本进程内仍能
 * 在后续 drain 时重试)。落盘失败会**抛给调用方**,同时把条目留在内存里 —— 调用方据此
 * 记录「连持久记录都没写下」这一更严重的事实。
 *
 * 安全边界:条目里只有路径(owner 目录名是 userId 的 sha256 派生值,见
 * appSessionState.dataOwnerStorageKey —— 不可逆、不含账号信息,也不含任何凭证)。
 * 队列文件是普通 JSON,**不能当授权**:消化前一律重新校验路径落在 `<userData>/owners/` 之内。
 */

import { app } from 'electron';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import { createLogger } from '../logger';

const log = createLogger('device-link:mirror-cache-purge');

const QUEUE_FILE = 'device-link-mirror-cache-purge.json';
/** 队列条目上限:防止异常情况下无界增长。 */
const MAX_ENTRIES = 32;
/** 单条目里的文件级路径上限。 */
const MAX_PATHS_PER_ENTRY = 200;

interface PurgeEntry {
  /** 待清理的缓存根目录绝对路径。 */
  root: string;
  /**
   * 文件级重试清单。非空 = 只删这些文件(clearDevice 失败);
   * 缺省 / 空 = 删整棵 root(clearAll 失败)。
   */
  paths?: string[];
  /** 首次记录时间(毫秒),仅供排查。 */
  since: number;
  /** 已经尝试过多少次。 */
  attempts: number;
}

interface StoredQueue {
  version: 1;
  entries: PurgeEntry[];
}

/**
 * 内存兜底表:落盘失败时至少本进程内还能重试。key 用 `root|paths.join()` 去重。
 * 进程退出即丢 —— 它补的是「盘写不下去」这个洞,不是替代持久化。
 */
const memoryQueue = new Map<string, PurgeEntry>();

/**
 * 队列 mutation 的串行锁。`enqueuePurge` 与 `drainPurgeQueue` 都是「读盘 → 改 → 写盘」,
 * 不加锁时:drain 取完快照、enqueue 在其后写下一条新失败记录、drain 最后那次写入又把它
 * 覆盖掉 —— 那条记录只剩内存里,正常退出即丢,被撤销设备的缓存就此没有跨重启的重试
 * (review: codex P1)。所有 mutation 排成一条链,读与写落在同一个临界区内。
 */
let queueLock: Promise<unknown> = Promise.resolve();

function withQueueLock<T>(task: () => Promise<T>): Promise<T> {
  const next = queueLock.then(task, task);
  queueLock = next.catch(() => undefined);
  return next;
}

function queueFilePath(): string {
  return path.join(app.getPath('userData'), QUEUE_FILE);
}

/** owner 命名空间根:只允许清理它底下的路径。 */
function ownersRoot(): string {
  return path.join(app.getPath('userData'), 'owners');
}

function entryKey(entry: PurgeEntry): string {
  return `${path.resolve(entry.root)}|${[...(entry.paths ?? [])].sort().join('')}`;
}

/**
 * 路径是否可被本模块删除。队列文件是普通 JSON,理论上可被改写 —— 消化前必须重新验证,
 * 不能凭文件内容就去 rm 任意路径。
 */
export function isPurgableRoot(root: string, ownersRootPath: string): boolean {
  if (!root || typeof root !== 'string') return false;
  const resolved = path.resolve(root);
  const base = path.resolve(ownersRootPath);
  const rel = path.relative(base, resolved);
  // 必须在 owners/ 之内、且不是 owners/ 自身
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 文件级条目的每个路径都必须落在它自己的 root 之内(顺带满足 owners 约束)。 */
function isPurgablePath(target: string, root: string): boolean {
  if (!target || typeof target !== 'string') return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function readPersistedQueue(): Promise<PurgeEntry[]> {
  try {
    const raw = await fsp.readFile(queueFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const entries =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as StoredQueue).entries)
        ? (parsed as StoredQueue).entries
        : [];
    return compactEntries(
      entries
        .filter((entry): entry is PurgeEntry => !!entry && typeof entry.root === 'string')
        .map((entry) => {
          const paths = Array.isArray(entry.paths)
            ? entry.paths.filter((p): p is string => typeof p === 'string')
            : undefined;
          return {
            root: entry.root,
            // 文件级清单超上限(理论上写不出来,只可能来自被改写的队列文件):降级成整根条目
            // 而不是截断 —— 截断会静默漏掉待清路径,整根是超集(见 compactEntries)。
            paths: paths && paths.length > MAX_PATHS_PER_ENTRY ? undefined : paths,
            since: typeof entry.since === 'number' ? entry.since : Date.now(),
            attempts: typeof entry.attempts === 'number' ? entry.attempts : 0,
          };
        }),
    );
  } catch {
    return [];
  }
}

/** 持久 + 内存两处合并后的待清清单(内存条目优先,它更新)。 */
async function readQueue(): Promise<PurgeEntry[]> {
  const merged = new Map<string, PurgeEntry>();
  for (const entry of await readPersistedQueue()) merged.set(entryKey(entry), entry);
  for (const [key, entry] of memoryQueue) merged.set(key, entry);
  return compactEntries([...merged.values()]);
}

/**
 * 条目数超上限时**按 root 合并成整根条目**,而不是截掉尾部。
 *
 * 直接 slice 会静默丢掉待清路径(那正是隐私残留);整根条目是它们的超集 —— 清的是本 owner
 * 自己的缓存目录,而这份缓存是纯粹可重建的加速物,多删只损失首屏速度,不丢任何数据。
 */
function compactEntries(entries: readonly PurgeEntry[]): PurgeEntry[] {
  if (entries.length <= MAX_ENTRIES) return [...entries];
  const byRoot = new Map<string, PurgeEntry>();
  for (const entry of entries) {
    const key = path.resolve(entry.root);
    const existing = byRoot.get(key);
    byRoot.set(key, {
      root: entry.root,
      paths: undefined,
      since: existing ? Math.min(existing.since, entry.since) : entry.since,
      attempts: Math.max(existing?.attempts ?? 0, entry.attempts),
    });
  }
  const collapsed = [...byRoot.values()];
  log.warn(
    `mirror cache purge queue overflow (${entries.length} entries); collapsed to ${collapsed.length} root-level entr(ies)`,
  );
  // 极端情况下 root 数本身就超上限:此时按 since 保留最早的(失败最久的最该被清掉)。
  return collapsed.sort((a, b) => a.since - b.since).slice(0, MAX_ENTRIES);
}

/** 写队列文件。失败**抛出** —— 调用方需要知道「持久重试记录没写下」。 */
async function writeQueue(entries: readonly PurgeEntry[]): Promise<void> {
  const file = queueFilePath();
  if (entries.length === 0) {
    await fsp.rm(file, { force: true }).catch(() => undefined);
    return;
  }
  const payload: StoredQueue = { version: 1, entries: compactEntries(entries) };
  // 原子落位(写 .tmp 再 rename),不能直接覆写:这份文件是「缓存没清干净」唯一的跨重启
  // 痕迹,覆写期间进程被杀会留下截断的 JSON,下次启动解析失败被当成空队列,而内存兜底
  // 早随进程消失 —— 那些明文缓存就此永久失去清理机会(review: greptile P1 security)。
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * 记下一条没清干净的记录。同一 (root, paths) 只保留一条、attempts 累加。
 * `paths` 非空 = 文件级重试;缺省 = 整根重试。
 *
 * 内存表**先**记(保证本进程内一定能重试),再尝试落盘;落盘失败照常抛给调用方。
 */
export async function enqueuePurge(root: string, paths?: readonly string[]): Promise<void> {
  return withQueueLock(() => enqueuePurgeLocked(root, paths));
}

async function enqueuePurgeLocked(root: string, paths?: readonly string[]): Promise<void> {
  const base = ownersRoot();
  if (!isPurgableRoot(root, base)) {
    log.warn(`refusing to enqueue purge outside owners dir: ${root}`);
    return;
  }
  const safePaths = (paths ?? []).filter((target) => isPurgablePath(target, root));
  if ((paths?.length ?? 0) > 0 && safePaths.length === 0) {
    log.warn(`refusing to enqueue purge paths outside root: ${root}`);
    return;
  }
  // 超出单条目上限时**分片存**,不能直接 slice 掉尾部:`clearDevice()` 在最坏情况下会交来
  // 「200 个消息文件 + session-list.json」共 201 条,尾部正是那份 session-list —— 丢掉它
  // 等于消息删了、被撤销设备的元数据永久留在盘上还能被 hydrate 回侧边栏(review: codex P1)。
  const chunks: Array<string[] | undefined> =
    safePaths.length === 0
      ? [undefined]
      : Array.from({ length: Math.ceil(safePaths.length / MAX_PATHS_PER_ENTRY) }, (_, i) =>
          safePaths.slice(i * MAX_PATHS_PER_ENTRY, (i + 1) * MAX_PATHS_PER_ENTRY),
        );

  let persistError: unknown = null;
  for (const chunk of chunks) {
    const entry: PurgeEntry = { root, paths: chunk, since: Date.now(), attempts: 1 };
    const key = entryKey(entry);
    const existing = (await readQueue()).find((candidate) => entryKey(candidate) === key);
    if (existing) {
      entry.since = existing.since;
      entry.attempts = existing.attempts + 1;
    }
    // 内存兜底先落:即使接下来落盘失败,本进程后续的 drain 仍会重试。
    memoryQueue.set(key, entry);
    const entries = (await readQueue()).filter((candidate) => entryKey(candidate) !== key);
    entries.push(entry);
    try {
      await writeQueue(entries);
    } catch (err) {
      // 一个分片写不下去不代表其余分片也写不下去:记下第一个错误,剩下的照常尝试,
      // 全部处理完再抛(否则后面的分片连内存记录都没登记上)。
      persistError = persistError ?? err;
    }
  }
  if (persistError) {
    log.error(
      'failed to persist mirror cache purge queue (kept in memory only)',
      persistError,
    );
    throw persistError;
  }
}

/**
 * 消化队列:逐条重试删除,成功的移除。best-effort —— 不抛,失败的留到下一次。
 * 返回本次清掉与仍待清的条目数,便于日志与测试断言。
 */
export async function drainPurgeQueue(): Promise<{ purged: number; pending: number }> {
  return withQueueLock(drainPurgeQueueLocked);
}

async function drainPurgeQueueLocked(): Promise<{ purged: number; pending: number }> {
  const entries = await readQueue();
  if (entries.length === 0) return { purged: 0, pending: 0 };
  const base = ownersRoot();
  const keep: PurgeEntry[] = [];
  const purgedKeys = new Set<string>();
  let purged = 0;
  for (const entry of entries) {
    const key = entryKey(entry);
    if (!isPurgableRoot(entry.root, base)) {
      log.warn(`dropping purge entry outside owners dir: ${entry.root}`);
      memoryQueue.delete(key);
      purgedKeys.add(key); // 非法条目同样要从盘上消失
      continue;
    }
    const targets = (entry.paths ?? []).filter((target) => isPurgablePath(target, entry.root));
    try {
      if (entry.paths && entry.paths.length > 0) {
        // 逐个删成功才算清掉;剩下的继续留在队列里。
        //
        // `recursive: true` 是必需的:清理路径可能登记的是**目录** —— `clearDevice` 在
        // `messages/` 因权限而枚举失败时登记的就是那个目录本身。非递归的 `rm` 对非空目录会
        // 报 ERR_FS_EISDIR,于是权限恢复后这条重试也永远失败,已撤销设备的正文长期残留
        // (review: greptile + codex P1)。目标已被 isPurgablePath 限制在自己的 root 之内,
        // 递归不会越界。
        const stuck: string[] = [];
        for (const target of targets) {
          try {
            await fsp.rm(target, { recursive: true, force: true });
          } catch {
            stuck.push(target);
          }
        }
        if (stuck.length > 0) throw new Error(`${stuck.length} path(s) still undeletable`);
      } else {
        await fsp.rm(entry.root, { recursive: true, force: true });
      }
      purged += 1;
      purgedKeys.add(key);
      memoryQueue.delete(key);
      log.info(`purged leftover device-link mirror cache: ${entry.root}`);
    } catch (err) {
      const retried = { ...entry, attempts: entry.attempts + 1 };
      keep.push(retried);
      memoryQueue.set(key, retried);
      log.warn(`retry purge still failing (attempt ${retried.attempts}): ${entry.root}`, err);
    }
  }
  // 收尾写入前与「此刻盘上 + 内存」重新合并一次:锁只保证本进程内互斥,另一个实例
  // (共享 userData 的 dev 多开)可能刚写进新条目,不能被这次写入抹掉。
  const merged = new Map<string, PurgeEntry>();
  for (const entry of await readQueue()) merged.set(entryKey(entry), entry);
  for (const entry of keep) merged.set(entryKey(entry), entry);
  for (const key of purgedKeys) merged.delete(key);
  // 落盘失败不影响本次结果:内存表已经更新,下一次 drain 照样会重试。
  await writeQueue([...merged.values()]).catch((err: unknown) => {
    log.error('failed to persist purge queue after drain (kept in memory only)', err);
  });
  return { purged, pending: keep.length };
}

export const __testing = {
  queueFileName: QUEUE_FILE,
  maxEntries: MAX_ENTRIES,
  readQueue,
  resetMemoryQueue(): void {
    memoryQueue.clear();
  },
  memoryQueueSize(): number {
    return memoryQueue.size;
  },
};
