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

import type {
  IMAttachment,
  IMHostFileStaging,
  IMHostMediaCache,
  IMMessageEvent,
  IMUnsupportedEntry,
} from '../types.js';
import type { TelegramApiClient, TgFile, TgMediaFile, TgMessage, TgMessageEntity, TgUser } from './api.js';
import { audioVideoMimeOf, classifyInboundAttachment } from '../inboundKind.js';
import { encodeMessageId } from './codec.js';
import { telegramMessageText, telegramReplyText } from './messageText.js';

/** Bot API getFile 的官方下载上限(20MB), 超过标注 oversize 不下载。 */
const MAX_INBOUND_FILE_BYTES = 20 * 1024 * 1024;
/** 附件下载超时 — 与 Discord 通道同参数。 */
const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface TelegramHistoryImageRef {
  fileId: string;
  name: string;
  mimeType: string;
  /** Official relay proof; personal bots use their own Bot API connection. */
  downloadToken?: string;
}

export function historyImageRefsOf(m: TgMessage): TelegramHistoryImageRef[] {
  if (m.has_protected_content === true) return [];
  const refs: TelegramHistoryImageRef[] = [];
  const best = m.photo?.reduce(
    (a, b) => (b.width * b.height > a.width * a.height ? b : a),
    m.photo[0],
  );
  if (best && (best.file_size ?? 0) <= MAX_INBOUND_FILE_BYTES) {
    refs.push({
      fileId: best.file_id,
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
    });
  }
  if (m.document && (m.document.file_size ?? 0) <= MAX_INBOUND_FILE_BYTES) {
    const name = m.document.file_name ?? 'image';
    const classified = classifyInboundAttachment(m.document.mime_type, name);
    if (classified.kind === 'image')
      refs.push({
        fileId: m.document.file_id,
        name: name.slice(0, 256),
        mimeType: classified.mimeType,
      });
  }
  return refs;
}

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
  imageRefs?: TelegramHistoryImageRef[];
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
  if (m.video) fileNames.push(m.video.file_name ?? 'video');
  if (m.video_note) fileNames.push('video note');
  if (m.audio) fileNames.push(m.audio.file_name ?? 'audio');
  if (m.voice) fileNames.push('voice message');
  return {
    chatId: String(m.chat.id),
    threadId: laneThreadIdOf(m),
    messageId: String(m.message_id),
    chatName: m.chat.title ?? null,
    author: {
      name: displayNameOf(m.from),
      ...(m.from?.is_bot ? { isBot: true } : {}),
    },
    text: telegramMessageText(m),
    imageRefs: historyImageRefsOf(m),
    ...(fileNames.length > 0 ? { fileNames } : {}),
    sentAt: m.date * 1000,
  };
}

/**
 * 群触发判定: @bot 提及(text/caption entities 内的 @username 精确匹配, 或
 * 按 user id 指向本 bot 的 text_mention)、回复 bot 的消息、或 /cmd@botusername
 * 指令。返回剔除@提及后的干净文本; 未触发返回 null。
 *
 * 纯 @(剥完为空, 如只发一句 "@bot" 让它看上文)仍是召唤: 返回空正文，
 * 由事件的 invoked 标记保留触发事实，业务层不得将其当成空消息丢掉。
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
    if (entity.type === 'text_mention') {
      if (entity.user?.id === botId) {
        mentioned = true;
        strippedRanges.push({ start: entity.offset, end: entity.offset + entity.length });
      }
      continue;
    }
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
    // 兼容手打 @显示名；单纯聊到名字（即使在句首）不是召唤。
    const summoned = botName ? matchNameSummon(sourceText, botName) : null;
    if (summoned === null) return null;
    return { text: summoned };
  }

  let text = stripRanges(sourceText, strippedRanges);
  text = text.replace(new RegExp(`(/[a-zA-Z0-9_]+)@${escapeRegExp(botUsername)}`, 'gi'), '$1');
  text = text.replace(/[ \t]{2,}/g, ' ').trim();
  return { text };
}

/**
 * 显示名召唤匹配:
 *   - `@显示名` 任意位置(如 "@Ivy 你在?" — 大小写不敏感, 后面不能紧跟字母数字);
 * 没有 @ 的显示名无论在句首、句中还是独占一条都不算召唤。
 * 命中后剥掉召唤 token；空正文由事件的 invoked 标记保留召唤事实。
 */
