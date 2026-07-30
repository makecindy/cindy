/**
 * telegram/inbound.ts — Telegram Update → IMMessageEvent / 群窗口条目。
 * ---------------------------------------------------------------------------
 * 职责:
 *   1. normalizeMessage: 私聊/群触发消息 → IMMessageEvent(附件下载、
 *      不支持类型标注、群 lane senderId 合成)。
 *   2. groupWindowEntryOf: 任意群消息 → 本地群窗口条目(字段模型与官方
 *      group-relay-v1 的 GroupMessagePayload 对齐, 但这里是本地直连产物)。
 *   3. detectGroupTrigger: 群消息是否@到本 bot / 回复本 bot(触发一轮 turn)。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { IMAttachment, IMHostMediaCache, IMMessageEvent, IMUnsupportedEntry } from '../types.js';
import type { TelegramApiClient, TgFile, TgMessage, TgMessageEntity, TgUser } from './api.js';
import { encodeLaneUserId, encodeMessageId } from './codec.js';

/** Bot API getFile 的官方下载上限(20MB), 超过标注 oversize 不下载。 */
const MAX_INBOUND_FILE_BYTES = 20 * 1024 * 1024;

export interface TelegramGroupWindowEntry {
  chatId: string;
  /** forum topic id; '' = 主群流。 */
  threadId: string;
  messageId: string;
  chatName: string | null;
  author: { name: string; isBot?: boolean };
  text: string;
  fileNames?: string[];
  sentAt: number;
}

export function displayNameOf(user: TgUser | undefined): string {
  if (!user) return 'unknown';
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || user.username || String(user.id);
}

/** 群消息的 lane threadId(仅真正的 forum topic 消息才有值)。 */
export function laneThreadIdOf(m: TgMessage): string {
  return m.is_topic_message === true && m.message_thread_id !== undefined
    ? String(m.message_thread_id)
    : '';
}

/** 群消息 → 本地窗口条目(触发与否都记录; 纯附件消息 text 为空串)。 */
export function groupWindowEntryOf(m: TgMessage): TelegramGroupWindowEntry {
  const fileNames: string[] = [];
  if (m.document?.file_name) fileNames.push(m.document.file_name);
  if (m.photo && m.photo.length > 0) fileNames.push('photo');
  if (m.video?.file_name) fileNames.push(m.video.file_name);
  if (m.audio?.file_name) fileNames.push(m.audio.file_name);
  return {
    chatId: String(m.chat.id),
    threadId: laneThreadIdOf(m),
    messageId: String(m.message_id),
    chatName: m.chat.title ?? null,
    author: {
      name: displayNameOf(m.from),
      ...(m.from?.is_bot ? { isBot: true } : {}),
    },
    text: m.text ?? m.caption ?? '',
    ...(fileNames.length > 0 ? { fileNames } : {}),
    sentAt: m.date * 1000,
  };
}

/**
 * 群触发判定: @bot 提及(text/caption entities 内的 @username 精确匹配)、
 * 回复 bot 的消息、或 /cmd@botusername 指令。返回剔除@提及后的干净文本;
 * 未触发返回 null。
 */
export function detectGroupTrigger(
  m: TgMessage,
  botId: number,
  botUsername: string,
): { text: string } | null {
  const sourceText = m.text ?? m.caption ?? '';
  const entities = m.text !== undefined ? m.entities : m.caption_entities;
  const mentionToken = `@${botUsername}`.toLowerCase();

  let mentioned = false;
  const strippedRanges: Array<{ start: number; end: number }> = [];
  for (const entity of entities ?? []) {
    if (entity.type !== 'mention' && entity.type !== 'bot_command') continue;
    const value = entitySlice(sourceText, entity);
    if (entity.type === 'mention' && value.toLowerCase() === mentionToken) {
      mentioned = true;
      strippedRanges.push({ start: entity.offset, end: entity.offset + entity.length });
    }
    if (entity.type === 'bot_command' && value.toLowerCase().endsWith(mentionToken)) {
      mentioned = true;
      // 指令保留、只剥 @username 后缀: `/new@bot` → `/new`。
    }
  }
  const repliedToBot = m.reply_to_message?.from?.id === botId;
  if (!mentioned && !repliedToBot) return null;

  let text = stripRanges(sourceText, strippedRanges);
  text = text.replace(new RegExp(`(/[a-zA-Z0-9_]+)@${escapeRegExp(botUsername)}`, 'gi'), '$1');
  return { text: text.replace(/[ \t]{2,}/g, ' ').trim() };
}

/**
 * Telegram entity 的 offset/length 按 UTF-16 code unit 计 — 与 JS 字符串
 * slice 同口径, 直接切。
 */
