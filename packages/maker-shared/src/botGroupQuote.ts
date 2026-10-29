/**
 * 群聊「引用回复」(docs/product-rules/bot-group-chat.md §10「引用回复」)。
 *
 * 引用是主时间线上的一条新消息，带着被引用消息的作者与摘要；它不是 Thread（话题），
 * 发送端会把被引用的在群伙伴加入点名。服务器的 `replyToId` 只允许指向同一 Thread 内的消息，所以主时间线的
 * 引用以版本化卡片块持久化：与 `cindy.plan`、`cindy.membership` 同一扩展机制，由
 * Chat Server 保存与同步；不认识它的旧端读到 `fallback` 里可读的 Markdown 引用行。
 *
 * 摘要只是发送时的快照：原消息仍在已加载的时间线里时一律以原消息为准（含已删除），
 * 只有原消息不在本端时才显示快照。卡片内容是群成员提交的数据，读取时逐字段校验，
 * 不能当作指令或授权，也不能指向别的群或 Thread。
 */
import { botGroupMessageSummaryText } from './botGroupTask';
import type { BotGroupAttachment, BotGroupMessageView } from './botGroupChat';

export const BOT_GROUP_QUOTE_NAMESPACE = 'cindy.quote';
export const BOT_GROUP_QUOTE_SCHEMA_REVISION = 1;
/** Characters kept in a snapshot; the UI clamps further to one or two lines. */
export const BOT_GROUP_QUOTE_EXCERPT_MAX = 280;
const AUTHOR_NAME_MAX = 200;
const ATTACHMENT_NAME_MAX = 255;
const FALLBACK_MAX = 4000;

/** The quoted message as a reader sees it. */
export interface BotGroupQuoteView {
  /** Main-timeline message of the same group. */
  messageId: string;
  /** Author name snapshot taken when the quote was sent. */
  authorName: string;
  authorKind: 'user' | 'bot';
  /** Collapsed plain text; empty when the quoted message only carried attachments. */
  excerpt: string;
  attachmentCount: number;
  /** First attachment's name for the summary; null without attachments. */
  attachmentName: string | null;
  /** Server sequence of the quoted message; null when unknown. */
  sequence: number | null;
  /**
   * A reader that drops deleted messages from its timeline (the phone's direct view) still
   * knows the original is gone; the snapshot must not outlive it there either.
   */
  originalDeleted?: boolean;
}

/** What a composer sends: the host reads the quoted message and builds the snapshot itself. */
export interface BotGroupQuoteInput {
  messageId: string;
}

export interface BotGroupQuoteCard {
  type: 'card';
  namespace: typeof BOT_GROUP_QUOTE_NAMESPACE;
  schemaRevision: typeof BOT_GROUP_QUOTE_SCHEMA_REVISION;
  fallback: string;
  data: {
    messageId: string;
    authorName: string;
    authorKind: 'user' | 'bot';
    excerpt: string;
    attachmentCount: number;
    attachmentName: string | null;
    seq: string | null;
  };
}

/**
 * The attachment a quote names: the first with a name. A server attachment that has not
 * downloaded yet is a placeholder with only its id and (possibly empty) name.
 */
/** The attachment a quote names: the first named one, `…` when none has a name. */
export function botGroupQuoteAttachmentName(attachments: readonly Pick<BotGroupAttachment, 'name'>[]): string | null {
  if (!attachments.length) return null;
  const named = attachments.find(attachment => attachment.name.trim());
  return named ? clip(named.name.trim(), ATTACHMENT_NAME_MAX) : '…';
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/** One-line excerpt of a message body: whitespace collapsed, bounded. */
export function botGroupQuoteExcerpt(text: string): string {
  return clip(text.replace(/\s+/g, ' ').trim(), BOT_GROUP_QUOTE_EXCERPT_MAX);
}

/** Snapshot of a message the reader can see, e.g. when picking 引用回复 in a timeline. */
export function botGroupQuoteFromMessage(message: Pick<BotGroupMessageView,
  'id' | 'sequence' | 'authorKind' | 'authorName' | 'content' | 'task' | 'deleted'> & { attachments: readonly Pick<BotGroupAttachment, 'name'>[] }): BotGroupQuoteView {
  return {
    messageId: message.id,
    authorName: clip(message.authorName.trim(), AUTHOR_NAME_MAX),
    authorKind: message.authorKind === 'user' ? 'user' : 'bot',
    excerpt: botGroupQuoteExcerpt(botGroupMessageSummaryText(message)),
    attachmentCount: message.attachments.length,
    attachmentName: botGroupQuoteAttachmentName(message.attachments),
    sequence: Number.isSafeInteger(message.sequence) && message.sequence > 0 ? message.sequence : null,
  };
}

/**
 * A main-timeline message that can be quoted: a real chat message that still exists. A thread
 * share is not: its own text is only the card's fallback, never the reply it points at.
 */
export function isBotGroupMessageQuotable(message: Pick<BotGroupMessageView, 'kind' | 'deleted' | 'threadRootId' | 'authorKind' | 'threadShare'>): boolean {
  return message.kind === 'message' && message.deleted !== true && !message.threadRootId && message.authorKind !== 'system' && !message.threadShare;
}

/** Language-neutral Markdown for clients that do not know the card. */
function fallbackText(quote: BotGroupQuoteView): string {
  const attached = quote.attachmentName
    ? `📎 ${quote.attachmentName}${quote.attachmentCount > 1 ? ` +${quote.attachmentCount - 1}` : ''}`
    : '';
  const body = [quote.excerpt, attached].filter(Boolean).join(' ') || '…';
  return clip(`> ${quote.authorName}: ${body}`, FALLBACK_MAX);
}

export function buildBotGroupQuoteCard(quote: BotGroupQuoteView): BotGroupQuoteCard {
  return {
    type: 'card',
    namespace: BOT_GROUP_QUOTE_NAMESPACE,
    schemaRevision: BOT_GROUP_QUOTE_SCHEMA_REVISION,
    fallback: fallbackText(quote),
    data: {
      messageId: quote.messageId,
      authorName: quote.authorName,
      authorKind: quote.authorKind,
      excerpt: quote.excerpt,
      attachmentCount: quote.attachmentCount,
      attachmentName: quote.attachmentName,
      seq: quote.sequence === null ? null : String(quote.sequence),
    },
  };
}

const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A valid revision-1 quote card, or null. Anything else — another revision, a damaged or
 * oversized field — is not a quote, and its `fallback` stays readable as ordinary text.
 */
export function readBotGroupQuoteCard(block: unknown): BotGroupQuoteView | null {
  if (!block || typeof block !== 'object') return null;
  const value = block as { type?: unknown; namespace?: unknown; schemaRevision?: unknown; data?: unknown };
  if (value.type !== 'card' || value.namespace !== BOT_GROUP_QUOTE_NAMESPACE
    || value.schemaRevision !== BOT_GROUP_QUOTE_SCHEMA_REVISION) return null;
  const data = value.data && typeof value.data === 'object' && !Array.isArray(value.data)
    ? value.data as Record<string, unknown> : null;
  return data ? quoteFromFields(data) : null;
}

/**
 * A quote as a controller receives it in a message view (the computer's projection over
 * device-link). Same field rules as the card; only the order field is a number here.
 */
export function parseBotGroupQuoteView(value: unknown): BotGroupQuoteView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { sequence } = record;
  if (sequence !== null && (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1)) return null;
  const quote = quoteFromFields({ ...record, seq: sequence === null ? null : String(sequence) });
  return quote && record.originalDeleted === true ? { ...quote, originalDeleted: true } : quote;
}