function matchNameSummon(sourceText: string, botName: string): string | null {
  const name = botName.trim();
  if (name.length < 2) return null;
  const esc = escapeRegExp(name);
  const atRe = new RegExp(`@${esc}(?![A-Za-z0-9_])`, 'gi');
  const atStripped = sourceText.replace(atRe, ' ');
  if (atStripped === sourceText) return null;
  const text = atStripped.replace(/[ \t]{2,}/g, ' ').trim();
  return text;
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
  media?: IMHostMediaCache;
  /** 非媒体文件暂存; 未提供时这类文件标不支持(不写 legacy 目录)。 */
  files?: IMHostFileStaging;
  /** 群触发时替换 text 的干净文本(已剥@提及);私聊传 undefined。 */
  overrideText?: string;
  /** 群触发时 senderId 用 lane id;私聊 undefined。 */
  laneUserId?: string;
  /** 相册(media_group)同组的其余消息 — 媒体并入本事件, 不各起一轮 turn。 */
  siblings?: TgMessage[];
  /**
   * 音视频(host.media.cacheMedia)与非媒体文件(host.files.stage)暂存后的回滚句柄。调用方在下载期间
   * 配置换代(登出/换账号)时逐个调用, 不把旧账号的媒体留在新账号的仓里。
   */
  stagedDiscards?: Array<() => Promise<void>>;
  /**
   * 群历史上下文(只进模型、不落库, 没有任务引用): 图片按可回收缓存写入, 不复用
   * 也不固定已有缓存 —— 否则这些 blob 永远不会被回收。
   */
  history?: boolean;
}

/**
 * 被回复消息 → 引用上下文(编排层拼进送模型正文)。纯附件消息给类型占位,
 * 让模型知道"引用的是一张图/一个文件"而不是空字符串。
 */
export function replyContextOf(
  m: TgMessage,
): { messageId: string; author: string; text: string; isBot?: boolean } | null {
  const replied = m.reply_to_message;
  if (!replied) return null;
  // 受保护群里被引用的原消息不进 prompt: 引用块会把原文原样带进模型上下文,
  // 那和把它写进本地池是同一次外传。与官方 bot「被引消息受保护则原文与附件
  // 都不外传」同一语义。触发轮次本身照常跑, 只是不带原文。
  if (replied.has_protected_content === true || m.has_protected_content === true) return null;
  let text = telegramReplyText(m);
  if (!text) {
    if (replied.photo && replied.photo.length > 0) text = '[图片]';
    else if (replied.document) text = `[文件: ${replied.document.file_name ?? 'document'}]`;
    else if (replied.voice) text = '[语音消息]';
    else if (replied.video) text = '[视频]';
    else if (replied.sticker) text = `[贴纸${replied.sticker.emoji ? ` ${replied.sticker.emoji}` : ''}]`;
    else text = '[引用消息的正文无法读取]';
  }
  return {
    messageId: String(replied.message_id),
    author: displayNameOf(replied.from),
    text,
    ...(replied.from?.is_bot ? { isBot: true } : {}),
  };
}

/**
 * voice / audio / video / video_note → 下载用的文件名与 MIME。平台 MIME 不是音视频
 * (缺失或 octet-stream)时按扩展名纠正, 再不行按 Telegram 默认容器。
 */
