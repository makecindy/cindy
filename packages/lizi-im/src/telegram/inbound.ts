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
import { encodeMessageId } from './codec.js';

/** Bot API getFile 的官方下载上限(20MB), 超过标注 oversize 不下载。 */
const MAX_INBOUND_FILE_BYTES = 20 * 1024 * 1024;
/** 附件下载超时 — 与 Discord 通道同参数。 */
const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface TelegramGroupWindowEntry {
  /**
   * 归属 bot 的数字 id(字符串形态) — 窗口存储按 bot 命名空间隔离: 换绑
   * 不同 bot 后, 新 bot 的上下文/群清单不掺前任 bot 的历史(review P1)。
   * 由 transport 的 emitGroupWindow 统一注入。
   */
  botId: string;
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

/** 群消息 → 本地窗口条目(触发与否都记录; 纯附件消息 text 为空串; botId 由 emit 注入)。 */
export function groupWindowEntryOf(m: TgMessage): Omit<TelegramGroupWindowEntry, 'botId'> {
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
  botName?: string,
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
  if (!mentioned && !repliedToBot) {
    // 名字召唤(OpenClaw 习惯, Chris 2026-07-30 实测踩坑): 显示名不是
    // username, 手打 "@Ivy" 或开头喊 "Ivy ..." 不构成 Telegram mention,
    // 但用户预期就是在叫 bot — 按显示名匹配补上这类召唤。
    const summoned = botName ? matchNameSummon(sourceText, botName) : null;
    if (summoned === null) return null;
    return { text: summoned };
  }

  let text = stripRanges(sourceText, strippedRanges);
  text = text.replace(new RegExp(`(/[a-zA-Z0-9_]+)@${escapeRegExp(botUsername)}`, 'gi'), '$1');
  return { text: text.replace(/[ \t]{2,}/g, ' ').trim() };
}

/**
 * 显示名召唤匹配:
 *   - `@显示名` 任意位置(如 "@Ivy 你在?" — 大小写不敏感, 后面不能紧跟字母数字);
 *   - 裸显示名在**句首**且后跟分隔符/结尾(如 "Ivy 帮我看看" / "ivy?")。
 * 句中出现名字(如 "我问过 Ivy 了")不算召唤 — 只是聊到它, 避免误触发。
 * 命中后剥掉召唤 token; 剥完为空(纯 "@Ivy")时保留原文让 agent 打招呼。
 */
function matchNameSummon(sourceText: string, botName: string): string | null {
  const name = botName.trim();
  if (name.length < 2) return null;
  const esc = escapeRegExp(name);
  const SEP = '[\\s,，。:：、!！?？~〜]';
  const atRe = new RegExp(`@${esc}(?![\\w])`, 'gi');
  const leadRe = new RegExp(`^\\s*${esc}(?=$|${SEP})`, 'i');
  let cleaned: string | null = null;
  const atStripped = sourceText.replace(atRe, ' ');
  if (atStripped !== sourceText) {
    cleaned = atStripped;
  } else if (leadRe.test(sourceText)) {
    cleaned = sourceText.replace(leadRe, '').replace(new RegExp(`^${SEP}+`), '');
  }
  if (cleaned === null) return null;
  const text = cleaned.replace(/[ \t]{2,}/g, ' ').trim();
  return text || sourceText.trim();
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
  /** 相册(media_group)同组的其余消息 — 媒体并入本事件, 不各起一轮 turn。 */
  siblings?: TgMessage[];
}

/**
 * 被回复消息 → 引用上下文(编排层拼进送模型正文)。纯附件消息给类型占位,
 * 让模型知道"引用的是一张图/一个文件"而不是空字符串。
 */
export function replyContextOf(
  m: TgMessage,
): { author: string; text: string; isBot?: boolean } | null {
  const replied = m.reply_to_message;
  if (!replied) return null;
  // 受保护群里被引用的原消息不进 prompt: 引用块会把原文原样带进模型上下文,
  // 那和把它写进本地池是同一次外传。与官方 bot「被引消息受保护则原文与附件
  // 都不外传」同一语义。触发轮次本身照常跑, 只是不带原文。
  if (replied.has_protected_content === true || m.has_protected_content === true) return null;
  let text = replied.text ?? replied.caption ?? '';
  if (!text) {
    if (replied.photo && replied.photo.length > 0) text = '[图片]';
    else if (replied.document) text = `[文件: ${replied.document.file_name ?? 'document'}]`;
    else if (replied.voice) text = '[语音消息]';
    else if (replied.video) text = '[视频]';
    else if (replied.sticker) text = `[贴纸${replied.sticker.emoji ? ` ${replied.sticker.emoji}` : ''}]`;
    else return null; // 服务消息等无内容形态, 不构造空引用
  }
  return {
    author: displayNameOf(replied.from),
    text,
    ...(replied.from?.is_bot ? { isBot: true } : {}),
  };
}

/** 单条消息的媒体收集(相册聚合时对每个成员各调一次)。 */
async function collectMedia(
  m: TgMessage,
  ctx: NormalizeContext,
  attachments: IMAttachment[],
  unsupported: IMUnsupportedEntry[],
): Promise<void> {
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
}

/** 被引消息的媒体(仅 photo/document, 上限 3)并入本 turn — 官方 bot 同款语义。 */
const MAX_REPLY_ATTACHMENTS = 3;

async function collectReplyMedia(
  replied: TgMessage,
  ctx: NormalizeContext,
  attachments: IMAttachment[],
): Promise<number> {
  const before = attachments.length;
  const sink: IMAttachment[] = [];
  const discard: IMUnsupportedEntry[] = []; // 被引消息的不可用类型静默丢, 不打扰用户
  await collectMedia(replied, ctx, sink, discard);
  for (const attachment of sink.slice(0, MAX_REPLY_ATTACHMENTS)) {
    attachments.push(attachment);
  }
  return attachments.length - before;
}

/** 私聊消息/群触发消息 → IMMessageEvent(下载图片与文档附件, 相册成员并入)。 */
export async function normalizeMessage(m: TgMessage, ctx: NormalizeContext): Promise<IMMessageEvent> {
  const attachments: IMAttachment[] = [];
  const unsupported: IMUnsupportedEntry[] = [];
  const chatId = String(m.chat.id);

  await collectMedia(m, ctx, attachments, unsupported);
  for (const sibling of ctx.siblings ?? []) {
    await collectMedia(sibling, ctx, attachments, unsupported);
  }
  const reply = replyContextOf(m);
  // 受保护的被引消息连附件一起不外传(与 replyContextOf 的正文判据同一条边界):
  // 只挡引用带出来的那份, 本条消息自己的附件仍按用户显式发送处理。
  const replyProtected =
    m.reply_to_message?.has_protected_content === true || m.has_protected_content === true;
  const replyAttachmentCount =
    m.reply_to_message && !replyProtected
      ? await collectReplyMedia(m.reply_to_message, ctx, attachments)
      : 0;

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
    // 受保护群的消息照常起 turn, 但不得进任何长期存档 —— 群历史池已在
    // emitGroupWindow 处拦下, 这个标记是给业务层会话存档的第二道。
    ...(m.has_protected_content === true ? { protectedContent: true } : {}),
    ...(reply
      ? {
          replyContext: {
            ...reply,
            ...(replyAttachmentCount > 0 ? { attachmentCount: replyAttachmentCount } : {}),
          },
        }
      : {}),
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
    // getFile 与下载 fetch 同在轮询循环的 await 链上 — 两跳都必须带超时,
    // 否则任一悬死连接(TCP 半开/代理黑洞)会卡住全部入站直到进程重启。
    const file = await ctx.api.call<TgFile>(
      'getFile',
      { file_id: fileId },
      AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    );
    if (!file.file_path) return null;
    const res = await fetch(ctx.api.fileUrl(file.file_path), {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
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
        // 图片新写入必须留在 cindy-media 总仓(内容寻址/引用记账/统一回收,
        // 媒体规则 25) — host 仓拒收/未就绪时丢弃该附件, 不落无治理的
        // legacy 目录; 消息正文照常送达。非图类文件走下方 legacy 目录,
        // 与 feishu/discord 通道同口径(cindy-media 目前只收图)。
        return null;
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
