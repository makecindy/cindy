/**
 * feishu/attachmentDownloader.ts
 * ---------------------------------------------------------------------------
 * Take the AttachmentRef[] parsed by `incomingContent` → download via lark
 * `im.v1.messageResource.get` → 图片/音视频入 host 媒体总仓, 其余文件交 host
 * 文件暂存 → return standardised IMAttachment[] for emit upstream.
 *
 * Files larger than 30MB are dropped into `unsupported` (model + IPC can't
 * handle larger blobs sensibly). Per-attachment errors are isolated; a single
 * failed download does not block the rest.
 */

import fs from 'node:fs';
import path from 'node:path';
import type * as Lark from '@larksuiteoapi/node-sdk';
import type { Readable } from 'node:stream';

import type { IMAttachment } from '../types.js';
import { getHost, getLog } from './moduleScope.js';
import { audioVideoMimeOf, classifyInboundAttachment, type InboundKind } from '../inboundKind.js';
import { mimeFromHeaders, streamToBuffer } from './mediaStore.js';
import type {
  AttachmentRef,
  UnsupportedEntry,
} from './incomingContent.js';

/** Max bytes per attachment. Keeps parity with desktop's `MAX_FILE_SIZE`. */
export const MAX_FILE_SIZE = 30 * 1024 * 1024;

export interface DownloadResult {
  attachments: IMAttachment[];
  unsupported: UnsupportedEntry[];
}

export interface DownloadOptions {
  /**
   * 群历史上下文用(只进模型、不落库): 图片按可回收缓存写入(staging), 不复用
   * 也不固定已有缓存 —— 否则没有任务引用的 blob 永远不会被回收。
   */
  history?: boolean;
}

/** 下载期间账号已换代(登出/切号): 不写、已写的回滚 —— 旧账号附件不落进新账号目录。 */
class StaleAccountError extends Error {
  constructor() {
    super('account changed during download');
  }
}

export async function downloadAttachments(
  client: Lark.Client,
  messageId: string,
  refs: AttachmentRef[],
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const log = getLog();
  const attachments: IMAttachment[] = [];
  const unsupported: UnsupportedEntry[] = [];
  const scope = getHost().accountScope;
  const accountToken = scope?.capture();
  const ctx: DownloadContext = {
    history: options.history === true,
    assertAccountCurrent: () => {
      if (scope && !scope.isCurrent(accountToken)) throw new StaleAccountError();
    },
    discards: [],
  };

  for (const ref of refs) {
    try {
      const one = await downloadOne(client, ref.messageId ?? messageId, ref, ctx);
      if ('attachment' in one) attachments.push(one.attachment);
      else unsupported.push(one.unsupported);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const label =
        ref.kind === 'file'
          ? `下载失败 ${ref.fileName}（${msg}）`
          : `图片下载失败（${msg}）`;
      log.error('[feishu/attachmentDownloader] download failed:', err);
      unsupported.push({ type: `download_failed:${ref.kind}`, label });
    }
  }

  // 批次收口再核一次账号: 最后一项写入之后才换代时, 整批已写入的一并回滚 ——
  // 旧账号的附件不留给新账号, 也不交出一个会被丢弃的事件却留下写入。
  if (scope && !scope.isCurrent(accountToken)) {
    await Promise.all(ctx.discards.map((discard) => discard().catch(() => undefined)));
    return {
      attachments: [],
      unsupported: refs.map((ref) => ({
        type: `download_failed:${ref.kind}`,
        label: `${ref.kind === 'file' ? ref.fileName : '图片'} 下载已取消（账号已切换）`,
      })),
    };
  }
  return { attachments, unsupported };
}

interface DownloadContext {
  history: boolean;
  assertAccountCurrent: () => void;
  /** 本批已成功写入 host 的回滚句柄(批次收口时换代则整批回滚)。 */
  discards: Array<() => Promise<void>>;
}

/** 写入 host 后再复查账号; 已换代则回滚本次写入并按换代处理。 */
async function keepIfAccountCurrent<T>(
  ctx: DownloadContext,
  written: T,
  discard: (() => Promise<void>) | undefined,
): Promise<T> {
  try {
    ctx.assertAccountCurrent();
  } catch (err) {
    await discard?.().catch(() => undefined);
    throw err;
  }
  if (discard) ctx.discards.push(discard);
  return written;
}

type SingleResult =
  | { attachment: IMAttachment }
  | { unsupported: UnsupportedEntry };

/**
 * 单个附件: 图片与音视频入 cindy-media 总仓(host.media), 其余文件交 host 暂存
 * (host.files, 路由到任务后移入任务附件目录)。host 缺对应能力或总仓拒收格式时
 * 如实标不支持 —— 不写 `cc-agent/feishu-media`(冻结的历史兼容层, 只读)。
 */
