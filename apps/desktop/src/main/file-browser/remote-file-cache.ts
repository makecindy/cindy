/**
 * remote-file-cache — 远程大文件(>2MiB inline 上限)的本地缓存与取回管线。
 *
 * 双 backend,上层(READ_FILE 大文件分级)无感:
 *  - ssh:daemon readFileChunk 分片循环(1MiB/片,base64 over stdio),bytes
 *    走 SSH 直连,不经任何服务器;
 *  - device:被控端 exportFile 上传 OSS → 本端 presign-get 流式直下(bytes
 *    不经 relay),下载完 best-effort 删中转对象。
 *
 * 缓存:userData/remote-file-cache/<sha1(identity)>-<basename>,identity =
 * transport+端点+workdir+relPath+size+mtimeMs——远端文件变了 identity 即变,
 * 天然失效;命中直接复用(2GB 不用重拉)。LRU 按字节上限逐出(atime 用
 * 文件 mtime 近似:命中时 touch)。
 *
 * 并发:同 identity 的取回去重(inflight map);进度回调节流到 ~10Hz 由
 * caller 侧完成(这里每片/每 chunk 都回调)。
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import { dataOwnerStorageKey } from '../appSessionState.js';
import { createLogger } from '../logger.js';

const log = createLogger('file-browser/remote-cache');

const CACHE_DIR_NAME = 'remote-file-cache';
const CHAT_ATTACHMENT_CACHE_DIR_NAME = 'chat-attachment-cache';
/** LRU 字节上限:4GB——够放两个 2GB 文件,超出按最旧访问逐出。 */
const MAX_CACHE_BYTES = 4 * 1024 * 1024 * 1024;

export interface RemoteFileIdentity {
  transport: 'ssh' | 'device';
  /** SSH hostId 或 device-link deviceId。 */
  endpointId: string;
  workdir: string;
  relPath: string;
  size: number;
  mtimeMs: number;
}

export type FetchProgressFn = (received: number, total: number, phase?: 'upload' | 'download') => void;

/** 取回执行体:把远端文件完整写到 destPath(临时路径),完成返回。 */
export type FetchExecutor = (destPath: string, onProgress: FetchProgressFn) => Promise<void>;

function cacheDir(): string {
  return path.join(app.getPath('userData'), CACHE_DIR_NAME);
}

export function getRemoteFileCacheRoot(): string {
  return cacheDir();
}

function chatAttachmentCacheDir(): string {
  return path.join(app.getPath('userData'), CHAT_ATTACHMENT_CACHE_DIR_NAME);
}

function chatAttachmentOwnerCacheDir(ownerId: string): string {
  return path.join(chatAttachmentCacheDir(), dataOwnerStorageKey(ownerId));
}

export function getChatAttachmentOwnerCacheRoot(ownerId: string): string {
  return chatAttachmentOwnerCacheDir(ownerId);
}

/**
 * Chat history persists staged attachment paths, so this root must not share the
 * bounded remote-file LRU whose entries are disposable fetch copies.
 */
export function getChatAttachmentCacheRoot(): string {
  return chatAttachmentCacheDir();
}

function normalizePathForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Remove renderer-owned draft copies without crossing owner or persisted-message
 * boundaries. The optional guard is checked immediately before unlink so an
 * account switch that happens while filesystem metadata is being read cancels
 * the destructive step.
 */