function audioVideoFilesOf(
  m: TgMessage,
): Array<{ file: TgMediaFile; name: string; mimeType: string }> {
  const out: Array<{ file: TgMediaFile; name: string; mimeType: string }> = [];
  if (m.voice) {
    const name = `voice-${m.message_id}.ogg`;
    out.push({ file: m.voice, name, mimeType: audioVideoMimeOf(m.voice.mime_type, name) ?? 'audio/ogg' });
  }
  if (m.audio) {
    const name = m.audio.file_name ?? `audio-${m.message_id}.mp3`;
    out.push({ file: m.audio, name, mimeType: audioVideoMimeOf(m.audio.mime_type, name) ?? 'audio/mpeg' });
  }
  if (m.video) {
    const name = m.video.file_name ?? `video-${m.message_id}.mp4`;
    out.push({ file: m.video, name, mimeType: audioVideoMimeOf(m.video.mime_type, name) ?? 'video/mp4' });
  }
  if (m.video_note) {
    out.push({ file: m.video_note, name: `video-note-${m.message_id}.mp4`, mimeType: 'video/mp4' });
  }
  return out;
}

/**
 * 单个音视频: 20MB 内下载并经 host.media.cacheMedia 入媒体总仓。host 不提供
 * cacheMedia 或总仓拒收该格式时标 video/audio 不支持 — 不降级写 legacy 目录
 * (媒体规则: `cc-agent/*-media` 是冻结的历史兼容层)。
 */
async function collectAudioVideo(
  ctx: NormalizeContext,
  file: { file_id: string; file_size?: number },
  name: string,
  mimeType: string,
  attachments: IMAttachment[],
  unsupported: IMUnsupportedEntry[],
): Promise<void> {
  const type = mimeType.startsWith('audio/') ? 'audio' : 'video';
  const cacheMedia = ctx.media?.cacheMedia;
  if (!cacheMedia) {
    unsupported.push({ type, label: name });
    return;
  }
  if ((file.file_size ?? 0) > MAX_INBOUND_FILE_BYTES) {
    unsupported.push({ type: 'oversize', label: name });
    return;
  }
  const buffer = await fetchTelegramFileBytes(ctx, file.file_id);
  if (!buffer) {
    unsupported.push({ type: 'download', label: name });
    return;
  }
  try {
    const stored = await cacheMedia({
      integration: 'telegram',
      token: file.file_id,
      buffer,
      mimeType: mimeType.split(';')[0].trim().toLowerCase(),
    });
    if (stored.discard) ctx.stagedDiscards?.push(stored.discard);
    attachments.push({
      kind: 'file',
      absPath: stored.absPath,
      originalName: name,
      mimeType: stored.mimeType,
      url: stored.url,
    });
  } catch {
    // 总仓只收白名单格式(mp4/webm/mov/mp3/m4a/ogg/wav 等), 其余如实标不支持。
    unsupported.push({ type, label: name });
  }
}

/** 消息是否带可下载媒体(照片/文件/音视频) — 群历史媒体池的入池判据。 */
export function hasDownloadableMedia(m: TgMessage): boolean {
  return Boolean(
    (m.photo && m.photo.length > 0) || m.document || m.voice || m.audio || m.video || m.video_note,
  );
}

/** 单条消息的媒体收集(相册聚合时对每个成员各调一次)。 */
async function collectMedia(
  m: TgMessage,
  ctx: NormalizeContext,
  attachments: IMAttachment[],
  unsupported: IMUnsupportedEntry[],
): Promise<void> {
  if (m.sticker) unsupported.push({ type: 'sticker', label: m.sticker.emoji ?? 'sticker' });

  // 音视频以 file block(可读路径)交给模型, Agent 可自行抽帧/转写。字节进
  // cindy-media 总仓(内容寻址/引用记账/统一回收), 不写冻结的 cc-agent 目录。
  for (const media of audioVideoFilesOf(m)) {
    await collectAudioVideo(ctx, media.file, media.name, media.mimeType, attachments, unsupported);
  }

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
    // 去处只由共用判据决定(MIME 与扩展名任一命中)。
    const classified = classifyInboundAttachment(m.document.mime_type, name);
    if (classified.kind === 'av') {
      await collectAudioVideo(ctx, m.document, name, classified.mimeType, attachments, unsupported);
    } else if ((m.document.file_size ?? 0) > MAX_INBOUND_FILE_BYTES) {
      unsupported.push({ type: 'oversize', label: name });
    } else if (classified.kind === 'image' ? !ctx.media : !ctx.files) {
      unsupported.push({ type: classified.kind, label: name });
    } else {
      const downloaded = await downloadTelegramFile(ctx, m.document.file_id, name, classified.mimeType);
      if (downloaded) attachments.push(downloaded);
      else unsupported.push({ type: 'download', label: name });
    }
  }
}

