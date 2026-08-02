/**
 * outboundMedia.ts — 控制端出方向附件:把远程会话消息里的本机附件上传 OSS,
 * 把 block 的 path/url 替换成 OSS 引用串(随 invoke 走 relay,bytes 不内联)。
 * ---------------------------------------------------------------------------
 * 在 device-link handleInvoke 里、deps.invoke 之前对 maker:send / maker:steer /
 * maker:input:enqueue 调用(这些 channel 才携带用户消息附件)。失败抛错 → handleInvoke
 * 转 throwIpcError(DEVICE_LINK_MEDIA_TRANSFER_FAILED) → 整条消息不发(产品决策)。
 *
 * 被控端 normalizeUserMessage 识别 OSS 引用串 → presign-get 下载 → 物化喂 agent。
 *
 * 附件来源(控制端本机):xdt-image:// 缓存 URL / 绝对 fs 路径 / 内存 base64。
 */
import { promises as fsp } from 'node:fs';

import { createLogger } from '../logger';
import * as imageCacheStore from '../imageCacheStore';
import * as cindyMediaBlobStore from '../cindy-media/blobStore';
import { uploadLocalFile, uploadBuffer, type UploadResult } from './mediaTransfer';
import {
  OUTBOUND_IMAGE_INPUT_MAX_BYTES,
  compressOutboundImage,
  mayCompressOutboundImage,
} from './outboundImageCompress';
import { buildLegacyAttachmentOssRef, parseAttachmentOssRef } from '../../shared/attachmentOssRef';

const log = createLogger('device-link:outboundMedia');

/**
 * 携带用户消息附件、需在发往远程前上传 OSS 的 channel。
 *  - maker:send / maker:steer:message 形态(content-block),走 rewriteMessage。
 *  - maker:input:enqueue / maker:input:steer:AgentInputQueuedMessage 形态(files[]),走 rewriteQueued。
 *    (steerMessage 经 input.steer 投递带附件的 queued item,与 enqueue 同形态,必须同样改写。)
 */
const MESSAGE_SHAPE_CHANNELS = new Set(['maker:send', 'maker:steer']);
const QUEUED_SHAPE_CHANNELS = new Set(['maker:input:enqueue', 'maker:input:steer']);

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

interface AttachmentSource {
  name?: unknown;
  url?: unknown;
  path?: unknown;
  base64?: unknown;
  mimeType?: unknown;
  originalName?: unknown;
  /** message 形态 block 携带的原始磁盘路径(见 renderer SdkAttachmentBlock.originalPath)。 */
  originalPath?: unknown;
}

/** 把上传结果完整写入端到端引用，确保接收端校验的是实际上传字节。 */
function buildUploadedAttachmentRef(
  result: UploadResult,
  originalName: string | undefined,
): string {
  return buildLegacyAttachmentOssRef({
    ossKey: result.key,
    mimeType: result.contentType,
    originalName,
    size: result.size,
    sha256: result.sha256,
  });
}

function persistedIntegrityFields(
  ref: string,
): { size: number; sha256: string } | Record<string, never> {
  const parsed = parseAttachmentOssRef(ref);
  return parsed?.size === undefined ? {} : { size: parsed.size, sha256: parsed.sha256! };
}

