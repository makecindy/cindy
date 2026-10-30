/**
 * 群聊附件的 renderer 侧转换（docs/product-rules/bot-group-chat.md §3.1）。
 *
 * 托盘沿用普通聊天的 `useAttachments`：图片照常缓存进媒体总仓（`cindy-media://`），
 * 其余文件就地用本机路径。`useAttachments` 只在有 scope 时才走缓存（否则落内存
 * base64，main 会拒收），而 main 的图片缓存并不按 scope 落盘——所以给每个群一个
 * 稳定、不会与真实任务 id 撞上的 scope，同时用作输入框草稿键。
 */
import type { JSONContent } from '@tiptap/core';
import { serializeAttachedFiles } from '@/lib/messageAttachmentPayload';
import { categorizeFile, extractExt, type AttachedFile } from '@/lib/fileTypes';
import type { BotGroupAttachment, BotGroupAttachmentInput, BotGroupMessageView } from '../../../shared/botGroupChat';

/** Attachment cache scope and composer draft key of one group (never a task id). */
export function botGroupAttachmentScope(groupId: string): string {
  return `bot-group:${groupId}`;
}

/** Draft key of a 话题's reply box; text only (thread replies carry no attachments). */
export function botGroupThreadDraftKey(groupId: string, rootId: string): string {
  return `${botGroupAttachmentScope(groupId)}:thread:${rootId}`;
}

/**
 * The group composer is a plain textarea, so its draft text is stored in the shared draft
 * store as one paragraph per line — a document the store understands (draft presence, owner
 * scoping) and that reads back to exactly the same text.
 */
export function botGroupDraftDoc(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
  };
}

export function botGroupDraftText(doc: JSONContent | null | undefined): string {
  if (!doc) return '';
  const textOf = (node: JSONContent): string =>
    node.type === 'text' ? node.text ?? '' : node.type === 'hardBreak' ? '\n' : (node.content ?? []).map(textOf).join('');
  return (doc.content ?? []).map(textOf).join('\n');
}

/** A tray file as the optimistic copy of a message shows it before main has it. */
export function botGroupAttachmentPreview(file: AttachedFile): BotGroupAttachment {
  return {
    id: file.id,
    name: file.name,
    category: file.category,
    mimeType: file.mimeType,
    size: file.size,
    url: file.url ?? null,
    path: file.path || null,
  };
}

/** The tray's files in the shape `sendBotGroupMessage` takes. */
export function toBotGroupAttachmentInputs(files: readonly AttachedFile[]): BotGroupAttachmentInput[] {
  return (serializeAttachedFiles(files) ?? []).map((file) => ({
    id: file.id,
    name: file.name,
    path: file.path,
    ext: file.ext,
    size: file.size,
    category: file.category,
    mimeType: file.mimeType,
    ...(file.url ? { url: file.url } : {}),
    ...(file.originalName ? { originalName: file.originalName } : {}),
    ...(file.annotated ? { annotated: true } : {}),
  }));
}

/**
 * What the send's idempotency key covers besides the text: the same files with the
 * same annotations. Anything else is a different message and gets a new clientId.
 */
export function botGroupAttachmentSignature(files: readonly AttachedFile[]): string {
  return JSON.stringify(
    files.map((file) => [file.id, file.url ?? file.path, file.annotationStrokes ?? null]),
  );
}

/** An attachment that cannot be opened here yet, shown with its loading or failed state. */
export interface BotGroupPendingSlot {
  kind: 'pending';
  attachment: BotGroupAttachment;
  state: NonNullable<BotGroupAttachment['state']>;
  /** Judged by the name until the bytes arrive: drawn as a picture placeholder. */
  image: boolean;
}
export type BotGroupAttachmentSlot =
  | { kind: 'image'; attachment: BotGroupAttachment; url: string }
  | { kind: 'file'; attachment: BotGroupAttachment; path: string }
  | BotGroupPendingSlot;
/** A picture (or its placeholder) on its own, or consecutive file chips sharing a row. */
export type BotGroupAttachmentRow =
  | { kind: 'picture'; slot: BotGroupAttachmentSlot }
  | { kind: 'chips'; slots: BotGroupAttachmentSlot[] };

/**
 * A sent message's attachments in the order they were sent: each slot is drawn as what
 * it is — a picture, an openable file chip, or its loading / failed state — and only
 * neighbouring chips are grouped, so an attachment keeps its place while it loads,
 * fails or arrives, whatever kind it turns out to be.
 */
export function botGroupAttachmentRows(attachments: readonly BotGroupAttachment[]): BotGroupAttachmentRow[] {
  const rows: BotGroupAttachmentRow[] = [];
  for (const attachment of attachments) {
    const { url, path } = attachment;
    const slot: BotGroupAttachmentSlot = !attachment.state && attachment.category === 'image' && url
      ? { kind: 'image', attachment, url }
      : !attachment.state && path
        ? { kind: 'file', attachment, path }
        // Nothing to open on this computer is never a silent omission.
        : { kind: 'pending', attachment, state: attachment.state ?? 'unavailable',
            image: attachment.category === 'image' || categorizeFile(extractExt(attachment.name)) === 'image' };
    const picture = slot.kind === 'image' || (slot.kind === 'pending' && slot.image);
    const last = rows.at(-1);
    if (picture) rows.push({ kind: 'picture', slot });
    else if (last?.kind === 'chips') last.slots.push(slot);
    else rows.push({ kind: 'chips', slots: [slot] });
  }
  return rows;
}

/**
 * A refresh re-reads only the newest page, so messages loaded from earlier pages keep
 * the attachment views they arrived with. Re-read the pages holding messages whose
 * attachments are not here yet (newest first) and swap in the fresh copies; nothing
 * outside the loaded range is added. Messages from `latestFrom` on are the page just
 * read and are left alone. Both states count: `loading` settles into the result, and
 * reading an `unavailable` one is what lets main retry it once its backoff is over,
 * the same retry-on-read the newest page gets. A single change push may stand for many
 * finished downloads, so every such message in this loaded set is covered: each read
 * settles at least the newest one still pending, so there are never more reads than
 * pending pages. A failed or no-longer-current read (`null`) stops the round.
 */
export async function refreshPendingBotGroupAttachments(
  loaded: readonly BotGroupMessageView[],
  latestFrom: number,
  readBefore: (before: number) => Promise<readonly BotGroupMessageView[] | null>,
): Promise<BotGroupMessageView[] | null> {
  const notHere = (message: BotGroupMessageView) =>
    message.sequence < latestFrom && message.attachments.some((attachment) => attachment.state !== undefined);
  let pending = loaded.filter(notHere).map((message) => message.sequence).sort((a, b) => b - a);
  if (pending.length === 0) return null;
  const bySequence = new Map(loaded.map((message) => [message.sequence, message]));
  while (pending.length > 0) {
    const newest = pending[0]!;
    const page = await readBefore(newest + 1);
    if (!page || page.length === 0) break;
    for (const message of page) if (bySequence.has(message.sequence)) bySequence.set(message.sequence, message);
    const oldest = Math.min(...page.map((message) => message.sequence));
    // A page always reaches `newest`; the guard only keeps a malformed page from looping.
    pending = pending.filter((sequence) => sequence < Math.min(oldest, newest));
  }
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}
