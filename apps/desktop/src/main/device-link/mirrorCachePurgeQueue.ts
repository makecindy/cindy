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
import { withCrossProcessLock } from './crossProcessLock';
import {
  bumpClearedCounter,
  cacheLockPath,
  clearPendingMark,
  listClearCounterKeys,
  listPendingClearScopes,
  CLEARED_ACCOUNT,
} from './mirrorCacheBarrier';

const log = createLogger('device-link:mirror-cache-purge');

const QUEUE_FILE = 'device-link-mirror-cache-purge.json';
/** 唯一允许被本队列删除的目录名(owner 作用域下的镜像缓存根)。 */
const MIRROR_CACHE_DIR_NAME = 'device-link-mirror-cache';
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
  /**
   * 还没落盘的**作废屏障** key(`<root>.control/cleared/` 下的计数器名)。
   * 消化时先把它们各自自增一次,再删数据 —— 那些 key 的自增当初失败了,只删文件的话,一笔
   * "内容取自清理之前、put 迟到"的写入会在记录被移除之后通过比对(review: codex P1)。
   * 必须是**具体的 key**:账号级计数救不了会话级的洞 —— 会话令牌在远端请求发起时取,
   * 而账号基线在 put 开始时才采样(已在自增之后),两项都会"对上"。
   */
  barriers?: string[];
  /**
   * 还挂着的**「清理没确认完成」墓碑** scope(`<root>.control/pending/` 下的名字)。
   * 补删成功后由这里撤掉 —— 墓碑挂着期间该 owner 的缓存读一律不命中,一次瞬时删除失败若让它
   * 永远挂着,整个账号的冷缓存就此关闭(review: codex P1)。
   */
  tombstones?: string[];
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

/** 跨进程互斥(实现见 crossProcessLock);拿不到锁时走**追加**路径,不做整份写回。 */
async function withFileLock<T>(task: (held: boolean) => Promise<T>): Promise<T> {
  return withCrossProcessLock(
    path.join(app.getPath('userData'), QUEUE_LOCK_FILE),
    { label: 'purge-queue' },
    (status) => task(status.held),
  );
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
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  // 必须**正好**是 `<ownerKey>/device-link-mirror-cache`:队列文件是不可信 JSON,放宽到
  // "owners 之内任意目录"就等于给了它删掉同一 owner 下凭证 / 对话 / 插件市场数据的能力
  // (review: copilot)。
  const parts = rel.split(path.sep);
  return parts.length === 2 && parts[1] === MIRROR_CACHE_DIR_NAME;
}

/** 单个屏障 key 的上限与形状:它会被拼进 `cleared/` 下的文件名,必须不含任何路径结构。 */
const MAX_BARRIERS_PER_ENTRY = 16;
const BARRIER_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 过滤屏障 key。队列文件是普通 JSON、随时可能被改写 —— 这些 key 会变成
 * `<root>.control/cleared/<key>` 的写入目标,所以只放行「纯字母数字 / 下划线 / 连字符」,
 * 分隔符、`..`、NUL 一律拒掉(与 isPurgablePath 同一条理由:文件内容不能当授权)。
 */
function safeBarrierKeys(keys: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const key of keys ?? []) {
    if (typeof key !== 'string' || !BARRIER_KEY_RE.test(key)) continue;
    if (!out.includes(key)) out.push(key);
    if (out.length >= MAX_BARRIERS_PER_ENTRY) break;
  }
  return out;
}