function entitySlice(text: string, entity: TgMessageEntity): string {
  return text.slice(entity.offset, entity.offset + entity.length);
}

function stripRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const range of sorted) {
    out += text.slice(cursor, range.start);
    cursor = Math.max(cursor, range.end);
  }
  out += text.slice(cursor);
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface NormalizeContext {
  api: TelegramApiClient;
  contextId: string;
  mediaDir: string;
  media?: IMHostMediaCache;
  /** 群触发时替换 text 的干净文本(已剥@提及);私聊传 undefined。 */
  overrideText?: string;
  /** 群触发时 senderId 用 lane id;私聊 undefined。 */
  laneUserId?: string;
}

/** 私聊消息/群触发消息 → IMMessageEvent(下载图片与文档附件)。 */
export async function normalizeMessage(m: TgMessage, ctx: NormalizeContext): Promise<IMMessageEvent> {
  const attachments: IMAttachment[] = [];
  const unsupported: IMUnsupportedEntry[] = [];
  const chatId = String(m.chat.id);

  if (m.sticker) unsupported.push({ type: 'sticker', label: m.sticker.emoji ?? 'sticker' });
  if (m.voice) unsupported.push({ type: 'audio', label: 'voice message' });
  if (m.audio) unsupported.push({ type: 'audio', label: m.audio.file_name ?? 'audio' });
  if (m.video) unsupported.push({ type: 'video', label: m.video.file_name ?? 'video' });
  if (m.video_note) unsupported.push({ type: 'video', label: 'video note' });

  if (m.photo && m.photo.length > 0) {
    // photo 数组是同图多分辨率, 取最大一档。
    const best = m.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    if ((best.file_size ?? 0) > MAX_INBOUND_FILE_BYTES) {
      unsupported.push({ type: 'oversize', label: 'photo' });
    } else {
      const downloaded = await downloadTelegramFile(ctx, best.file_id, `photo-${m.message_id}.jpg`, 'image/jpeg');
      if (downloaded) attachments.push(downloaded);
      else unsupported.push({ type: 'download', label: 'photo' });
    }
  }

  if (m.document) {
    const name = m.document.file_name ?? `document-${m.message_id}`;
    const mime = m.document.mime_type ?? 'application/octet-stream';
    if ((m.document.file_size ?? 0) > MAX_INBOUND_FILE_BYTES) {
      unsupported.push({ type: 'oversize', label: name });
    } else if (mime.startsWith('audio/')) {
      unsupported.push({ type: 'audio', label: name });
    } else if (mime.startsWith('video/')) {
      unsupported.push({ type: 'video', label: name });
    } else {
      const downloaded = await downloadTelegramFile(ctx, m.document.file_id, name, mime);
      if (downloaded) attachments.push(downloaded);
      else unsupported.push({ type: 'download', label: name });
    }
  }

  return {
    channelName: 'telegram',
    senderId: ctx.laneUserId ?? String(m.from?.id ?? ''),
    chatId,
    contextId: ctx.contextId,
    messageId: encodeMessageId(chatId, String(m.message_id)),
    text: ctx.overrideText ?? m.text ?? m.caption ?? '',
    attachments,
    unsupported,
    threadTs: undefined,
    scopeKey: undefined,
    raw: m,
  };
}

async function downloadTelegramFile(
  ctx: NormalizeContext,
  fileId: string,
  originalName: string,
  mimeType: string,
): Promise<IMAttachment | null> {
  try {
    const kind = mimeType.startsWith('image/') ? ('image' as const) : ('file' as const);
    if (kind === 'image' && ctx.media) {
      const cached = await ctx.media.getCachedImage('telegram', fileId);
      if (cached) {
        return { kind, absPath: cached.absPath, originalName, mimeType: cached.mimeType, url: cached.url };
      }
    }
    const file = await ctx.api.call<TgFile>('getFile', { file_id: fileId });
    if (!file.file_path) return null;
    const res = await fetch(ctx.api.fileUrl(file.file_path));
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());

    if (kind === 'image' && ctx.media) {
      try {
        const promoted = await ctx.media.cacheImage({
          integration: 'telegram',
          token: fileId,
          buffer,
          mimeType: mimeType.toLowerCase(),
        });
        return { kind, absPath: promoted.absPath, originalName, mimeType, url: promoted.url };
      } catch {
        // host 仓拒收(白名单外 mime / DB 未就绪): 回落老目录。
      }
    }

    fs.mkdirSync(ctx.mediaDir, { recursive: true });
    const dest = uniquePath(ctx.mediaDir, sanitizeFilename(originalName));
    fs.writeFileSync(dest, buffer);
    return { kind, absPath: dest, originalName, mimeType };
  } catch {
    return null;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'attachment';
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
