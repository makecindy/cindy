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

import * as blobStore from './blobStore';
import { ingestMedia } from './ingest';
import type { LedgerDb } from './ledger';

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
 * 生成视频的 mime 归一化(review P1):video provider 把上游 HTTP 头的
 * content-type 原样透传——OSS 签名 URL 常见 `application/octet-stream`、或带
 * `; charset=` 参数,老实现(createVideoFilename)对未知 mime 兜底 .mp4。
 * writeBlob 是精确白名单会硬抛,长任务(2-10 分钟、钱已花)在最后一步失败
 * 不可接受,这里对齐老容错:剥参数 + 小写;非白名单视频 mime 兜底 video/mp4。
 */
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
      { buffer, mimeType: normalizeGeneratedVideoMime(mime), refs: [] },
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
  url?: string;
  path?: string;
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

function parseDataImageUrl(url: string): { mimeType: string; buffer: Buffer } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(url);
  if (!match) return null;
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
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
  if (data.url?.startsWith('data:')) {
    const parsed = parseDataImageUrl(data.url);
    if (!parsed) return null;
    return deps.ingestBuffer({ buffer: parsed.buffer, mimeType: parsed.mimeType });
  }
  return null;
}
