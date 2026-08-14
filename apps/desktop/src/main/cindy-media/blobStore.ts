/**
 * blobStore.ts — cindy-media 字节仓(内容寻址 blob store)。
 * ---------------------------------------------------------------------------
 * 本模块只管字节,不含任何含义:
 *   - 文件名 = SHA-256 指纹(**主机侧对字节计算**;外部/插件自称的指纹一律无效);
 *   - 落盘 `userData/cindy-media/blobs/<指纹前2位>/<指纹>.<ext>`——256 抽屉是
 *     纯性能分桶(防单目录数万文件变卡,同 git objects),无任何语义;
 *   - 幂等写:同内容重复写入直接命中既有文件(天然去重);
 *   - 文件永不改名、永不搬家:指纹跟内容走,归属变化只动账本(ledger.ts)。
 *
 * URL 形态:`cindy-media://blobs/<指纹>.<ext>`,指纹即地址,永久稳定。
 * 安全模型:resolveSafe 对 URL 做严格形状校验(指纹正则 + 扩展名白名单),
 * 输入字符串只当查找键,不参与任何路径拼接语义;解析结果再做仓内前缀双保险。
 */

import { app } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';

const SCHEME = 'cindy-media';
const HOST_BLOBS = 'blobs';

/** 指纹形状:SHA-256 十六进制,恰 64 位小写。 */
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * 扩展名白名单(含点)→ mime。新增媒体类型 = 加一行;后缀由主机按真实
 * mime 落盘时定死(决定渲染端 img/video/audio 分流),插件伪造不了。
 */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'model/gltf-binary': '.glb',
};

export interface WrittenBlob {
  /** SHA-256 十六进制指纹(64 位小写)。 */
  hash: string;
  /** 落盘扩展名(含点)。 */
  ext: string;
  mimeType: string;
  bytes: number;
  /** `cindy-media://blobs/<hash><ext>`。 */
  url: string;
  /** 命中既有文件(去重)时为 true——调用方可据此跳过重复记账里的 blob 行。 */
  deduplicated: boolean;
}

export function getBlobsRoot(): string {
  return path.join(app.getPath('userData'), 'cindy-media', 'blobs');
}

export function blobUrl(hash: string, ext: string): string {
  return `${SCHEME}://${HOST_BLOBS}/${hash}${ext}`;
}

export function supportedMime(mimeType: string): boolean {
  return Boolean(EXT_BY_MIME[mimeType]);
}

/** 白名单扩展名(含点)→ mime;白名单外返回 null(调用方自行拒绝)。 */
export function mimeForExt(ext: string): string | null {
  return MIME_BY_EXT[ext] ?? null;
}

/**
 * 写入一段字节:算指纹 → 分桶落盘(幂等)→ 返回指纹与地址。
 * 只写字节仓;账本记账(recordBlob/addRef)由调用方接着做。
 */