/** 把一个附件源上传 OSS,返回 OSS 引用串。无可用来源 / 上传失败 → 抛错。 */
async function uploadAttachment(src: AttachmentSource): Promise<string> {
  const mimeType = typeof src.mimeType === 'string' ? src.mimeType : undefined;
  const originalName =
    typeof src.originalName === 'string' && src.originalName
      ? src.originalName
      : typeof src.name === 'string' && src.name
        ? src.name
        : undefined;

  // 1) 内存 base64(剪贴板/截图,视觉上下文语义)→ 压缩 → uploadBuffer(不把字节内联进 relay)
  if (typeof src.base64 === 'string' && src.base64) {
    const raw = Buffer.from(src.base64, 'base64');
    // 输入体量护栏与 xdt-image 路径同口径:软超时只是不等结果、并不打断 libvips
    // 解码,病态大图进 sharp 仍会拉高 main 进程 CPU/内存,超限直接原字节上传。
    const compressed =
      raw.byteLength <= OUTBOUND_IMAGE_INPUT_MAX_BYTES
        ? await compressOutboundImage(raw, mimeType)
        : null;
    const ext = compressed?.ext ?? (mimeType && EXT_BY_MIME[mimeType]) ?? 'bin';
    const r = await uploadBuffer(compressed?.bytes ?? raw, {
      ext,
      contentType: compressed?.contentType ?? mimeType,
    });
    return buildUploadedAttachmentRef(r, originalName);
  }

  // 2) url / path → 解析成本地绝对路径后流式上传
  const url = typeof src.url === 'string' && src.url ? src.url : '';
  const rawPath = typeof src.path === 'string' && src.path ? src.path : '';
  const ref = url || rawPath;
  if (!ref) throw new Error('附件无可用来源(url/path/base64 皆空)');
  if (ref.startsWith('clipboard://')) throw new Error('附件为 clipboard 占位,无字节');

  // 2a) xdt-image:// 缓存 → 视觉上下文语义(截图/剪贴板/生成图)压缩后 uploadBuffer;
  //     压不动(显式文件/格式直通/无收益/sharp 失败)时回退原文件流式上传。
  if (ref.startsWith('xdt-image://')) {
    const resolved = imageCacheStore.resolveSafe(ref);
    const effectiveMime = mimeType ?? resolved.mimeType;
    // 用户经文件选择器/拖拽显式添加的图片,renderer 拷进 image cache 后 url 与原始
    // 磁盘 path 双双保留(buildAttachmentBlock/buildMakerUserMessage 优先取 url)——
    // 附件同时带纯磁盘 path 即显式文件,「字节精确」语义,不压;剪贴板是 clipboard://
    // 占位、截图/生成图没有 plain path,不受影响。
    // 双形态判别:队列形态 files[] 的 path 字段 / message 形态 block 的 originalPath
    // 字段,二者任一携带纯磁盘路径即显式文件。
    const originalPath =
      typeof src.originalPath === 'string' && src.originalPath ? src.originalPath : '';
    const explicitCandidate = originalPath || rawPath;
    const explicitFile =
      !!explicitCandidate &&
      explicitCandidate !== ref &&
      !explicitCandidate.startsWith('clipboard://') &&
      !explicitCandidate.startsWith('xdt-image://');
    // gif/webp/未知 mime 的压缩 plan 恒为 null:整读进内存只会原样丢弃、再流式重读
    // 一遍(动图可达数十 MB),先按 mime 判定可压才读盘;可压的也先 stat 把关体量,
    // 病态大图直接走流式上传,不把整份文件读进 main 进程内存(uploadLocalFile 是流式的)。
    let compressed: Awaited<ReturnType<typeof compressOutboundImage>> = null;
    if (!explicitFile && mayCompressOutboundImage(effectiveMime)) {
      try {
        const st = await fsp.stat(resolved.absPath);
        if (st.size > 0 && st.size <= OUTBOUND_IMAGE_INPUT_MAX_BYTES) {
          compressed = await compressOutboundImage(
            await fsp.readFile(resolved.absPath),
            effectiveMime,
          );
        }
      } catch {
        // 读文件失败不在这里报:交给下面 uploadLocalFile 用同一路径产生原有错误语义。
      }
    }
    if (compressed) {
      const r = await uploadBuffer(compressed.bytes, {
        ext: compressed.ext,
        contentType: compressed.contentType,
      });
      return buildUploadedAttachmentRef(r, originalName);
    }
    // 显式文件也从缓存副本上传(字节与原文件一致,且不依赖原路径此刻仍存在)。
    const r = await uploadLocalFile(
      resolved.absPath,
      effectiveMime ? { contentType: effectiveMime } : {},
    );
    return buildUploadedAttachmentRef(r, originalName);
  }

  // 2a') cindy-media:// 媒体总仓 blob(统一地址,规则 25):图片沿用
  //      视觉上下文语义压缩后上传;视频/音频/模型等其余类型流式原样上传。
  //      blob 是内容寻址缓存副本,不存在 xdt-image 分支的「显式文件」歧义。
  if (ref.startsWith('cindy-media://')) {
    const resolved = cindyMediaBlobStore.resolveSafe(ref);
    const effectiveMime = mimeType ?? resolved.mimeType;
    let compressed: Awaited<ReturnType<typeof compressOutboundImage>> = null;
    if (mayCompressOutboundImage(effectiveMime)) {
      try {
        const st = await fsp.stat(resolved.absPath);
        if (st.size > 0 && st.size <= OUTBOUND_IMAGE_INPUT_MAX_BYTES) {
          compressed = await compressOutboundImage(
            await fsp.readFile(resolved.absPath),
            effectiveMime,
          );
        }
      } catch {
        // 同 xdt-image 分支:读失败交给下面 uploadLocalFile 报原有错误语义。
      }
    }
    if (compressed) {
      const r = await uploadBuffer(compressed.bytes, {
        ext: compressed.ext,
        contentType: compressed.contentType,
      });
      return buildUploadedAttachmentRef(r, originalName);
    }
    const r = await uploadLocalFile(resolved.absPath, { contentType: effectiveMime });
    return buildUploadedAttachmentRef(r, originalName);
  }

  // 2b) 用户显式给出的磁盘路径附件是「字节精确」语义(素材/设计稿/文档),不压,原样上传。
  const r = await uploadLocalFile(ref, mimeType ? { contentType: mimeType } : {});
  return buildUploadedAttachmentRef(r, originalName);
}

