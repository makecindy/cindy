/**
 * mirrorCachePurgeQueue —— 「登出时没清干净的镜像缓存」的持久重试队列。
 * ---------------------------------------------------------------------------
 * `mirrorCacheStore.clearAll()` 是隐私路径:登出 / 切账号 / 会话失效时必须把上一个账号的
 * 远程聊天缓存从盘上删掉。但删除**可能失败**(Windows 文件锁、权限、并发写),而登出本身
 * 不能因此卡住 —— 于是只记一条日志的话,账号边界照常推进,那份明文缓存就无限期留在盘上,
 * 既没有重试也没有任何痕迹(review: codex P1)。
 *
 * 这里补上「持久化一次重试」:失败时把待清目录记进 userData 根下的小 JSON,
 * 之后两个时机各消化一次 —— 下一次进程启动(device-link 服务初始化时)、以及下一次
 * 账号边界 teardown。清成功就把条目移除。
 *
 * 记录里**只有目录路径**:owner 命名空间目录名是 userId 的 sha256 派生值(见
 * appSessionState.dataOwnerStorageKey),不可逆、不含账号信息,也不含任何凭证。
 * 消化时强制校验路径落在 `<userData>/owners/` 之内,不接受队列文件被人为改成任意路径。
 */

import { app } from 'electron';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { createLogger } from '../logger';

const log = createLogger('device-link:mirror-cache-purge');

const QUEUE_FILE = 'device-link-mirror-cache-purge.json';
/** 队列条目上限:防止异常情况下无界增长(每条只有一个路径 + 时间戳)。 */
const MAX_ENTRIES = 32;

interface PurgeEntry {
  /** 待清理的缓存根目录绝对路径。 */
  root: string;
  /** 首次记录时间(毫秒),仅供排查。 */
  since: number;
  /** 已经尝试过多少次。 */
  attempts: number;
}

interface StoredQueue {
  version: 1;
  entries: PurgeEntry[];
}

function queueFilePath(): string {
  return path.join(app.getPath('userData'), QUEUE_FILE);
}

/** owner 命名空间根:只允许清理它底下的路径。 */
function ownersRoot(): string {
  return path.join(app.getPath('userData'), 'owners');
}

/**
 * 路径是否可被本模块删除。队列文件是普通 JSON,理论上可被改写 —— 消化前必须重新验证,
 * 不能凭文件内容就去 rm 任意目录。
 */
export function isPurgableRoot(root: string, ownersRootPath: string): boolean {
  if (!root || typeof root !== 'string') return false;
  const resolved = path.resolve(root);
  const base = path.resolve(ownersRootPath);
  const rel = path.relative(base, resolved);
  // 必须在 owners/ 之内、且不是 owners/ 自身
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function readQueue(): Promise<PurgeEntry[]> {
  try {
    const raw = await fsp.readFile(queueFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const entries =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as StoredQueue).entries)
        ? (parsed as StoredQueue).entries
        : [];
    return entries
      .filter((entry): entry is PurgeEntry => !!entry && typeof entry.root === 'string')
      .map((entry) => ({
        root: entry.root,
        since: typeof entry.since === 'number' ? entry.since : Date.now(),
        attempts: typeof entry.attempts === 'number' ? entry.attempts : 0,
      }))
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

async function writeQueue(entries: readonly PurgeEntry[]): Promise<void> {
  const file = queueFilePath();
  if (entries.length === 0) {
    await fsp.rm(file, { force: true }).catch(() => undefined);
    return;
  }
  const payload: StoredQueue = { version: 1, entries: entries.slice(0, MAX_ENTRIES) };
  await fsp.writeFile(file, JSON.stringify(payload), 'utf8').catch((err: unknown) => {
    log.warn('failed to persist mirror cache purge queue', err);
  });
}

/** 记下一个没清干净的缓存目录(同一目录只保留一条,累加 attempts)。 */
export async function enqueuePurge(root: string): Promise<void> {
  if (!isPurgableRoot(root, ownersRoot())) {
    log.warn(`refusing to enqueue purge outside owners dir: ${root}`);
    return;
  }
  const entries = await readQueue();
  const existing = entries.find((entry) => path.resolve(entry.root) === path.resolve(root));
  if (existing) existing.attempts += 1;
  else entries.push({ root, since: Date.now(), attempts: 1 });
  await writeQueue(entries);
}

/**
 * 消化队列:逐个重试删除,成功的移除条目。best-effort —— 全程不抛,失败的留到下一次。
 * 返回本次成功清掉的数量,便于日志与测试断言。
 */
export async function drainPurgeQueue(): Promise<{ purged: number; pending: number }> {
  const entries = await readQueue();
  if (entries.length === 0) return { purged: 0, pending: 0 };
  const base = ownersRoot();
  const keep: PurgeEntry[] = [];
  let purged = 0;
  for (const entry of entries) {
    if (!isPurgableRoot(entry.root, base)) {
      log.warn(`dropping purge entry outside owners dir: ${entry.root}`);
      continue;
    }
    try {
      await fsp.rm(entry.root, { recursive: true, force: true });
      purged += 1;
      log.info(`purged leftover device-link mirror cache: ${entry.root}`);
    } catch (err) {
      keep.push({ ...entry, attempts: entry.attempts + 1 });
      log.warn(`retry purge still failing (attempt ${entry.attempts + 1}): ${entry.root}`, err);
    }
  }
  await writeQueue(keep);
  return { purged, pending: keep.length };
}

export const __testing = { queueFileName: QUEUE_FILE, maxEntries: MAX_ENTRIES, readQueue };
