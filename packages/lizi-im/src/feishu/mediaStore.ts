/**
 * feishu/mediaStore.ts
 * ---------------------------------------------------------------------------
 * Minimal local cache for feishu media (images / files). Backed by the
 * filesystem under `host.paths.feishuMediaDir`, with subdirectories `images/`
 * and `files/` matching `mediaCache.ts`'s URL convention.
 *
 * Cache key = feishu's image_key / file_key (globally unique tokens). Filename
 * pattern = `{token}{ext}`. Cache hit = file exists on disk.
 *
 * Intentionally simpler than @cindy/mcps's media store: no metadata JSON file,
 * no preview-image generation, no concurrency lock. Re-downloading an image
 * is cheap and rare; @cindy/im does not need to mirror every feature of the
 * desktop's MCP-side store.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getHost } from './moduleScope.js';

export interface MediaResult {
  /** Absolute path on disk. */
  absPath: string;
  /** Detected MIME type from the response headers. */
  mimeType: string;
  /** xdt-image:// URL the renderer / replyClient can reference. */
  xdtImageUrl: string;
  /** Bytes on disk. */
  bytes: number;
  /** Cache hit (no network I/O happened this call). */
  cached: boolean;
}

type Kind = 'image' | 'file';

export type Fetcher = (
  token: string,
) => Promise<{ buffer: Buffer; mimeType: string }>;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
};

function extFromMime(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? '';
}

function subdir(kind: Kind): string {
  return kind === 'image' ? 'images' : 'files';
}

function host(kind: Kind): string {
  return kind === 'image' ? 'feishu-media-images' : 'feishu-media-files';
}

function buildXdtUrl(kind: Kind, filename: string): string {
  return `xdt-image://${host(kind)}/${encodeURIComponent(filename)}`;
}

function findCachedFile(dir: string, token: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir);
  // Cache files are named `{token}{ext}` — first match wins. Token has the
  // feishu charset so substring match against the start is safe.
  const hit = entries.find(
    (n) => n.startsWith(token) && (n.length === token.length || n[token.length] === '.'),
  );
  return hit ? path.join(dir, hit) : null;
}

/** host 总仓能收的图片 mime(与 cindy-media blobStore 图片白名单对齐)。 */
const HOST_CACHEABLE_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export async function getOrDownload(
  token: string,
  kind: Kind,
  fetcher: Fetcher,
  givenExt?: string,
): Promise<MediaResult> {
  const mediaDir = getHost().paths.feishuMediaDir;
  const dir = path.join(mediaDir, subdir(kind));

  // 图片优先走 host 媒体总仓:token 命中免重下,miss 时下载
  // 后入仓;白名单外图片(bmp/svg)与非图片文件、host 仓故障统统回落老路径,
  // 不让缓存问题挡消息。字节只下载一次:入仓失败用手头字节落老目录(review P2)。
  const media = getHost().media;
  if (kind === 'image' && media) {
    try {
      const cached = await media.getCachedImage('feishu', token);
      if (cached) {
        const stat = fs.statSync(cached.absPath);
        return {
          absPath: cached.absPath,
          mimeType: cached.mimeType,
          xdtImageUrl: cached.url,
          bytes: stat.size,
          cached: true,
        };
      }
    } catch {
      // host 索引查询失败:继续走下面的老目录命中/下载路径。
    }
    // 老目录命中(迁移前已缓存 / 白名单外历史图):直接复用,不重下(review P2)。
    const legacyHit = findCachedFile(dir, token);
    if (legacyHit) {
      return legacyHitResult(legacyHit, kind);
    }
    const { buffer, mimeType } = await fetcher(token);
    const mime = mimeType.toLowerCase();
    if (HOST_CACHEABLE_IMAGE_MIMES.has(mime)) {
      try {
        const put = await media.cacheImage({ integration: 'feishu', token, buffer, mimeType: mime });
        return {
          absPath: put.absPath,
          mimeType: mime,
          xdtImageUrl: put.url,
          bytes: buffer.byteLength,
          cached: false,
        };
      } catch {
        // host 仓拒收/不可用:用手头字节落老目录,不二次下载。
      }
    }
    return writeToLegacyDir(dir, kind, token, buffer, mimeType, givenExt);
  }

  // Cache hit?
  const hit = findCachedFile(dir, token);
  if (hit) {
    return legacyHitResult(hit, kind);
  }

  // Miss — download.
  const { buffer, mimeType } = await fetcher(token);
  return writeToLegacyDir(dir, kind, token, buffer, mimeType, givenExt);
}

/** 老目录缓存命中 → MediaResult(mime 按扩展名反查,行为与迁移前一致)。 */
function legacyHitResult(hit: string, kind: Kind): MediaResult {
  const stat = fs.statSync(hit);
  const ext = path.extname(hit).toLowerCase();
  const mimeType =
    Object.entries(EXT_BY_MIME).find(([, e]) => e === ext)?.[0] ??
    'application/octet-stream';
  return {
    absPath: hit,
    mimeType,
    xdtImageUrl: buildXdtUrl(kind, path.basename(hit)),
    bytes: stat.size,
    cached: true,
  };
}

/** 老目录写盘(非图片文件 / host 仓不可用时的回落路径,行为与迁移前一致)。 */
function writeToLegacyDir(
  dir: string,
  kind: Kind,
  token: string,
  buffer: Buffer,
  mimeType: string,
  givenExt?: string,
): MediaResult {
  const ext = givenExt || extFromMime(mimeType) || '.bin';
  const filename = `${token}${ext}`;
  fs.mkdirSync(dir, { recursive: true });
  const absPath = path.join(dir, filename);
  fs.writeFileSync(absPath, buffer);
  return {
    absPath,
    mimeType,
    xdtImageUrl: buildXdtUrl(kind, filename),
    bytes: buffer.byteLength,
    cached: false,
  };
}

/**
 * Drain a Node `Readable` into a Buffer.
 *
 * `maxBytes` 提供增量上限(钉钉 readBodyLimited 同语义):超限立刻销毁流并抛
 * `ATTACHMENT_OVERSIZE`,调用方据此把附件归为 oversize —— 否则超大附件会先整只
 * 进内存(Electron main 的内存峰值与文件一样大)再被 30MB 检查拒掉。
 */
export const ATTACHMENT_OVERSIZE_CODE = 'ATTACHMENT_OVERSIZE';

export async function streamToBuffer(
  stream: NodeJS.ReadableStream,
  maxBytes?: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        const err = new Error(`stream exceeds ${maxBytes} bytes`) as Error & { code?: string };
        err.code = ATTACHMENT_OVERSIZE_CODE;
        throw err;
      }
      chunks.push(buf);
    }
  } catch (err) {
    // 超限/读失败时尽力停掉上游,避免它继续往已放弃的下载里推数据。
    // 不带 error 参数 destroy:迭代已抛出,此时若再 emit 'error' 而流上没有
    // 监听者,Node 会把它升级为 uncaught exception。
    (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    throw err;
  }
  return Buffer.concat(chunks);
}

/** Pull a `content-type` header (case-insensitive) and strip parameters. */
export function mimeFromHeaders(
  headers: Record<string, unknown> | undefined,
): string {
  if (!headers) return 'application/octet-stream';
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type') {
      const raw = Array.isArray(v) ? String(v[0]) : String(v);
      return raw.split(';')[0]!.trim() || 'application/octet-stream';
    }
  }
  return 'application/octet-stream';
}