function isAttachmentBlock(b: unknown): b is AttachmentSource & { type: string } {
  return (
    !!b &&
    typeof b === 'object' &&
    ((b as { type?: unknown }).type === 'image' || (b as { type?: unknown }).type === 'file')
  );
}

function sourceRefKey(src: AttachmentSource): string {
  return typeof src.url === 'string' && src.url
    ? src.url
    : typeof src.path === 'string' && src.path
      ? src.path
      : '';
}

async function uploadAttachmentOnce(
  src: AttachmentSource,
  refMap: Map<string, string>,
): Promise<string> {
  const key = sourceRefKey(src);
  const cached = key ? refMap.get(key) : undefined;
  if (cached) return cached;
  const ref = await uploadAttachment(src);
  if (key) refMap.set(key, ref);
  return ref;
}

/** 改写 send/steer 的 message(content-block 形态)。无附件 → 原样。 */
async function rewriteMessage(
  message: unknown,
  refMap: Map<string, string> = new Map(),
): Promise<unknown> {
  if (!message || typeof message !== 'object') return message; // string / null:无附件
  const m = message as { type?: unknown; content?: unknown };
  if (m.type !== 'user' || !Array.isArray(m.content)) return message;
  const content: unknown[] = [];
  for (const raw of m.content) {
    if (isAttachmentBlock(raw)) {
      const ref = await uploadAttachmentOnce(raw, refMap);
      const originalName =
        typeof raw.originalName === 'string' && raw.originalName
          ? raw.originalName
          : typeof raw.name === 'string' && raw.name
            ? raw.name
            : undefined;
      content.push({
        type: raw.type,
        path: ref,
        mimeType: raw.mimeType,
        ...(originalName ? { originalName } : {}),
      });
    } else {
      content.push(raw);
    }
  }
  return { ...m, content };
}

/**
 * 改写 persistedContent(JSON 串 `{text, images:[{url,...}], files:[{name,path}]}`)里的附件引用,
 * 用 refMap(原始 url/path → OSS 引用)替换。images 的引用在 `url`,files 的在 `path`(字段不对称)。
 * 解析失败 / 无匹配 → 原样返回(降级)。refMap 由 files[] 上传时建立,保证同一附件只传一次 OSS。
 */
function rewritePersistedContent(json: string, refMap: Map<string, string>): string {
  let parsed: { text?: unknown; images?: unknown; files?: unknown };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return json;
  }
  if (!parsed || typeof parsed !== 'object') return json;
  let changed = false;
  if (Array.isArray(parsed.images)) {
    parsed.images = parsed.images.map((im) => {
      const url = im && typeof im === 'object' ? (im as { url?: unknown }).url : undefined;
      if (typeof url === 'string') {
        const ref = refMap.get(url);
        if (ref) {
          changed = true;
          return { ...(im as object), url: ref, ...persistedIntegrityFields(ref) };
        }
      }
      return im;
    });
  }
  if (Array.isArray(parsed.files)) {
    parsed.files = parsed.files.map((fl) => {
      const p = fl && typeof fl === 'object' ? (fl as { path?: unknown }).path : undefined;
      if (typeof p === 'string') {
        const ref = refMap.get(p);
        if (ref) {
          changed = true;
          return { ...(fl as object), path: ref, ...persistedIntegrityFields(ref) };
        }
      }
      return fl;
    });
  }
  return changed ? JSON.stringify(parsed) : json;
}