function quoteFromFields(data: Record<string, unknown>): BotGroupQuoteView | null {
  const { messageId, authorName, authorKind, excerpt, attachmentCount, attachmentName, seq } = data;
  if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) return null;
  if (typeof authorName !== 'string' || !authorName.trim() || Array.from(authorName).length > AUTHOR_NAME_MAX) return null;
  if (authorKind !== 'user' && authorKind !== 'bot') return null;
  if (typeof excerpt !== 'string' || Array.from(excerpt).length > BOT_GROUP_QUOTE_EXCERPT_MAX) return null;
  if (typeof attachmentCount !== 'number' || !Number.isInteger(attachmentCount) || attachmentCount < 0 || attachmentCount > 100) return null;
  if (attachmentName !== null && (typeof attachmentName !== 'string' || Array.from(attachmentName).length > ATTACHMENT_NAME_MAX)) return null;
  if ((attachmentCount === 0) !== (attachmentName === null)) return null;
  if (seq !== null && seq !== undefined && (typeof seq !== 'string' || !/^[1-9][0-9]{0,15}$/.test(seq))) return null;
  return {
    messageId,
    authorName: authorName.trim(),
    authorKind,
    excerpt: botGroupQuoteExcerpt(excerpt),
    attachmentCount,
    attachmentName,
    sequence: typeof seq === 'string' ? Number(seq) : null,
  };
}

/** The first valid quote card of a message's content blocks. */
export function readBotGroupQuote(content: readonly unknown[]): BotGroupQuoteView | null {
  for (const block of content) {
    const quote = readBotGroupQuoteCard(block);
    if (quote) return quote;
  }
  return null;
}

/**
 * How a quote reads right now. `live` and `deleted` come from the original in the loaded
 * main timeline of the same group; `snapshot` means the original is not loaded here.
 * Only main-timeline messages can match, so a quote never resolves into a Thread.
 */
export type BotGroupQuoteDisplay =
  | { state: 'live'; authorName: string; excerpt: string; attachmentCount: number; attachmentName: string | null }
  | { state: 'snapshot'; authorName: string; excerpt: string; attachmentCount: number; attachmentName: string | null }
  | { state: 'deleted'; authorName: string };

export function resolveBotGroupQuote(
  quote: BotGroupQuoteView,
  loaded: readonly Pick<BotGroupMessageView, 'id' | 'deleted' | 'threadRootId' | 'authorName' | 'content' | 'attachments' | 'task'>[],
): BotGroupQuoteDisplay {
  const original = loaded.find((message) => message.id === quote.messageId && !message.threadRootId);
  if (quote.originalDeleted) return { state: 'deleted', authorName: original?.authorName || quote.authorName };
  if (!original) return { state: 'snapshot', authorName: quote.authorName, excerpt: quote.excerpt,
    attachmentCount: quote.attachmentCount, attachmentName: quote.attachmentName };
  if (original.deleted) return { state: 'deleted', authorName: original.authorName || quote.authorName };
  // A loaded original may not have its attachments yet (still downloading, or failed);
  // the snapshot's summary stands in until they are there.
  const attachments: readonly Pick<BotGroupAttachment, 'name'>[] = original.attachments;
  return {
    state: 'live',
    authorName: original.authorName || quote.authorName,
    excerpt: botGroupQuoteExcerpt(botGroupMessageSummaryText(original)),
    ...(attachments.length
      ? { attachmentCount: attachments.length, attachmentName: botGroupQuoteAttachmentName(attachments) }
      : { attachmentCount: quote.attachmentCount, attachmentName: quote.attachmentName }),
  };
}
