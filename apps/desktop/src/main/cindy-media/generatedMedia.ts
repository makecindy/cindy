/**
 * generatedMedia.ts — AI 生成产物(art / mivo / codex 生成图)的媒体总仓存储适配器。
 * ---------------------------------------------------------------------------
 * 契约:docs/dev-rules/media-storage-and-protocols.md。
 *
 * 形状对齐 @cindy/mcps 的 art 存储契约(`storage.saveImage/resolveImageRef`、
 * `videoStorage.saveVideo`),替换 `createArtMediaStore/createArtVideoStore`
 * 的文件目录实现——mivo 与 MJ 按钮链路复用 art 注入的同一套存储,换这一处
 * 三条链全切。返回字段名(`xdtImageUrl`/`xdtVideoUrl`)保持不变,值变为
 * `cindy-media://blobs/<hash>.<ext>`;tool result JSON 的 `xdt_image_url(s)`
 * 等**字段名**由 @cindy/mcps 拼装,不受影响(renderer 按字段名提取)。
 *
 * 记账口径:生成时**零引用入仓**(art service 是无会话上下文的单例,拿不到
 * sessionId)——归属在消息落库的唯一汇聚点(localDb createMessage)由
 * commitChatImageUrls 统一挂 session-attachment 引用;落库前的零引用窗口受
 * recycler.ts 的「零引用≠无主」不变量保护。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import * as blobStore from './blobStore.desktop';
import { ingestMedia } from './ingest';
import type { LedgerDb } from './ledger';
import { sniffMediaMime } from './sniffMediaMime';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile';

/** 与 @cindy/mcps SavedImage 结构对齐(structural typing,不 import 包内类型)。 */
export interface SavedBlobImage {
  fileId: string;
  filename: string;
  originalPath: string;
  xdtImageUrl: string;
  bytes: number;
}

export interface SavedBlobVideo {
  fileId: string;
  filename: string;
  originalPath: string;
  xdtVideoUrl: string;
  bytes: number;
  mime: string;
}

async function assertOnDisk(absPath: string, ref: string): Promise<void> {
  try {
    await fs.access(absPath);
  } catch {
    throw new Error(`art: referenced image missing on disk: ${ref}`);
  }
}

/**
 * 图片存储适配器:saveImage 入总仓(零引用),resolveImageRef 三分支——
 * 媒体总仓 blob 地址 / 历史 xdt-image 地址(改图的源图可能是历史图)/
 * 绝对路径(用户 @ 的本地图)。
 */
export function createBlobImageStorage(
  opts: {
    /** 历史 xdt-image:// 地址 → 绝对路径(真身 imageCacheStore.resolveSafe;只读兼容层)。 */
    resolveLegacyImageRef: (ref: string) => { absPath: string };
  },
  db?: LedgerDb,
): {
  saveImage(b64: string, mime?: string): Promise<SavedBlobImage>;
  resolveImageRef(ref: string): Promise<string>;
} {
  async function saveImage(b64: string, mime?: string): Promise<SavedBlobImage> {
    if (typeof b64 !== 'string' || b64.length === 0) {
      throw new Error('art: empty base64 payload');
    }
    if (!mime) {
      throw new Error('art: storage mime is required');
    }
    const buffer = Buffer.from(b64, 'base64');
    if (buffer.byteLength === 0) {
      throw new Error('art: base64 decoded to empty buffer');
    }
    const written = await ingestMedia({ buffer, mimeType: mime, refs: [] }, db);
    const originalPath = blobStore.resolveSafe(written.url).absPath;
    return {
      fileId: written.hash,
      filename: `${written.hash}${written.ext}`,
      originalPath,
      xdtImageUrl: written.url,
      bytes: written.bytes,
    };
  }

  async function resolveImageRef(ref: string): Promise<string> {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new Error('art: empty image reference');
    }
    if (ref.startsWith('cindy-media://')) {
      const { absPath } = blobStore.resolveSafe(ref);
      await assertOnDisk(absPath, ref);
      return absPath;
    }
    if (ref.startsWith('xdt-image://')) {
      const { absPath } = opts.resolveLegacyImageRef(ref);
      await assertOnDisk(absPath, ref);
      return absPath;
    }
    if (path.isAbsolute(ref)) {
      try {
        await fs.access(ref);
      } catch {
        throw new Error(`art: file not found: ${ref}`);
      }
      return ref;
    }
    throw new Error(`art: unsupported image reference: ${ref}`);
  }

  return { saveImage, resolveImageRef };
}