export async function cleanupOwnedUnpersistedStagedChatAttachments(params: {
  ownerId: string;
  filePaths: readonly string[];
  protectedPaths: readonly string[];
  canRemove?: () => boolean;
}): Promise<void> {
  const ownerDir = normalizePathForComparison(chatAttachmentOwnerCacheDir(params.ownerId));
  const protectedPaths = new Set(params.protectedPaths.map(normalizePathForComparison));
  await Promise.all(
    params.filePaths.map(async (filePath) => {
      if (
        typeof filePath !== 'string' ||
        !path.isAbsolute(filePath) ||
        path.extname(filePath).toLowerCase() !== '.bin' ||
        normalizePathForComparison(path.dirname(filePath)) !== ownerDir ||
        protectedPaths.has(normalizePathForComparison(filePath))
      ) {
        return;
      }
      try {
        const stat = await fs.lstat(filePath);
        if (!stat.isFile() && !stat.isSymbolicLink()) return;
        if (params.canRemove && !params.canRemove()) return;
        await fs.unlink(filePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code !== 'ENOENT') {
          log.warn('owned staged chat attachment cleanup failed', {
            filePath,
            error: String(err),
          });
        }
      }
    }),
  );
}

export interface StartupStagedChatAttachmentSweepResult {
  inspected: number;
  removed: number;
  protected: number;
}

/**
 * Remove abandoned dangerous-attachment staging files from the current
 * account. Renderer drafts are intentionally in-memory only, so anything
 * created by an earlier process and not referenced by persisted messages is
 * unreachable after restart. Files created by this process are left alone to
 * avoid racing a draft that is still being assembled.
 */
export async function sweepStagedChatAttachmentsOnStartup(params: {
  ownerId: string;
  protectedPaths: readonly string[];
  createdBeforeMs: number;
}): Promise<StartupStagedChatAttachmentSweepResult> {
  const result: StartupStagedChatAttachmentSweepResult = {
    inspected: 0,
    removed: 0,
    protected: 0,
  };
  const protectedPaths = new Set(params.protectedPaths.map(normalizePathForComparison));
  const ownerDir = chatAttachmentOwnerCacheDir(params.ownerId);
  const entries = await fs.readdir(ownerDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.name.endsWith('.bin') && !entry.name.endsWith('.bin.part')) continue;

    const filePath = path.join(ownerDir, entry.name);
    result.inspected += 1;
    try {
      const stat = await fs.lstat(filePath);
      if (stat.mtimeMs >= params.createdBeforeMs) continue;
      if (protectedPaths.has(normalizePathForComparison(filePath))) {
        result.protected += 1;
        continue;
      }
      await fs.unlink(filePath);
      result.removed += 1;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT') {
        log.warn('startup staged chat attachment sweep failed for file', {
          filePath,
          error: String(err),
        });
      }
    }
  }
  return result;
}

/** 路径身份前缀(不含 size/mtime):断线兜底按它捞最近副本。 */
function prefixHashFor(id: Pick<RemoteFileIdentity, 'transport' | 'endpointId' | 'workdir' | 'relPath'>): string {
  return createHash('sha1')
    .update([id.transport, id.endpointId, id.workdir, id.relPath].join('\n'))
    .digest('hex')
    .slice(0, 20);
}

/**
 * basename 消毒:远端 POSIX 文件名可合法包含 Windows 路径组件禁用字符
 * (`:` `?` `*` `<` `>` `"` `|` 及控制字符),直接拼进本地缓存路径会在
 * Windows 控制端创建 .part 文件时失败。唯一性由 hash 前缀保证,这段只是
 * 展示/扩展名用途,统一替换成 `_` 并去掉 Windows 禁止的结尾点/空格。
 */
function sanitizeBaseName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
}

/** 截短到 maxLen 且**保留扩展名**:缓存副本的应用内预览(xdt-file:// 白名单、
 *  图片/视频分派)按缓存文件名的扩展名判定,截断丢了 .png/.mp4 会 415。
 *  超长"扩展名"(最后一个点离结尾很远)按无扩展名处理,不为它牺牲主干。 */
function shortenKeepExt(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  const ext = path.extname(name);
  if (ext.length > 1 && ext.length <= 16) {
    return name.slice(0, Math.max(1, maxLen - ext.length)) + ext;
  }
  return name.slice(0, maxLen);
}