async function downloadOne(
  client: Lark.Client,
  messageId: string,
  ref: AttachmentRef,
  ctx: DownloadContext,
): Promise<SingleResult> {
  const host = getHost();
  const label = ref.kind === 'file' ? ref.fileName : '图片';

  if (ref.kind === 'image') {
    const media = host.media;
    if (!media) return { unsupported: { type: 'image', label } };
    try {
      // 历史上下文不复用缓存: 命中会把 blob 固定为用户附件, 而这里不会有任务引用。
      const cached = ctx.history ? null : await media.getCachedImage('feishu', ref.imageKey);
      if (cached) {
        // 升级前的缓存可能存有超限图片(旧路径写入缓存后才按字节拒收): 命中也套同一上限。
        const cachedOversize = oversizeEntry(label, fs.statSync(cached.absPath).size);
        if (cachedOversize) return { unsupported: cachedOversize };
        return {
          attachment: {
            kind: 'image',
            absPath: cached.absPath,
            originalName: `${ref.imageKey}${path.extname(cached.absPath)}`,
            mimeType: cached.mimeType,
            url: cached.url,
          },
        };
      }
    } catch {
      // host 索引查询失败: 继续下载。
    }
    const { buffer, mimeType } = await fetchMessageResource(client, messageId, ref.imageKey, 'image');
    const oversize = oversizeEntry(label, buffer.byteLength);
    if (oversize) return { unsupported: oversize };
    return storeImage(ctx, media, ref.imageKey, buffer, mimeType.toLowerCase(), label, (absPath) =>
      `${ref.imageKey}${path.extname(absPath)}`,
    );
  }

  // 去处只由共用判据决定(视频消息恒为音视频; 其余 MIME 与扩展名任一命中)。没有受控
  // 去处就不下载: 图片/音视频要媒体总仓, 其余文件要文件暂存。
  const canStore = (kind: InboundKind['kind']): boolean =>
    kind === 'image' ? Boolean(host.media) : kind === 'av' ? Boolean(host.media?.cacheMedia) : Boolean(host.files);
  const unsupportedType = (kind: InboundKind['kind']): string =>
    kind === 'image' ? 'image' : kind === 'av' ? 'media' : 'file';
  const byName = ref.video ? 'av' : classifyInboundAttachment(undefined, ref.fileName).kind;
  if (!canStore(byName)) return { unsupported: { type: unsupportedType(byName), label } };
  if (ref.fileSize !== undefined && ref.fileSize > MAX_FILE_SIZE) {
    return { unsupported: oversizeEntry(label, ref.fileSize)! };
  }
  const { buffer, mimeType } = await fetchMessageResource(client, messageId, ref.fileKey, 'file');
  const oversize = oversizeEntry(label, buffer.byteLength);
  if (oversize) return { unsupported: oversize };
  const classified: InboundKind = ref.video
    ? { kind: 'av', mimeType: audioVideoMimeOf(mimeType, ref.fileName) ?? 'video/mp4' }
    : classifyInboundAttachment(mimeType, ref.fileName);
  if (!canStore(classified.kind)) return { unsupported: { type: unsupportedType(classified.kind), label } };

  if (classified.kind === 'image') {
    return storeImage(ctx, host.media!, ref.fileKey, buffer, classified.mimeType, label, () => ref.fileName);
  }

  if (classified.kind === 'av') {
    const cacheMedia = host.media?.cacheMedia;
    const avMime = classified.mimeType;
    if (cacheMedia) {
      try {
        ctx.assertAccountCurrent();
        const written = await cacheMedia({ integration: 'feishu', token: ref.fileKey, buffer, mimeType: avMime });
        const stored = await keepIfAccountCurrent(ctx, written, written.discard);
        return {
          attachment: {
            kind: 'file',
            absPath: stored.absPath,
            originalName: ref.fileName,
            mimeType: stored.mimeType,
            url: stored.url,
          },
        };
      } catch (err) {
        if (err instanceof StaleAccountError) throw err;
        // 总仓拒收该音视频格式(mkv / flac 等): 落到下方标不支持。
      }
    }
    // 音视频只进媒体总仓 —— 不论以视频消息还是普通文件发来, 都不回落文件暂存。
    return { unsupported: { type: 'media', label } };
  }

  ctx.assertAccountCurrent();
  const written = await host.files!.stage({ integration: 'feishu', buffer, fileName: ref.fileName });
  const staged = await keepIfAccountCurrent(ctx, written, written.discard);
  return {
    attachment: { kind: 'file', absPath: staged.absPath, originalName: ref.fileName, mimeType: classified.mimeType },
  };
}

/**
 * 图片入总仓: 收不收由 host 按真实字节核验决定(响应头常缺或给 octet-stream, 不在
 * 这里按头部预筛), 拒收标不支持; 附件 MIME 用 host 核验后的值。落库前一律可回收
 * 暂存(staging) —— 换代可回滚, 消息落库时由 host pin 成用户附件, 群历史(只进模型)
 * 则一直保持可回收。
 */
async function storeImage(
  ctx: DownloadContext,
  media: NonNullable<ReturnType<typeof getHost>['media']>,
  token: string,
  buffer: Buffer,
  mime: string,
  label: string,
  originalNameOf: (absPath: string) => string,
): Promise<SingleResult> {
  ctx.assertAccountCurrent();
  let written: Awaited<ReturnType<typeof media.cacheImage>>;
  try {
    written = await media.cacheImage({ integration: 'feishu', token, buffer, mimeType: mime, staging: true });
  } catch {
    return { unsupported: { type: 'image', label: `不支持的图片格式（${label}）` } };
  }
  const put = await keepIfAccountCurrent(ctx, written, written.discard);
  return {
    attachment: {
      kind: 'image',
      absPath: put.absPath,
      originalName: originalNameOf(put.absPath),
      mimeType: put.mimeType ?? mime,
      url: put.url,
    },
  };
}

function oversizeEntry(name: string, bytes: number): UnsupportedEntry | null {
  if (bytes <= MAX_FILE_SIZE) return null;
  const sizeMb = (bytes / 1024 / 1024).toFixed(1);
  return { type: 'oversize', label: `${name} 超过 30MB（实际 ${sizeMb}MB）` };
}

async function fetchMessageResource(
  client: Lark.Client,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = (await client.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  })) as unknown as {
    getReadableStream(): Readable;
    headers?: Record<string, unknown>;
  };

  const buffer = await streamToBuffer(res.getReadableStream());
  const mimeType = mimeFromHeaders(res.headers);
  return { buffer, mimeType };
}
