import fs from 'node:fs';
import path from 'node:path';

import type { IMAttachment, IMHostMediaCache, IMMessageEvent, IMUnsupportedEntry } from '../types.js';
import { encodeMessageId } from './codec.js';

const MAX_INBOUND_FILE_BYTES = 50 * 1024 * 1024;

export interface MessageLike {
  id: string;
  content?: string | null;
  author: { id: string };
  channelId?: string;
  channel?: { id?: string };
  attachments?: Iterable<AttachmentLike> | { values(): IterableIterator<AttachmentLike> };
  stickers?: Iterable<StickerLike> | { values(): IterableIterator<StickerLike> };
  type?: string | number;
}

export interface AttachmentLike {
  id?: string;
  name?: string;
  filename?: string;
  url: string;
  size: number;
  contentType?: string | null;
}

export interface StickerLike {
  id?: string;
  name?: string;
}

export async function normalizeDmMessage(
  m: MessageLike,
  ctx: {
    contextId: string;
    mediaDir: string;
    download: (url: string, dest: string) => Promise<void>;
    /** host 媒体总仓(可选):入站图片提升进内容寻址仓,缺省回落 mediaDir。 */
    media?: IMHostMediaCache;
  },
): Promise<IMMessageEvent | null> {
  const chatId = m.channelId ?? m.channel?.id ?? '';
  if (!chatId) {
    // Malformed event without a resolvable channel (e.g. partial presence
    // or guild event leaking through the DM filter). Return null so the
    // transport suppresses it entirely — emitting an event with an empty
    // chatId could inject non-DM content into the owner's agent session.
    return null;
  }
  const attachments: IMAttachment[] = [];
  const unsupported: IMUnsupportedEntry[] = [];

  for (const sticker of iterableValues(m.stickers)) {
    unsupported.push({ type: 'sticker', label: sticker.name ?? sticker.id ?? 'sticker' });
  }

  if (isVoiceMessage(m)) {
    unsupported.push({ type: 'audio', label: 'audio message' });
  }

  fs.mkdirSync(ctx.mediaDir, { recursive: true });
  const messageAttachments = iterableValues(m.attachments);
  const filenameCounts = countAttachmentFilenames(messageAttachments);
  for (let i = 0; i < messageAttachments.length; i += 1) {
    const attachment = messageAttachments[i];
    const originalName = attachment.name ?? attachment.filename ?? attachment.id ?? 'attachment';
    const mimeType = attachment.contentType ?? inferMimeType(originalName);

    if (attachment.size > MAX_INBOUND_FILE_BYTES) {
      unsupported.push({ type: 'oversize', label: originalName });
      continue;
    }
    if (mimeType.startsWith('audio/')) {
      unsupported.push({ type: 'audio', label: originalName });
      continue;
    }
    if (mimeType.startsWith('video/')) {
      unsupported.push({ type: 'video', label: originalName });
      continue;
    }

    const dest = uniquePath(
      ctx.mediaDir,
      storageFilename(m.id, attachment, originalName, filenameCounts, i),
    );
    try {
      await ctx.download(attachment.url, dest);
      const kind = mimeType.startsWith('image/') ? ('image' as const) : ('file' as const);
      let absPath = dest;
      let cindyUrl: string | undefined;
      // 图片提升进 host 媒体总仓:download 只会写文件,先落历史
      // 目录再读字节入仓、删临时副本;失败回落老路径(附件不能丢)。token 用
      // 平台附件 id(全局唯一),缺失时退 `msgId-序号`。
      if (kind === 'image' && ctx.media) {
        try {
          const promoted = await ctx.media.cacheImage({
            integration: 'discord',
            token: attachment.id ?? `${m.id}-${i}`,
            buffer: fs.readFileSync(dest),
            mimeType: mimeType.toLowerCase(),
          });
          absPath = promoted.absPath;
          cindyUrl = promoted.url;
          fs.rmSync(dest, { force: true });
        } catch {
          // host 仓拒收(白名单外 mime / DB 未就绪):保留老目录副本。
        }
      }
      attachments.push({
        kind,
        absPath,
        originalName,
        mimeType,
        ...(cindyUrl ? { url: cindyUrl } : {}),
      });
    } catch {
      unsupported.push({ type: 'download', label: originalName });
    }
  }

  return {
    channelName: 'discord',
    senderId: m.author.id,
    chatId,
    contextId: ctx.contextId,
    messageId: encodeMessageId(chatId, m.id),
    text: m.content ?? '',
    attachments,
    unsupported,
    threadTs: undefined,
    scopeKey: undefined,
    raw: m,
  };
}

function iterableValues<T>(source: Iterable<T> | { values(): IterableIterator<T> } | undefined): T[] {
  if (!source) return [];
  if (hasValues<T>(source)) return Array.from(source.values());
  return Array.from(source);
}

function hasValues<T>(source: unknown): source is { values(): IterableIterator<T> } {
  return (
    typeof source === 'object' &&
    source !== null &&
    'values' in source &&
    typeof (source as { values?: unknown }).values === 'function'
  );
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'attachment';
}

function countAttachmentFilenames(attachments: AttachmentLike[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const attachment of attachments) {
    const originalName = attachment.name ?? attachment.filename ?? attachment.id ?? 'attachment';
    const filename = sanitizeFilename(originalName);
    counts.set(filename, (counts.get(filename) ?? 0) + 1);
  }
  return counts;
}

function storageFilename(
  messageId: string,
  attachment: AttachmentLike,
  originalName: string,
  filenameCounts: Map<string, number>,
  index: number,
): string {
  const messagePrefix = sanitizeFilename(messageId);
  const originalFilename = sanitizeFilename(originalName);
  if ((filenameCounts.get(originalFilename) ?? 0) > 1) {
    const attachmentPrefix = sanitizeFilename(attachment.id ?? String(index + 1));
    return `${messagePrefix}-${attachmentPrefix}-${originalFilename}`;
  }
  return `${messagePrefix}-${originalFilename}`;
}

function uniquePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  let index = 1;

  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

function inferMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.txt':
      return 'text/plain';
    case '.json':
      return 'application/json';
    case '.pdf':
      return 'application/pdf';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

function isVoiceMessage(m: MessageLike): boolean {
  return m.type === 'voice' || m.type === 'VoiceMessage';
}