function cachePathFor(id: RemoteFileIdentity): string {
  // 两段式:<路径身份>-<size>-<mtime 取整>-<basename>。版本段变 = 新文件;
  // 前缀段稳定 = 断线时可按它找"最近一次成功取回的副本"。
  const base = shortenKeepExt(sanitizeBaseName(path.basename(id.relPath)) || 'file', 80);
  return path.join(cacheDir(), `${prefixHashFor(id)}-${id.size}-${Math.round(id.mtimeMs)}-${base}`);
}

/** 断线兜底:按路径身份前缀找最近的已缓存副本(可能不是最新版本)。 */
export async function findStaleCached(
  id: Pick<RemoteFileIdentity, 'transport' | 'endpointId' | 'workdir' | 'relPath'>,
): Promise<string | null> {
  const prefix = `${prefixHashFor(id)}-`;
  let names: string[];
  try {
    names = await fs.readdir(cacheDir());
  } catch {
    return null;
  }
  let best: { p: string; mtimeMs: number } | null = null;
  for (const n of names) {
    if (!n.startsWith(prefix) || n.endsWith('.part')) continue;
    try {
      const full = path.join(cacheDir(), n);
      const st = await fs.stat(full);
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { p: full, mtimeMs: st.mtimeMs };
    } catch {
      // 竞态删除,忽略
    }
  }
  return best?.p ?? null;
}

/** READ_CACHED 的路径守卫:只允许读缓存目录内的文件(挡 renderer 传任意路径)。 */
export function isInsideCacheDir(p: string): boolean {
  return path.resolve(p).startsWith(cacheDir() + path.sep);
}

/**
 * 小文件写穿:远程 inline 读成功后把内容写进磁盘缓存,让"断线看缓存"对
 * 大小文件语义一致(renderer 内存缓存不跨重启、容量仅 16MiB)。原子写
 * (.part → rename),失败静默——写穿是增益路径,不许影响主流程。
 */
export async function putCachedContent(id: RemoteFileIdentity, content: string): Promise<void> {
  try {
    const dest = cachePathFor(id);
    try {
      const st = await fs.stat(dest);
      if (st.size > 0) return; // 已有同版本副本
    } catch {
      // miss → 写入
    }
    await fs.mkdir(cacheDir(), { recursive: true });
    const tmp = `${dest}.part`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, dest);
  } catch (err) {
    log.debug('cache write-through failed', { relPath: id.relPath, error: String(err) });
  }
}

const inflight = new Map<string, Promise<string>>();

/**
 * 取回远程文件到本地缓存,返回缓存绝对路径。命中(size 一致)直接复用并
 * touch;未命中经 executor 写临时文件后原子 rename,再做 LRU 逐出。
 */