export async function writeBlob(params: {
  buffer: Uint8Array;
  mimeType: string;
}): Promise<WrittenBlob> {
  const { buffer, mimeType } = params;
  if (!buffer || buffer.byteLength === 0) {
    throw new Error('cindy-media: empty buffer');
  }
  const ext = EXT_BY_MIME[mimeType];
  if (!ext) {
    throw new Error(`cindy-media: unsupported mime type: ${mimeType}`);
  }

  const hash = createHash('sha256').update(buffer).digest('hex');
  const dir = path.join(getBlobsRoot(), hash.slice(0, 2));
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${hash}${ext}`);

  // 原子发布(review P1):先写同目录临时文件,再 link 到终点。直接 'wx' 写
  // 终点的问题:进程半写崩溃会在终点留下截断文件,之后同内容 ingest 全部
  // EEXIST 去重命中——内容寻址槽被永久毒化且无自愈;并发双写时后到者可能
  // 在首写者完成前就 resolveSafe 读到半截字节。改为 tmp+link 后,终点路径
  // 只会以完整字节出现;崩溃残留的只是 .tmp-* 垃圾(对账工具可辨识清理)。
  let deduplicated = false;
  const tmpPath = path.join(dir, `.tmp-${hash}-${process.pid}-${Date.now().toString(36)}`);
  await fs.writeFile(tmpPath, buffer, { flag: 'wx' });
  try {
    // link 原子且目标已存在必 EEXIST——内容寻址下同名必同内容,命中即去重。
    await fs.link(tmpPath, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') {
      deduplicated = true;
    } else {
      // 个别文件系统不支持硬链接(exFAT 等):退化为 rename 发布;目标已
      // 存在时 Windows rename 抛错、POSIX 覆盖同内容,两者都视为去重。
      const destExists = await fs.access(dest).then(
        () => true,
        () => false,
      );
      if (destExists) {
        deduplicated = true;
      } else {
        await fs.rename(tmpPath, dest);
      }
    }
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }

  return {
    hash,
    ext,
    mimeType,
    bytes: buffer.byteLength,
    url: blobUrl(hash, ext),
    deduplicated,
  };
}

/**
 * URL → 磁盘位置的唯一解析口(协议 handler / 供图接待员共用)。
 * 输入字符串只做形状校验后当作查找键;路径由本模块按指纹自行推导,
 * 最后再做"必须落在字节仓内"的前缀双保险。
 */
export function resolveSafe(url: string): { absPath: string; mimeType: string; hash: string } {
  const parsed = parseBlobUrl(url);
  if (!parsed) {
    throw new Error('cindy-media: invalid url');
  }
  return resolveHashRef(parsed.hash, parsed.ext);
}

/**
 * 指纹 + 扩展名 → 磁盘位置(供 cindy-ghost:// 供图分支等"手里已是指纹"的
 * 调用方使用,复用同一套校验与双保险)。
 */
export function resolveHashRef(hash: string, ext: string): {
  absPath: string;
  mimeType: string;
  hash: string;
} {
  if (!HASH_RE.test(hash)) {
    throw new Error('cindy-media: invalid hash');
  }
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) {
    throw new Error('cindy-media: unsupported ext');
  }
  const root = path.resolve(getBlobsRoot());
  const absPath = path.resolve(root, hash.slice(0, 2), `${hash}${ext}`);
  if (!absPath.startsWith(root + path.sep)) {
    throw new Error('cindy-media: path out of bounds');
  }
  return { absPath, mimeType, hash };
}

/** 解析 `cindy-media://blobs/<hash>.<ext>`;形状不合即 null(不抛)。 */
export function parseBlobUrl(url: string): { hash: string; ext: string } | null {
  if (typeof url !== 'string' || !url.startsWith(`${SCHEME}://`)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.hostname !== HOST_BLOBS ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    url.includes('?') ||
    url.includes('#')
  ) {
    return null;
  }
  const pathname = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
  const dotIdx = pathname.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  const hash = pathname.slice(0, dotIdx);
  const ext = pathname.slice(dotIdx).toLowerCase();
  if (!HASH_RE.test(hash) || !MIME_BY_EXT[ext]) return null;
  // URL 解析会规范化空 authority、空 port 与 dot segment；只接受本仓
  // 自己生成的字面地址，避免同一 immutable blob 有多个 Chromium cache key。
  if (url !== blobUrl(hash, ext)) return null;
  return { hash, ext };
}

export async function readFile(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const { absPath, mimeType } = resolveSafe(url);
  const buffer = await fs.readFile(absPath);
  return { buffer, mimeType };
}

// ── 回收器 / 对账底层能力(第 5 步)──────────────────────────────────────
// 本模块仍然只管字节:下面的枚举与删除不看账本,"该不该删"由 recycler.ts
// 按账本判定后才调用这里。

/** 字节仓枚举条目。 */
export interface BlobFileEntry {
  hash: string;
  ext: string;
  bytes: number;
  mtimeMs: number;
  absPath: string;
}

export interface BlobDirListing {
  entries: BlobFileEntry[];
  /** 命名不合内容寻址形状的文件/目录(指纹不合法、后缀不在白名单、桶前缀不符)——对账工具只报不删。 */
  strayPaths: string[];
  /** 写入中途崩溃残留的 `.tmp-*` 临时文件(writeBlob 原子发布的垃圾)。 */
  tmpFiles: string[];
}

const BUCKET_RE = /^[0-9a-f]{2}$/;

/** 遍历 256 个分桶,枚举字节仓全量文件(stat 失败的条目跳过,当作已消失)。 */
export async function listBlobFiles(): Promise<BlobDirListing> {
  const root = getBlobsRoot();
  const listing: BlobDirListing = { entries: [], strayPaths: [], tmpFiles: [] };
  let buckets: string[];
  try {
    buckets = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return listing; // 从未写入过
    throw err;
  }
  for (const bucket of buckets) {
    const bucketDir = path.join(root, bucket);
    if (!BUCKET_RE.test(bucket)) {
      listing.strayPaths.push(bucketDir);
      continue;
    }
    let names: string[];
    try {
      names = await fs.readdir(bucketDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = path.join(bucketDir, name);
      if (name.startsWith('.tmp-')) {
        listing.tmpFiles.push(abs);
        continue;
      }
      const dotIdx = name.lastIndexOf('.');
      const hash = dotIdx > 0 ? name.slice(0, dotIdx) : '';
      const ext = dotIdx > 0 ? name.slice(dotIdx).toLowerCase() : '';
      if (!HASH_RE.test(hash) || !MIME_BY_EXT[ext] || !hash.startsWith(bucket)) {
        listing.strayPaths.push(abs);
        continue;
      }
      try {
        const st = await fs.stat(abs);
        listing.entries.push({ hash, ext, bytes: st.size, mtimeMs: st.mtimeMs, absPath: abs });
      } catch {
        // 枚举与 stat 之间被删:视为不存在。
      }
    }
  }
  return listing;
}

/** 删除单个 blob 文件(recycler 在账删成功且复查无重录后才调用);不存在视为成功。 */
export async function deleteBlobFile(hash: string, ext: string): Promise<void> {
  const { absPath } = resolveHashRef(hash, ext);
  await fs.rm(absPath, { force: true });
}

/**
 * 超龄 `.tmp-*` 残留清单(报数与清理共用同一口径)。只算 mtime 早于
 * maxAgeMs 的——正在进行的 writeBlob 临时文件寿命是毫秒级,年龄门槛防
 * 误杀在途写入。
 */
export async function listStaleTmpFiles(maxAgeMs: number): Promise<string[]> {
  const { tmpFiles } = await listBlobFiles();
  const cutoff = Date.now() - maxAgeMs;
  const stale: string[] = [];
  for (const abs of tmpFiles) {
    try {
      const st = await fs.stat(abs);
      if (st.mtimeMs < cutoff) stale.push(abs);
    } catch {
      // 已消失:不算。
    }
  }
  return stale;
}

/** 清理写入中途崩溃残留的超龄 `.tmp-*` 文件,返回删除数。 */
export async function cleanupTmpFiles(maxAgeMs: number): Promise<number> {
  let removed = 0;
  for (const abs of await listStaleTmpFiles(maxAgeMs)) {
    try {
      await fs.rm(abs, { force: true });
      removed++;
    } catch {
      // 被占用:留给下次。
    }
  }
  return removed;
}