/**
 * 生成视频的 mime 归一化(review P1):上游 HTTP 头的 content-type 不可信
 * ——OSS 签名 URL 常见 `application/octet-stream`、或带 `; charset=` 参数。writeBlob 是
 * 精确白名单会硬抛,长任务(2-10 分钟、钱已花)在最后一步失败不可接受,
 * 所以闻不出来的字节仍兜底 video/mp4。
 *
 * 先闻字节(与 xAI 下载同一个 sniffMediaMime):闻出 video/* 就用闻出的结果,
 * 不信任上游头。错误页 / JSON 不是容器,sniff 认不出它们,但也不能兜底成 mp4
 * ——那会让用户看到成功、播放是黑屏。图片/音频/模型字节不在这里报错,
 * 闻不出视频时维持调用方原来的声明。
 */
const GENERATED_VIDEO_BODY_PREVIEW_BYTES = 64;

function generatedVideoBodyPreview(buffer: Uint8Array): string {
  const slice = buffer.subarray(0, Math.min(buffer.byteLength, GENERATED_VIDEO_BODY_PREVIEW_BYTES));
  let text = '';
  for (const byte of slice) {
    text += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
  }
  return text;
}

const GENERATED_VIDEO_ERROR_PREFIXES = ['<!doctype', '<html', '{', '[', '<?xml', '<error'] as const;

function isGeneratedVideoAsciiSpace(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function generatedVideoAsciiAt(buffer: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || buffer.byteLength < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (buffer[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function findGeneratedVideoAscii(buffer: Uint8Array, offset: number, text: string): number {
  const last = buffer.byteLength - text.length;
  for (let i = Math.max(0, offset); i <= last; i += 1) {
    if (generatedVideoAsciiAt(buffer, i, text)) return i;
  }
  return -1;
}

/**
 * 错误页 / JSON / XML 正文。先跳过 BOM、空白和前置 HTML 注释,再只认开头,
 * 避免把视频里碰巧出现的字符当成错误页。注释没有闭合就不把后面的字节当成正文开头。
 */
function looksLikeGeneratedVideoErrorBody(buffer: Uint8Array): boolean {
  let offset = 0;
  if (buffer.byteLength >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    offset = 3;
  }
  while (offset < buffer.byteLength) {
    while (offset < buffer.byteLength && isGeneratedVideoAsciiSpace(buffer[offset])) offset += 1;
    if (!generatedVideoAsciiAt(buffer, offset, '<!--')) break;
    const end = findGeneratedVideoAscii(buffer, offset + 4, '-->');
    if (end < 0) return false;
    offset = end + 3;
  }
  const head = buffer.subarray(offset, Math.min(buffer.byteLength, offset + 16));
  const ascii = generatedVideoBodyPreview(head).toLowerCase();
  return GENERATED_VIDEO_ERROR_PREFIXES.some((prefix) => ascii.startsWith(prefix));
}

/**
 * 入仓前的视频类型。返回 null 表示「不是可判定的视频」:调用方继续用自己的声明。
 * 错误页 / JSON 直接抛。错误信息只留分类和上游声明,不附正文,避免签名 URL 和响应内容进日志。
 */
export function sniffGeneratedVideoMime(buffer: Uint8Array, declaredMime: string): string | null {
  const sniffed = sniffMediaMime(buffer, declaredMime);
  if (sniffed?.startsWith('video/')) return sniffed;
  if (looksLikeGeneratedVideoErrorBody(buffer)) {
    throw new Error(`生成视频不是受支持的视频(实际是错误页或 JSON,上游声明 ${declaredMime || '缺失'})`);
  }
  return null;
}

export function resolveGeneratedVideoMime(buffer: Uint8Array, declaredMime: string): string {
  return sniffGeneratedVideoMime(buffer, declaredMime) ?? normalizeGeneratedVideoMime(declaredMime);
}

export function normalizeGeneratedVideoMime(raw: string): string {
  const m = raw.split(';')[0].trim().toLowerCase();
  if (m.startsWith('video/') && blobStore.supportedMime(m)) return m;
  return 'video/mp4';
}

/** 视频存储适配器:saveVideo 入总仓(零引用),字段形状对齐 @cindy/mcps SavedVideo。 */
export function createBlobVideoStorage(db?: LedgerDb): {
  saveVideo(buffer: Buffer, mime: string): Promise<SavedBlobVideo>;
} {
  async function saveVideo(buffer: Buffer, mime: string): Promise<SavedBlobVideo> {
    if (!buffer || buffer.byteLength === 0) {
      throw new Error('art: empty video buffer');
    }
    if (!mime) {
      throw new Error('art: storage mime is required');
    }
    const written = await ingestMedia(
      { buffer, mimeType: resolveGeneratedVideoMime(buffer, mime), refs: [] },
      db,
    );
    const originalPath = blobStore.resolveSafe(written.url).absPath;
    return {
      fileId: written.hash,
      filename: `${written.hash}${written.ext}`,
      originalPath,
      xdtVideoUrl: written.url,
      bytes: written.bytes,
      mime: written.mimeType,
    };
  }
  return { saveVideo };
}

// ── codex 生成图物化(register.ts 的 thin adapter 调用,规则 14:逻辑在此可测)──

export interface GeneratedImageSource {
  data?: string;
  url?: string;
  path?: string;
  pathOrigin?: 'remote-agent';
}

export const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;

/** Decode only in the Host. Declared MIME and filename do not establish the image type. */
export function generatedImageBytes(data: GeneratedImageSource): { mimeType: string; buffer: Buffer } | null {
  const encoded = data.data ?? (data.url?.startsWith('data:')
    ? /^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]*)$/.exec(data.url)?.[1]
    : undefined);
  if (encoded === undefined) return null;
  if (encoded.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 4096)
    throw new Error('MEDIA_TOO_LARGE');
  const compact = encoded.replace(/\s/g, '');
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1)
    throw new Error('INVALID_IMAGE');
  const buffer = Buffer.from(compact, 'base64');
  if (buffer.length > MAX_GENERATED_IMAGE_BYTES) throw new Error('MEDIA_TOO_LARGE');
  if (buffer.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, ''))
    throw new Error('INVALID_IMAGE');
  const mimeType = sniffMediaMime(buffer);
  if (!mimeType?.startsWith('image/')) throw new Error('INVALID_IMAGE');
  return { buffer, mimeType };
}