/** 被引消息的媒体(上限 3)并入本 turn — 官方 bot 同款语义。 */
const MAX_REPLY_ATTACHMENTS = 3;

async function collectReplyMedia(
  replied: TgMessage,
  ctx: NormalizeContext,
  attachments: IMAttachment[],
  unavailable: string[],
): Promise<number> {
  const before = attachments.length;
  const sink: IMAttachment[] = [];
  const discard: IMUnsupportedEntry[] = [];
  await collectMedia(replied, ctx, sink, discard);
  unavailable.push(...discard.map((entry) => `引用附件 ${entry.label}：${entry.type}`));
  unavailable.push(...sink.slice(MAX_REPLY_ATTACHMENTS).map((entry) => `引用附件 ${entry.originalName}：超过数量上限`));
  for (const attachment of sink.slice(0, MAX_REPLY_ATTACHMENTS)) {
    attachments.push(attachment);
  }
  return attachments.length - before;
}

/** 私聊消息/群触发消息 → IMMessageEvent(下载图片、文件与音视频附件, 相册成员并入)。 */
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
  const unavailableAttachments: string[] = [];
  const replyAttachmentCount =
    m.reply_to_message && !replyProtected
      ? await collectReplyMedia(m.reply_to_message, ctx, attachments, unavailableAttachments)
      : 0;

  return {
    channelName: 'telegram',
    interactionSource: {
      chatName: m.chat.title ?? (m.chat.type === 'private' ? displayNameOf(m.from) : chatId),
      senderName: displayNameOf(m.from),
      ...(laneThreadIdOf(m) ? { threadName: laneThreadIdOf(m) } : {}),
      ...(chatId.startsWith('-100') ? { messageUrl: `https://t.me/c/${chatId.slice(4)}/${m.message_id}` } : {}),
    },
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
            ...(unavailableAttachments.length ? { unavailableAttachments } : {}),
          },
        }
      : {}),
    raw: m,
  };
}

/** 单次群历史媒体注入上限 — 与飞书群上下文(HISTORY_IMAGE_MAX / HISTORY_FILE_MAX)同口径。 */
export const GROUP_HISTORY_IMAGE_MAX = 6;
export const GROUP_HISTORY_FILE_MAX = 4;

/**
 * 群历史媒体(触发前群里别人/自己先发、还没交给 bot 的图片/文件/音视频)下载。
 * messages 按时间正序传入; 名额从最新往旧分配, **先占名额再下载** —— 超出名额的
 * 不下载, 只汇总成一条原因。返回时翻回时间正序。下载失败/超限逐条写进 unavailable
 * (文件名等是第三方文本, 由调用方放进数据块)。
 */
export async function collectGroupHistoryMedia(
  messages: TgMessage[],
  ctx: Pick<NormalizeContext, 'api' | 'media' | 'files' | 'stagedDiscards'>,
): Promise<{ attachments: Array<IMAttachment & { author: string }>; unavailable: string[] }> {
  const picked: Array<IMAttachment & { author: string }> = [];
  const unavailable: string[] = [];
  let images = 0;
  let files = 0;
  let overQuota = 0;
  for (const m of [...messages].reverse()) {
    const isImage = expectedAttachmentKind(m) === 'image';
    if (isImage ? images >= GROUP_HISTORY_IMAGE_MAX : files >= GROUP_HISTORY_FILE_MAX) {
      overQuota++;
      continue;
    }
    if (isImage) images++;
    else files++;
    const author = displayNameOf(m.from);
    const sink: IMAttachment[] = [];
    const failed: IMUnsupportedEntry[] = [];
    await collectMedia(m, { ...ctx, contextId: '', history: true }, sink, failed);
    unavailable.push(...failed.map((entry) => `群历史附件 ${entry.label}（${author}）：${entry.type}`));
    picked.push(...sink.map((att) => ({ ...att, author })));
  }
  unavailable.reverse();
  if (overQuota > 0) unavailable.push(`另有 ${overQuota} 个更早的群历史附件超过数量上限，未提供`);
  return { attachments: picked.reverse(), unavailable };
}