/**
 * 改写 enqueue/steer 的 item(AgentInputQueuedMessage)。同一附件在 item 里有两副身:
 *  - `files[]`(buildMakerUserMessage 读 f.url → 喂 agent);
 *  - `persistedContent`(JSON 串 → 落被控端 DB,reload 后据此渲染历史)。
 * 两者必须改成**同一批** OSS 引用,否则被控端物化了 files[]、persistedContent 仍是控制端本机路径 →
 * 被控端 reload 历史裂图(PR #166 review)。chatMessage 在被控端不落库/不广播,无需改。
 * 去重:每个附件按其 url/path 标识只上传一次 OSS,files[] 与 persistedContent 共用同一引用。
 */
async function rewriteQueued(item: unknown): Promise<unknown> {
  if (!item || typeof item !== 'object') return item;
  const it = item as { files?: unknown; persistedContent?: unknown };
  if (!Array.isArray(it.files) || it.files.length === 0) return item; // 无 files[] → 无附件

  // 原始 ref(url 或 path 字符串)→ OSS 引用;同一附件只传一次,供 files[] + persistedContent 复用。
  const refMap = new Map<string, string>();

  const files: unknown[] = [];
  for (const f of it.files) {
    if (
      f &&
      typeof f === 'object' &&
      ((f as AttachmentSource).url ||
        (f as AttachmentSource).path ||
        (f as AttachmentSource).base64)
    ) {
      const ref = await uploadAttachmentOnce(f as AttachmentSource, refMap);
      // url 优先被 buildMakerUserMessage 取用;清掉 base64 避免把字节内联进 relay。
      files.push({
        ...(f as object),
        url: ref,
        path: ref,
        base64: undefined,
        ...persistedIntegrityFields(ref),
      });
    } else {
      files.push(f);
    }
  }

  // persistedContent 用同一批 OSS 引用改写(按原始 url/path 匹配 refMap);被控端物化时落本地路径。
  const persistedContent =
    typeof it.persistedContent === 'string'
      ? rewritePersistedContent(it.persistedContent, refMap)
      : it.persistedContent;

  return { ...(it as object), files, persistedContent };
}

/**
 * 出方向附件改写入口:仅对携带附件的 channel 处理,返回新 args(不原地改 caller 数组)。
 * 抛错由 handleInvoke 转 MEDIA_TRANSFER_FAILED。
 */
export async function rewriteOutboundMedia(channel: string, args: unknown[]): Promise<unknown[]> {
  const isQueued = QUEUED_SHAPE_CHANNELS.has(channel);
  const isMessage = MESSAGE_SHAPE_CHANNELS.has(channel);
  if (!isQueued && !isMessage) return args;
  const next = [...args];
  if (next[1] === undefined) return next;
  if (isQueued) {
    next[1] = await rewriteQueued(next[1]);
  } else {
    // Direct maker:send carries the same attachment twice: once in the agent
    // message and once in sendOpts.persistUserMessage.content for DB history.
    // Rewrite both with one ref map so every file uploads exactly once.
    const refMap = new Map<string, string>();
    next[1] = await rewriteMessage(next[1], refMap);
    if (channel === 'maker:send') {
      const sendOpts = next[3];
      if (sendOpts && typeof sendOpts === 'object' && !Array.isArray(sendOpts)) {
        const persist = (sendOpts as { persistUserMessage?: unknown }).persistUserMessage;
        if (persist && typeof persist === 'object' && !Array.isArray(persist)) {
          const content = (persist as { content?: unknown }).content;
          if (typeof content === 'string') {
            const rewrittenContent = rewritePersistedContent(content, refMap);
            if (rewrittenContent !== content) {
              next[3] = {
                ...(sendOpts as object),
                persistUserMessage: { ...(persist as object), content: rewrittenContent },
              };
            }
          }
        }
      }
    }
  }
  log.debug(`outbound media rewritten for ${channel}`);
  return next;
}

export const __testing = {
  uploadAttachment,
  rewriteMessage,
  rewriteQueued,
  rewritePersistedContent,
  uploadAttachmentOnce,
  MESSAGE_SHAPE_CHANNELS,
  QUEUED_SHAPE_CHANNELS,
};