export async function fetchRemoteFileToCache(
  id: RemoteFileIdentity,
  executor: FetchExecutor,
  onProgress: FetchProgressFn,
): Promise<string> {
  const dest = cachePathFor(id);
  const existing = inflight.get(dest);
  if (existing) return existing;

  const run = (async () => {
    try {
      const st = await fs.stat(dest);
      if (st.size === id.size) {
        // 命中:touch 更新 LRU 位次,秒回。
        const now = new Date();
        await fs.utimes(dest, now, now).catch(() => undefined);
        onProgress(id.size, id.size);
        return dest;
      }
      await fs.rm(dest, { force: true });
    } catch {
      // miss
    }
    await fs.mkdir(cacheDir(), { recursive: true });
    const tmp = `${dest}.part`;
    try {
      await executor(tmp, onProgress);
      const got = await fs.stat(tmp);
      if (got.size !== id.size) {
        // 远端文件在取回途中变化(size 对不上)——废弃,让 caller 报错重试。
        throw new Error(`fetched size mismatch: got ${got.size}, expect ${id.size}`);
      }
      await fs.rename(tmp, dest);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
    // 新版本落地即清同路径旧版本(前缀同、文件名不同):被更新文件的历史
    // 副本不再占位等 LRU,断线兜底也只会捞到最新成功副本。
    void (async () => {
      const prefix = `${prefixHashFor(id)}-`;
      const names = await fs.readdir(cacheDir()).catch(() => [] as string[]);
      for (const n of names) {
        // .part 是并发取回(同路径新版本)的活跃临时文件,删了会让那次
        // rename 失败、更新中的文件回落旧内容——只清已完成的旧版本副本。
        if (n.endsWith('.part')) continue;
        if (n.startsWith(prefix) && path.join(cacheDir(), n) !== dest) {
          await fs.rm(path.join(cacheDir(), n), { force: true }).catch(() => undefined);
        }
      }
      await evictLru(dest);
    })().catch((err) => log.warn('cache cleanup failed', { error: String(err) }));
    return dest;
  })();

  inflight.set(dest, run);
  try {
    return await run;
  } finally {
    inflight.delete(dest);
  }
}

/**
 * Dangerous local chat attachments are copied here before entering renderer
 * state. The display name is retained separately, while the physical cache
 * filename always ends in `.bin` so a stale/open-by-path path cannot execute it.
 */
export async function stageLocalFileToCache(params: {
  ownerId: string;
  suggestedName: string;
  expectedSize: bigint;
  copyTo(targetPath: string): Promise<void>;
}): Promise<string> {
  const ownerDir = chatAttachmentOwnerCacheDir(params.ownerId);
  await fs.mkdir(ownerDir, { recursive: true });
  const base = shortenKeepExt(
    sanitizeBaseName(path.basename(params.suggestedName)) || 'attachment',
    80,
  );
  const dest = path.join(ownerDir, `${randomUUID()}-${base}.bin`);
  const tmp = `${dest}.part`;
  try {
    await params.copyTo(tmp);
    const got = await fs.stat(tmp, { bigint: true });
    if (!got.isFile() || got.size !== params.expectedSize) {
      throw new Error(
        `staged size mismatch: got ${got.size.toString()}, expect ${params.expectedSize.toString()}`,
      );
    }
    await fs.rename(tmp, dest);
    return dest;
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * 按 mtime(≈最近使用)逐出,直到总字节 ≤ 上限。
 * @param protectPath 本轮刚取回落地的文件:即便超上限也不逐出(mtime 最新
 *   不保证排序安全,被逐出会让刚等完下载的 cached 预览 / 本地打开当场 404),
 *   但其体积**计入总量**——其余文件按 LRU 正常回收,缓存实际占用最多为
 *   MAX + 保护文件超出部分(SSH 通路对单文件大小无上限是产品要求),不会
 *   随多次取回持续漂移超容。
 */
async function evictLru(protectPath?: string): Promise<void> {
  const dir = cacheDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const files: Array<{ p: string; size: number; mtimeMs: number }> = [];
  let total = 0;
  for (const n of names) {
    if (n.endsWith('.part')) continue;
    const full = path.join(dir, n);
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      total += st.size;
      // 保护文件计入 total,但不进删除候选。
      if (protectPath && full === protectPath) continue;
      files.push({ p: full, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // 竞态删除,忽略
    }
  }
  if (total <= MAX_CACHE_BYTES) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of files) {
    if (total <= MAX_CACHE_BYTES) break;
    try {
      await fs.rm(f.p, { force: true });
      total -= f.size;
      log.info('cache evicted', { file: path.basename(f.p), size: f.size });
    } catch {
      // 打开中被占用等,下轮再试
    }
  }
}

/** 启动清扫:补上"上次会话超容量但没再取回"的场景,顺带清残留 .part。 */
export async function sweepCacheOnStartup(): Promise<void> {
  const names = await fs.readdir(cacheDir()).catch(() => [] as string[]);
  for (const n of names) {
    if (n.endsWith('.part')) {
      await fs.rm(path.join(cacheDir(), n), { force: true }).catch(() => undefined);
    }
  }
  await evictLru().catch(() => undefined);
}

export const __cacheTesting = { cachePathFor, evictLru };
