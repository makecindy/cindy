
import type {
  IMAttachment,
  IMHostFileStaging,
  IMHostMediaCache,
  IMMessageEvent,
  IMUnsupportedEntry,
} from '../types.js';
import { classifyInboundAttachment } from '../inboundKind.js';
import { encodeMessageId } from './codec.js';

const MAX_INBOUND_FILE_BYTES = 50 * 1024 * 1024;

export interface MessageLike {
  id: string;
  content?: string | null;
  author: { id: string; username?: string; globalName?: string | null };
  channelId?: string;
  channel?: { id?: string; name?: string };
  attachments?: Iterable<AttachmentLike> | { values(): IterableIterator<AttachmentLike> };
  stickers?: Iterable<StickerLike> | { values(): IterableIterator<StickerLike> };
  type?: string | number;
}

/** 服务器频道 / thread 消息（在 MessageLike 之上多了 guild、父频道、提及与成员信息）。 */
export type GuildMessageLike = MessageLike & {
  guildId?: string | null;
  guild?: { name?: string } | null;
  channel?: {
    id?: string;
    name?: string;
    type?: number;
    parentId?: string | null;
    parent?: { name?: string } | null;
  };
  member?: { displayName?: string | null } | null;
  mentions?: { has(user: string, options?: Record<string, boolean>): boolean };
};

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

/** 服务器频道消息的路由信息；缺省 = 私聊（senderId 取发言人）。 */
export interface InboundRoute {
  /** 编排层路由键：频道是 lane id（`g/...`），私聊缺省为发言人 id。 */
  senderId: string;
  /** 覆盖正文（频道里已去掉对机器人的 @）。 */
  text: string;
  interactionSource: NonNullable<IMMessageEvent['interactionSource']>;
  speaker: NonNullable<IMMessageEvent['speaker']>;
}

export interface InboundContext {
  contextId: string;
  download: (url: string) => Promise<Uint8Array>;
  /** host 媒体总仓: 图片与音视频入内容寻址仓; 缺省时这类附件标不支持。 */
  media?: IMHostMediaCache;
  /** host 文件暂存: 非媒体文件; 缺省时标不支持。均不写 legacy 目录。 */
  files?: IMHostFileStaging;
  /** 暂存成功后的回滚句柄 — 下载期间配置换代时由调用方逐个调用。 */
  stagedDiscards?: Array<() => Promise<void>>;
}

export async function normalizeInboundMessage(
  m: MessageLike,
  ctx: InboundContext,
  route?: InboundRoute,
): Promise<IMMessageEvent | null> {
  const chatId = m.channelId ?? m.channel?.id ?? '';
  if (!chatId) {
    // 缺少频道的 partial 事件不能投递，避免把未知来源内容路由进会话。
    return null;
  }
  const attachments: IMAttachment[] = [];
  const unsupported: IMUnsupportedEntry[] = [];

  for (const sticker of iterableValues(m.stickers)) {
    unsupported.push({ type: 'sticker', label: sticker.name ?? sticker.id ?? 'sticker' });
  }

  const messageAttachments = iterableValues(m.attachments);
  if (isVoiceMessage(m) && messageAttachments.length === 0) {
    unsupported.push({ type: 'audio', label: 'audio message' });
  }

  for (let i = 0; i < messageAttachments.length; i += 1) {
    const attachment = messageAttachments[i];
    const originalName = attachment.name ?? attachment.filename ?? attachment.id ?? 'attachment';
    // 平台附件 id 全局唯一, 缺失时退 `msgId-序号` —— host 据此免重下。
    const token = attachment.id ?? `${m.id}-${i}`;
    // 去处只由共用判据决定(MIME 与扩展名任一命中; contentType 常缺或给 octet-stream)。
    const { kind: destination, mimeType } = classifyInboundAttachment(attachment.contentType, originalName);
    const unsupportedType =
      destination === 'av' ? (mimeType.startsWith('audio/') ? 'audio' : 'video') : destination;

    if (attachment.size > MAX_INBOUND_FILE_BYTES) {
      unsupported.push({ type: 'oversize', label: originalName });
      continue;
    }
    // 没有受控去处就不下载: 图片/音视频要媒体总仓, 其余要文件暂存。
    const canStore =
      destination === 'image'
        ? Boolean(ctx.media)
        : destination === 'av'
          ? Boolean(ctx.media?.cacheMedia)
          : Boolean(ctx.files);
    if (!canStore) {
      unsupported.push({ type: unsupportedType, label: originalName });
      continue;
    }

    let buffer: Uint8Array;
    try {
      buffer = await ctx.download(attachment.url);
    } catch {
      unsupported.push({ type: 'download', label: originalName });
      continue;
    }
    try {
      if (destination === 'image') {
        // 落库前一律可回收暂存(staging): 换代可回滚; 消息落库时由 host pin 成用户附件。
        const promoted = await ctx.media!.cacheImage({ integration: 'discord', token, buffer, mimeType, staging: true });
        if (promoted.discard) ctx.stagedDiscards?.push(promoted.discard);
        attachments.push({
          kind: 'image',
          absPath: promoted.absPath,
          originalName,
          mimeType: promoted.mimeType ?? mimeType,
          url: promoted.url,
        });
      } else if (destination === 'av') {
        const stored = await ctx.media!.cacheMedia!({ integration: 'discord', token, buffer, mimeType });
        if (stored.discard) ctx.stagedDiscards?.push(stored.discard);
        attachments.push({
          kind: 'file',
          absPath: stored.absPath,
          originalName,
          mimeType: stored.mimeType,
          url: stored.url,
        });
      } else {
        const staged = await ctx.files!.stage({ integration: 'discord', buffer, fileName: originalName });
        ctx.stagedDiscards?.push(staged.discard);
        attachments.push({ kind: 'file', absPath: staged.absPath, originalName, mimeType });
      }
    } catch {
      // host 仓拒收(白名单外格式 / 未就绪): 如实标不支持, 不降级写 legacy 目录。
      unsupported.push({ type: unsupportedType, label: originalName });
    }
  }

  return {
    channelName: 'discord',
    interactionSource: route?.interactionSource ?? {
      chatName: m.channel?.name ?? m.author.globalName ?? m.author.username,
      senderName: m.author.globalName ?? m.author.username ?? m.author.id,
      messageUrl: `https://discord.com/channels/@me/${chatId}/${m.id}`,
    },
    senderId: route?.senderId ?? m.author.id,
    chatId,
    contextId: ctx.contextId,
    messageId: encodeMessageId(chatId, m.id),
    text: route ? route.text : (m.content ?? ''),
    ...(route ? { invoked: true, speaker: route.speaker } : {}),
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

function isVoiceMessage(m: MessageLike): boolean {
  return m.type === 'voice' || m.type === 'VoiceMessage';
}

/**
 * 消息是否直接 @ 了机器人本人。@everyone / @here / 角色提及不算召唤；
 * 回复机器人且带提醒时 Discord 会把机器人放进 mentions，等同于 @。
 */
export function isBotMentioned(
  m: { mentions?: { has(user: string, options?: Record<string, boolean>): boolean } },
  botUserId: string,
): boolean {
  if (!botUserId || !m.mentions) return false;
  return m.mentions.has(botUserId, { ignoreRoles: true, ignoreEveryone: true });
}

/** 去掉正文里对机器人的 @（`<@id>` / `<@!id>`），其他人的 @ 保持原样。 */
export function stripBotMention(content: string, botUserId: string): string {
  if (!botUserId) return content.trim();
  return content.split(`<@${botUserId}>`).join('').split(`<@!${botUserId}>`).join('').trim();
}