/** 文件级条目的每个路径都必须落在它自己的 root 之内(顺带满足 owners 约束)。 */
function isPurgablePath(target: string, root: string): boolean {
  if (!target || typeof target !== 'string') return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 把路径清单分成「整根」与「根内文件」两类。
 *
 * `clearDevice()` 在**持久屏障自增失败**时登记的就是 `root` 本身(意思是"这一整棵都不可信,
 * 整棵删掉重来")。而 `isPurgablePath(root, root)` 是 false(rel === ''),于是这条最重要的
 * 记录会被当成"root 之外的路径"整条拒收 —— IPC 随后报成功,既没有持久重试也没有挡读的队列
 * 条目,清理前 / 清理中的写入照样能把被撤销设备的正文重建出来(review: codex P1)。
 * 所以精确等于 root 的路径要升格成**整根清理**(它是任何文件级条目的超集)。
 */
function classifyPurgePaths(
  root: string,
  paths: readonly string[] | undefined,
): { wholeRoot: boolean; paths: string[] } {
  const resolvedRoot = path.resolve(root);
  let wholeRoot = false;
  const safe: string[] = [];
  for (const target of paths ?? []) {
    if (!target || typeof target !== 'string') continue;
    if (path.resolve(target) === resolvedRoot) {
      wholeRoot = true;
      continue;
    }
    if (isPurgablePath(target, root)) safe.push(target);
  }
  return { wholeRoot, paths: safe };
}

async function readPersistedQueue(): Promise<PurgeEntry[]> {
  // 正本读不出来(缺失 / 半个文件)时回退 .bak:Windows 落位需要「先挪走正本」的那条退路
  // 会短暂只留备份,崩在那一瞬不该等于「没有待清记录」(见 commitQueueFile)。
  const fromMain = await readQueueFile(queueFilePath());
  const main = fromMain ?? (await readQueueFile(`${queueFilePath()}.bak`)) ?? [];
  // 追加目录里的条目同样有效(抢不到锁时写在那里,见 QUEUE_PENDING_DIR)。
  const pending = (await readPendingEntries()).items;
  if (pending.length === 0) return main;
  const merged = new Map<string, PurgeEntry>();
  for (const entry of [...main, ...pending.map((p) => p.entry)]) merged.set(entryKey(entry), entry);
  return compactEntries([...merged.values()]);
}

function pendingDirPath(): string {
  return path.join(app.getPath('userData'), QUEUE_PENDING_DIR);
}

/** 追加目录里的条目(带文件名,便于折进正本后精确删除)。 */
async function readPendingEntries(): Promise<{
  items: Array<{ file: string; entry: PurgeEntry }>;
  unreadable: boolean;
}> {
  let names: string[];
  try {
    names = (await fsp.readdir(pendingDirPath(), { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name);
  } catch (err) {
    // 只有"目录不存在"能推出"没有待清记录";EACCES / EPERM / Windows 瞬时锁一律 fail-closed
    // —— 这些文件可能是"已撤销明文仍待删除"的唯一凭据,当成空会让读路径重新放行
    // (review: codex P1)。
    const code = (err as NodeJS.ErrnoException)?.code;
    const absent = code === 'ENOENT' || code === 'ENOTDIR';
    return { items: [], unreadable: !absent };
  }
  const out: Array<{ file: string; entry: PurgeEntry }> = [];
  let unreadable = false;
  for (const name of names) {
    const file = path.join(pendingDirPath(), name);
    const parsed = await readQueueFile(file);
    if (parsed === null) {
      // 文件在那儿但读不出来:同样 fail-closed。
      unreadable = true;
      continue;
    }
    for (const entry of parsed) out.push({ file, entry });
  }
  return { items: out, unreadable };
}

/**
 * 追加一条待清记录(抢不到跨进程锁时走这里)。一条记录一个文件、文件名由 entryKey 派生 ——
 * 同一条重复登记只会覆盖自己那一个文件,永远不会碰到别人的条目。
 */
async function appendPendingEntry(entry: PurgeEntry): Promise<void> {
  const dir = pendingDirPath();
  await fsp.mkdir(dir, { recursive: true });
  // 文件名带随机后缀:同一条记录的**新版本**不能覆盖 drain 正在处理的那一份 —— 否则
  // 「drain 取完 pendingFiles → 另一个实例重新入队(同名覆盖)→ drain 收尾按名字删掉它」
  // 会把刚记下的失败清理抹掉,只剩那个实例的内存副本(review: codex P1)。
  // 同一条记录留下多份文件无妨:读取侧按 entryKey 去重,drain 折进正本后一并删掉。
  const file = path.join(
    dir,
    `${digestOfKey(entryKey(entry))}-${randomBytes(6).toString('hex')}.json`,
  );
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
            barriers: safeBarrierKeys(Array.isArray(entry.barriers) ? entry.barriers : undefined),
            tombstones: safeBarrierKeys(
              Array.isArray(entry.tombstones) ? entry.tombstones : undefined,
            ),
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
    // barriers 取并集:折叠成整根条目不代表"不用补屏障了" —— 消化时若没有具体 key,
    // 就只能退回账号级,而账号基线是 put 开始时才采样的,救不了会话级那个洞
    // (review: codex P1)。整根删除是路径的超集,屏障却必须逐个保留。
    const barriers = safeBarrierKeys([...(existing?.barriers ?? []), ...(entry.barriers ?? [])]);
    const tombstones = safeBarrierKeys([
      ...(existing?.tombstones ?? []),
      ...(entry.tombstones ?? []),
    ]);
    byRoot.set(key, {
      root: entry.root,
      paths: undefined,
      ...(barriers.length > 0 ? { barriers } : {}),
      ...(tombstones.length > 0 ? { tombstones } : {}),
      since: existing ? Math.min(existing.since, entry.since) : entry.since,
      attempts: Math.max(existing?.attempts ?? 0, entry.attempts),
    });
  }
  const collapsed = [...byRoot.values()];
  log.warn(
    `mirror cache purge queue overflow (${entries.length} entries); collapsed to ${collapsed.length} root-level entr(ies)`,
  );
  // **不再截断**:不同 owner root 之间无法合并(一个账号的缓存不能拿另一个账号的清理来代表),
  // 截掉就等于那个账号的明文缓存永远没有重试机会(review: codex P1)。超出正本容量的部分由
  // writeQueue 溢写到追加目录 —— 那里一条一个文件,读取时会被并回来。
  // 按 since 升序:失败最久的排在前面,优先留在正本里。
  return collapsed.sort((a, b) => a.since - b.since);
}

/** 写队列文件。失败**抛出** —— 调用方需要知道「持久重试记录没写下」。 */
async function writeQueue(entries: readonly PurgeEntry[]): Promise<void> {
  const file = queueFilePath();
  if (entries.length === 0) {
    // 删不掉要**抛**:账本还在盘上的话,hasPendingPurgeRecords() 会一直判"有待清"从而
    // 永久压掉所有缓存读,而下一次 drain 还会照着这份陈旧账本再删一遍(可能删掉刚重建的
    // 缓存)。调用方据此保留内存里的重试状态并如实报告(review: codex P1)。
    // 备份必须一起删:正本"合法缺失"(队列清空)时读取侧会回退 .bak,留着它等于把
    // 已经清完的条目又复活出来。
    for (const target of [file, `${file}.bak`]) {
      try {
        await fsp.rm(target, { force: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        throw err;
      }
    }
    return;
  }
  const compacted = compactEntries(entries);
  // 正本只放前 MAX_ENTRIES 条,其余**溢写**成追加文件(一条一个),读取时并回来。
  // 这样"条目数超上限"不会丢掉任何一个 owner root 的待清记录(review: codex P1)。
  // 溢写必须**先成功**再改正本:否则「追加目录写不进、正本可写」时,被挤出正本的那条
  // 记录在盘上一份都不剩,进程退出即丢(review: codex P1)。抛给调用方,由它保留内存副本
  // 并如实报告"持久记录没写下"。
  const overflow = compacted.slice(MAX_ENTRIES);
  for (const entry of overflow) {
    try {
      await appendPendingEntry(entry);
    } catch (err) {
      log.error('failed to spill overflow purge entry to pending dir', err);
      throw err;
    }
  }
  const payload: StoredQueue = { version: 1, entries: compacted.slice(0, MAX_ENTRIES) };
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
export async function enqueuePurge(
  root: string,
  paths?: readonly string[],
  barriers?: readonly string[],
  tombstones?: readonly string[],
): Promise<void> {
  return withQueueLock((held) => enqueuePurgeLocked(root, paths, barriers, tombstones, held));
}

async function enqueuePurgeLocked(
  root: string,
  paths?: readonly string[],
  barriers?: readonly string[],
  tombstones?: readonly string[],
  lockHeld = true,
): Promise<void> {
  const base = ownersRoot();
  if (!isPurgableRoot(root, base)) {
    log.warn(`refusing to enqueue purge outside owners dir: ${root}`);
    return;
  }
  const classified = classifyPurgePaths(root, paths);
  // 精确等于 root 的路径 = 整根清理(见 classifyPurgePaths);整根是文件级的超集,
  // 其余路径不必再单独登记。
  const safePaths = classified.wholeRoot ? [] : classified.paths;
  if (!classified.wholeRoot && (paths?.length ?? 0) > 0 && safePaths.length === 0) {
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
    const entry: PurgeEntry = {
      root,
      paths: chunk,
      barriers: safeBarrierKeys(barriers),
      tombstones: safeBarrierKeys(tombstones),
      since: Date.now(),
      attempts: 1,
    };
    if (entry.barriers?.length === 0) delete entry.barriers;
    if (entry.tombstones?.length === 0) delete entry.tombstones;
    const key = entryKey(entry);
    const existing = (await readQueue()).find((candidate) => entryKey(candidate) === key);
    if (existing) {
      entry.since = existing.since;
      entry.attempts = existing.attempts + 1;
      // 屏障 key 取并集:同一条记录先因"会话计数自增失败"登记、后又因别的原因重复登记时,
      // 不能把先前那个待修的 key 丢掉(丢了就等于漏修屏障)。
      const merged = safeBarrierKeys([...(existing.barriers ?? []), ...(entry.barriers ?? [])]);
      if (merged.length > 0) entry.barriers = merged;
      const marks = safeBarrierKeys([...(existing.tombstones ?? []), ...(entry.tombstones ?? [])]);
      if (marks.length > 0) entry.tombstones = marks;
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
    log.error('failed to persist mirror cache purge queue (kept in memory only)', persistError);
    throw persistError;
  }
}

/**
 * 消化队列:逐条重试删除,成功的移除。best-effort —— 不抛,失败的留到下一次。
 * 返回本次清掉与仍待清的条目数,便于日志与测试断言。
 */
/**
 * 「此刻还有没有待清记录」——读路径据此**拒绝命中**:队列里留着"本该删掉却删不掉"的东西时,
 * 那份内容仍在盘上,照读就等于把已撤销 / 上一个账号的内容交回 renderer(review: codex P1)。
 *
 * 刻意每次都查**当前**状态(内存表 + 正本 / 备份 / 追加目录是否存在),而不是缓存上一次 drain
 * 的结果:一条 drain 之后才入队的失败清理、或另一个共享 userData 进程刚追加的记录,都必须
 * 立刻挡住读(review: codex P1)。开销是 2~3 个 stat / readdir,与随后要读的缓存文件同量级。
 * 任何一处读不出来都按"有待清"处理(fail-closed)。
 */
export async function hasPendingPurgeRecords(): Promise<boolean> {
  if (memoryQueue.size > 0) return true;
  for (const file of [queueFilePath(), `${queueFilePath()}.bak`]) {
    try {
      await fsp.stat(file);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return true; // 读不出来 → fail-closed
    }
  }
  const pending = await readPendingEntries();
  return pending.unreadable || pending.items.length > 0;
}

export async function drainPurgeQueue(): Promise<{ purged: number; pending: number }> {
  return withQueueLock(drainPurgeQueueLocked);
}

async function drainPurgeQueueLocked(
  lockHeld = true,
): Promise<{ purged: number; pending: number }> {
  // 折进正本之前先记下追加目录里有哪些文件:只删这次真的读进来的那几个,
  // 期间另一个实例新写的追加文件不受影响。
  const pendingRead = lockHeld ? await readPendingEntries() : { items: [], unreadable: false };
  const pendingFiles = pendingRead.items;
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
    // 盘上的老条目(以及别的实例写的)可能把 root 本身列在 paths 里 → 同样按整根清理处理。
    const classified = classifyPurgePaths(entry.root, entry.paths);
    const targets = classified.paths;
    try {
      // 补删之前先把**作废屏障**修好(账号级计数自增一次)。
      //
      // 为什么必须在这里做:登记进队列的成因之一正是"作废计数自增失败"(见 mirrorCacheStore
      // 空写路径)。那种条目只带着消息文件路径 —— 如果这里只把文件删掉、记录一扔,盘上的计数
      // 仍是清理**之前**的值,于是另一个共享 userData 的进程那笔迟到的最新页(它握着同一个旧
      // 计数)会在消化之后通过比对,把已清掉的正文重建回来(review: codex P1)。
      // 顺序同 clearDevice:意图先落盘、再删数据 —— 自增之后才捕获内容的写入拿的是新值,
      // 而"内容取自自增之前"的写入一律失配。修不好就整条留着重试(读路径同时保持被挡)。
      // 优先自增**当初失败的那些 key**(会话级 / 设备级);没有登记时(整根条目、老版本条目)
      // 退回账号级 —— 它是 clearAll 失败那条路径的正解。
      // 整根条目 = "这一整棵都不可信":把该 root 下**所有**计数都自增一遍,而不是只信条目里
      // 那份有上限的 key 清单 —— 折叠(>32 条)时清单可能装不下全部会话 key,漏掉一个就等于
      // 漏掉一条屏障(review: codex P1)。文件级条目仍按登记的 key 精确处理。
      // 整根删除的两种来源:paths 里列了 root 本身,或者压根没有 paths(clearAll 失败那一路)。
      const purgeWholeRoot = classified.wholeRoot || !(entry.paths && entry.paths.length > 0);
      const barrierKeys = safeBarrierKeys(entry.barriers);
      const keysToBump = purgeWholeRoot
        ? [
            ...new Set([
              ...(await listClearCounterKeys(entry.root)),
              CLEARED_ACCOUNT,
              ...barrierKeys,
            ]),
          ]
        : barrierKeys.length > 0
          ? barrierKeys
          : [CLEARED_ACCOUNT];
      // 整段补删拿着**镜像缓存自己那把跨进程锁**跑(队列锁只互斥队列簿记,管不到缓存写入)。
      // 否则另一个实例的最新页写入可以在"自增之后、删除之前"发起:它读到的是新计数,提交时也
      // 一致,于是在 rm 之后把被撤销的正文重建出来,而这里照样把队列条目扔掉(review: codex P1)。
      // 拿不到锁也照删(删除是安全方向),那种情况由收尾的第二次自增兜住。
      // 锁文件要能建出来:控制面目录可能还不存在(store 侧同样先 ensureDir)。
      const lockFile = cacheLockPath(entry.root);
      await fsp.mkdir(path.dirname(lockFile), { recursive: true }).catch(() => undefined);
      await withCrossProcessLock(lockFile, { label: 'mirror-cache' }, async (status) => {
        if (!status.held) {
          log.warn(`purging ${entry.root} without the mirror-cache lock; relying on barriers`);
        }
        for (const key of keysToBump) await bumpClearedCounter(entry.root, key);
        if (!purgeWholeRoot) {
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
        // 收尾再自增一次(同 clearDevice / clearAll 的前后两次):挡住"内容取自补删**进行中**"
        // 的写入 —— 它入口读到的已是第一次自增之后的值,只靠第一次挡不住它。自增失败即视为
        // 没清完,整条留着重试。
        for (const key of keysToBump) await bumpClearedCounter(entry.root, key);
        // 删干净了 → 退役"清理没确认完成"墓碑。不撤的话,一次瞬时删除失败会让该 owner 的
        // 缓存读永久不命中(hasPendingClears 对整个 root 生效)(review: codex P1)。
        // 撤墓碑排在最后:前面任何一步抛错都会让条目留在队列里,墓碑也就继续挡着读。
        // 整根删完 = 这个 owner 没有任何"清理未完成"了 → 所有墓碑一次退役(同理不依赖清单)。
        const scopes = purgeWholeRoot
          ? await listPendingClearScopes(entry.root)
          : safeBarrierKeys(entry.tombstones);
        for (const scope of scopes) await clearPendingMark(entry.root, scope);
      });
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
  return { purged, pending: keep.length + (pendingRead.unreadable ? 1 : 0) };
}

export const __testing = {
  queueFileName: QUEUE_FILE,
  lockFileName: QUEUE_LOCK_FILE,
  pendingDirName: QUEUE_PENDING_DIR,
  maxEntries: MAX_ENTRIES,
  readQueue,
  compactEntries,
  resetMemoryQueue(): void {
    memoryQueue.clear();
  },
  memoryQueueSize(): number {
    return memoryQueue.size;
  },
};