/** Read on the machine that owns the native file, before crossing the transport boundary. */
export async function readGeneratedImageFile(sourcePath: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (/^[\\/]{2}|^[\\/]\?\?[\\/]/.test(sourcePath)) throw new Error('INVALID_IMAGE_SOURCE');
  const buffer = await readBoundedFileNoFollow(sourcePath, MAX_GENERATED_IMAGE_BYTES, { nonBlocking: true });
  if (!buffer?.length) throw new Error('INVALID_IMAGE_SOURCE');
  const mimeType = sniffMediaMime(buffer);
  if (!mimeType?.startsWith('image/')) throw new Error('INVALID_IMAGE');
  return { buffer, mimeType };
}

/** 从 URL / 路径推导展示文件名;推不出兜底 generated-image.png。 */
export function safeGeneratedImageFilename(raw: string): string {
  try {
    const parsed =
      raw.startsWith('xdt-image://') || raw.startsWith('cindy-media://')
        ? new URL(raw).pathname
        : raw;
    const base = path.basename(decodeURIComponent(parsed));
    if (base && path.extname(base)) return base;
  } catch {
    // fall through
  }
  return 'generated-image.png';
}

/**
 * codex 生成图 → 总仓物化:托管地址先核验当前 Host 的文件，再复用;
 * 本地路径 / data: base64 入仓(零引用,合成 tool_result 落库时挂账)。
 * 形状不认识返回 null;入仓失败(白名单外 mime / 读盘失败)向上抛,由调用方
 * 决定丢图语义。
 */
export async function materializeGeneratedImage(
  data: GeneratedImageSource,
  deps: {
    verifyManagedUrl: (url: string) => Promise<void>;
    ingestFromPath: (params: { sourcePath: string; originalName?: string }) => Promise<{ url: string; filename: string }>;
    ingestBuffer: (params: { buffer: Uint8Array; mimeType: string }) => Promise<{ url: string; filename: string }>;
  },
): Promise<{ url: string; filename: string } | null> {
  const bytes = generatedImageBytes(data);
  if (bytes) return deps.ingestBuffer(bytes);
  // A remote path is recovery metadata, never permission to read this Host's filesystem.
  if (data.pathOrigin === 'remote-agent') throw new Error('REMOTE_SOURCE_REQUIRED');
  if (data.url?.startsWith('xdt-image://') || data.url?.startsWith('cindy-media://')) {
    try {
      await deps.verifyManagedUrl(data.url);
    } catch (error) {
      // Some harnesses supply both a stale reference and the actual generated file.
      if (!data.path) throw error;
      return deps.ingestFromPath({ sourcePath: data.path, originalName: safeGeneratedImageFilename(data.path) });
    }
    return { url: data.url, filename: safeGeneratedImageFilename(data.url) };
  }
  if (data.path) {
    return deps.ingestFromPath({
      sourcePath: data.path,
      originalName: safeGeneratedImageFilename(data.path),
    });
  }
  return null;
}