/**
 * 下载前预判附件类别(占名额用): 照片与经共用判据归为图片的文档进图片额度, 其余进
 * 文件额度 —— 与实际下载分流同一判据(classifyInboundAttachment), 不另立规则。
 */
function expectedAttachmentKind(m: TgMessage): 'image' | 'file' {
  if (m.photo && m.photo.length > 0) return 'image';
  if (m.document) {
    const name = m.document.file_name ?? `document-${m.message_id}`;
    if (classifyInboundAttachment(m.document.mime_type, name).kind === 'image') return 'image';
  }
  return 'file';
}

async function downloadTelegramFile(
  ctx: NormalizeContext,
  fileId: string,
  originalName: string,
  mimeType: string,
): Promise<IMAttachment | null> {
  try {
    const kind = mimeType.startsWith('image/') ? ('image' as const) : ('file' as const);
    if (kind === 'image' && ctx.media && !ctx.history) {
      const cached = await ctx.media.getCachedImage('telegram', fileId);
      if (cached) {
        return { kind, absPath: cached.absPath, originalName, mimeType: cached.mimeType, url: cached.url };
      }
    }
    // 没有可写的受控去处就不下载(图片要媒体总仓, 其余要文件暂存)。
    if (kind === 'image' ? !ctx.media : !ctx.files) return null;
    const buffer = await fetchTelegramFileBytes(ctx, fileId);
    if (!buffer) return null;

    if (kind === 'image') {
      // 图片新写入必须留在 cindy-media 总仓(内容寻址/引用记账/统一回收,
      // 媒体规则 25) — host 仓拒收/未就绪时丢弃该附件, 不落无治理的
      // legacy 目录; 消息正文照常送达。
      if (!ctx.media) return null;
      try {
        const promoted = await ctx.media.cacheImage({
          integration: 'telegram',
          token: fileId,
          buffer,
          mimeType: mimeType.toLowerCase(),
          // 落库前一律可回收暂存: 换代可回滚; 消息落库时由 host pin 成用户附件,
          // 群历史(只进模型)则一直保持可回收。
          staging: true,
        });
        if (promoted.discard) ctx.stagedDiscards?.push(promoted.discard);
        return {
          kind,
          absPath: promoted.absPath,
          originalName,
          mimeType: promoted.mimeType ?? mimeType,
          url: promoted.url,
        };
      } catch {
        return null;
      }
    }

    // 非媒体文件交 host 暂存(路由到任务后移入任务附件目录); 不写 legacy 目录。
    if (!ctx.files) return null;
    const staged = await ctx.files.stage({ integration: 'telegram', buffer, fileName: originalName });
    ctx.stagedDiscards?.push(staged.discard);
    return { kind, absPath: staged.absPath, originalName, mimeType };
  } catch {
    return null;
  }
}

/** getFile + 下载字节; 任一跳失败返回 null。 */
export async function fetchTelegramFileBytes(
  ctx: NormalizeContext,
  fileId: string,
): Promise<Buffer | null> {
  try {
    // getFile 与下载 fetch 同在轮询循环的 await 链上 — 两跳都必须带超时,
    // 否则任一悬死连接(TCP 半开/代理黑洞)会卡住全部入站直到进程重启。
    const file = await ctx.api.call<TgFile>(
      'getFile',
      { file_id: fileId },
      AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    );
    if (!file.file_path || (file.file_size ?? 0) > MAX_INBOUND_FILE_BYTES) return null;
    const res = await fetch(ctx.api.fileUrl(file.file_path), {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    if (!res.body) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > MAX_INBOUND_FILE_BYTES) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}
