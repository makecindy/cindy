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
import { createHash, randomBytes } from 'node:crypto';

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

function withQueueLock<T>(task: (held: boolean) => Promise<T>): Promise<T> {
  const guarded = (): Promise<T> => withFileLock(task);
  const next = queueLock.then(guarded, guarded);
  queueLock = next.catch(() => undefined);
  return next;
}

/**
 * 抢不到锁时的「追加式」落盘目录:一条记录一个文件,写入只 create/replace 自己那一个 ——
 * 不做整份读改写,因此**不可能**被另一个进程的整份写入抹掉(review: codex P1)。
 * 下一次拿到锁的 drain 会把它们折进正本并删掉。
 */
const QUEUE_PENDING_DIR = `${QUEUE_FILE}.pending`;

/** 跨进程锁文件名(与队列文件同目录)。 */
const QUEUE_LOCK_FILE = `${QUEUE_FILE}.lock`;
/** 超过这个年龄的锁一定是崩溃残留(临界区只有几毫秒的文件 IO),可以强行接管。 */
const LOCK_STALE_MS = 10_000;
/** 抢锁最长等待:拿不到就降级为「只靠进程内锁 + 提交时合并」,绝不因此丢掉这次记录。 */
const LOCK_WAIT_MS = 3_000;
const LOCK_RETRY_MS = 40;

/**
 * 跨进程互斥。dev 实例与打包实例可以共用同一个 userData(见 devStartupStatus.ts),
 * 于是「读队列 → 改 → 整份写回」在两个进程之间会互相覆盖:后落位的那次赢,输的那条记录
 * 只剩在自己进程的 memoryQueue 里,进程退出即消失,对应的明文缓存再也没有重试
 * (review: codex P1)。
 *
 * 用 `open(lock, 'wx')` 做锁:同目录、O_EXCL 语义在 Windows / macOS / Linux 都可靠。
 * 抢不到就退化(只等 LOCK_WAIT_MS),因为「宁可偶尔覆盖,也不能因为拿不到锁就不记」——
 * 提交时的合并(drain / enqueue 都在临界区里重读一次最新盘上内容)仍在兜着。
 */
async function withFileLock<T>(task: (held: boolean) => Promise<T>): Promise<T> {
  const lock = path.join(app.getPath('userData'), QUEUE_LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  for (;;) {
    try {
      const handle = await fsp.open(lock, 'wx');
      await handle.writeFile(String(process.pid), 'utf8').catch(() => undefined);
      await handle.close().catch(() => undefined);
      held = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') break; // 权限等:直接降级
      const stat = await fsp.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        log.warn('breaking stale mirror cache purge queue lock');
        await fsp.rm(lock, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        log.warn('mirror cache purge queue lock busy; proceeding without cross-process lock');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await task(held);
  } finally {
    if (held) await fsp.rm(lock, { force: true }).catch(() => undefined);
  }
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
  // 正本读不出来(缺失 / 半个文件)时回退 .bak:Windows 落位需要「先挪走正本」的那条退路
  // 会短暂只留备份,崩在那一瞬不该等于「没有待清记录」(见 commitQueueFile)。
  const fromMain = await readQueueFile(queueFilePath());
  const main = fromMain ?? (await readQueueFile(`${queueFilePath()}.bak`)) ?? [];
  // 追加目录里的条目同样有效(抢不到锁时写在那里,见 QUEUE_PENDING_DIR)。
  const pending = await readPendingEntries();
  if (pending.length === 0) return main;
  const merged = new Map<string, PurgeEntry>();
  for (const entry of [...main, ...pending.map((p) => p.entry)]) merged.set(entryKey(entry), entry);
  return compactEntries([...merged.values()]);
}

function pendingDirPath(): string {
  return path.join(app.getPath('userData'), QUEUE_PENDING_DIR);
}

/** 追加目录里的条目(带文件名,便于折进正本后精确删除)。 */
async function readPendingEntries(): Promise<Array<{ file: string; entry: PurgeEntry }>> {
  let names: string[];
  try {
    names = (await fsp.readdir(pendingDirPath(), { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: Array<{ file: string; entry: PurgeEntry }> = [];
  for (const name of names) {
    const file = path.join(pendingDirPath(), name);
    const parsed = await readQueueFile(file);
    if (!parsed || parsed.length === 0) continue;
    for (const entry of parsed) out.push({ file, entry });
  }
  return out;
}

/**
 * 追加一条待清记录(抢不到跨进程锁时走这里)。一条记录一个文件、文件名由 entryKey 派生 ——
 * 同一条重复登记只会覆盖自己那一个文件,永远不会碰到别人的条目。
 */
async function appendPendingEntry(entry: PurgeEntry): Promise<void> {
  const dir = pendingDirPath();
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${digestOfKey(entryKey(entry))}.json`);
  const payload: StoredQueue = { version: 1, entries: [entry] };
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function digestOfKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

async function readQueueFile(file: string): Promise<PurgeEntry[] | null> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
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
    // 读不出来 / 不是合法 JSON → null:交给调用方决定是否回退 .bak。
    return null;
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
    // 备份必须一起删:正本"合法缺失"(队列清空)时读取侧会回退 .bak,留着它等于把
    // 已经清完的条目又复活出来。
    await fsp.rm(`${file}.bak`, { force: true }).catch(() => undefined);
    return;
  }
  const payload: StoredQueue = { version: 1, entries: compactEntries(entries) };
  // 原子落位(写 .tmp 再 rename),不能直接覆写:这份文件是「缓存没清干净」唯一的跨重启
  // 痕迹,覆写期间进程被杀会留下截断的 JSON,下次启动解析失败被当成空队列,而内存兜底
  // 早随进程消失 —— 那些明文缓存就此永久失去清理机会(review: greptile P1 security)。
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await commitQueueFile(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * 把 tmp 落到目标位置。Windows 上目标已存在时 rename 可能报 EPERM / EACCES / EBUSY
 * (杀毒软件、索引器或另一个实例正打开这个文件),直接失败会让这条重试记录只剩内存、
 * 进程退出即丢(review: greptile P1 security)。
 *
 * 退路不是「删目标再 rename」——那个窗口里进程一死,整份队列就没了。改成先把目标挪到
 * `.bak` 再落位:任一步崩溃都至少有一份完整 JSON 在盘上,读取侧会回退到 `.bak`
 * (见 readPersistedQueue)。
 */
async function commitQueueFile(tmp: string, file: string): Promise<void> {
  try {
    await fsp.rename(tmp, file);
    // 落位成功,上一份备份没用了(留着会让下次读取回退到过期清单)。
    await fsp.rm(`${file}.bak`, { force: true }).catch(() => undefined);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EEXIST') throw err;
  }
  const bak = `${file}.bak`;
  await fsp.rm(bak, { force: true }).catch(() => undefined);
  // 目标不存在(ENOENT)说明失败与「无法替换」无关,让下面的 rename 把真错误抛出来。
  await fsp.rename(file, bak).catch(() => undefined);
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    // 落位仍然失败:把备份挪回去,别让盘上只剩一个 .bak(读取侧能回退,但正本缺失
    // 会让下一次写入把它当成"从未有过记录")。
    await fsp.rename(bak, file).catch(() => undefined);
    throw err;
  }
  await fsp.rm(bak, { force: true }).catch(() => undefined);
}

/**
 * 记下一条没清干净的记录。同一 (root, paths) 只保留一条、attempts 累加。
 * `paths` 非空 = 文件级重试;缺省 = 整根重试。
 *
 * 内存表**先**记(保证本进程内一定能重试),再尝试落盘;落盘失败照常抛给调用方。
 */
export async function enqueuePurge(root: string, paths?: readonly string[]): Promise<void> {
  return withQueueLock((held) => enqueuePurgeLocked(root, paths, held));
}

async function enqueuePurgeLocked(
  root: string,
  paths?: readonly string[],
  lockHeld = true,
): Promise<void> {
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
    try {
      if (lockHeld) {
        const entries = (await readQueue()).filter((candidate) => entryKey(candidate) !== key);
        entries.push(entry);
        await writeQueue(entries);
      } else {
        // 没拿到跨进程锁:**不做整份读改写**(会被另一个实例的写入抹掉),改成追加一条
        // 独立文件,交给下一次拿到锁的 drain 折进正本(review: codex P1)。
        await appendPendingEntry(entry);
      }
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

async function drainPurgeQueueLocked(lockHeld = true): Promise<{ purged: number; pending: number }> {
  // 折进正本之前先记下追加目录里有哪些文件:只删这次真的读进来的那几个,
  // 期间另一个实例新写的追加文件不受影响。
  const pendingFiles = lockHeld ? await readPendingEntries() : [];
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
  if (!lockHeld) {
    // 没拿到跨进程锁:删除照做(幂等),但**不动盘上的簿记** —— 整份写回会抹掉另一个实例
    // 刚记下的条目。留给下一次拿到锁的 drain 收拾(review: codex P1)。
    log.warn('drained without cross-process lock; leaving queue bookkeeping to a later run');
    return { purged, pending: keep.length };
  }
  // 落盘失败不影响本次结果:内存表已经更新,下一次 drain 照样会重试。
  let persisted = true;
  await writeQueue([...merged.values()]).catch((err: unknown) => {
    persisted = false;
    log.error('failed to persist purge queue after drain (kept in memory only)', err);
  });
  // 正本写成功后才删追加文件(它们的内容已经进正本或已被清掉);写失败就留着,下次再折。
  if (persisted) {
    for (const { file } of pendingFiles) await fsp.rm(file, { force: true }).catch(() => undefined);
  }
  return { purged, pending: keep.length };
}

export const __testing = {
  queueFileName: QUEUE_FILE,
  lockFileName: QUEUE_LOCK_FILE,
  pendingDirName: QUEUE_PENDING_DIR,
  maxEntries: MAX_ENTRIES,
  readQueue,
  resetMemoryQueue(): void {
    memoryQueue.clear();
  },
  memoryQueueSize(): number {
    return memoryQueue.size;
  },
};
