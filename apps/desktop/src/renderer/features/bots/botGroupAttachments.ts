/**
 * 群聊附件的 renderer 侧转换（docs/product-rules/bot-group-chat.md §3.1）。
 *
 * 托盘沿用普通聊天的 `useAttachments`：图片照常缓存进媒体总仓（`cindy-media://`），
 * 其余文件就地用本机路径。`useAttachments` 只在有 scope 时才走缓存（否则落内存
 * base64，main 会拒收），而 main 的图片缓存并不按 scope 落盘——所以给每个群一个
 * 稳定、不会与真实任务 id 撞上的 scope，同时用作输入框草稿键。
 */
import { serializeAttachedFiles } from '@/lib/messageAttachmentPayload';
import type { AttachedFile } from '@/lib/fileTypes';
import type { BotGroupAttachment, BotGroupAttachmentInput } from '../../../shared/botGroupChat';

/** Attachment cache scope and composer draft key of one group (never a task id). */
export function botGroupAttachmentScope(groupId: string): string {
  return `bot-group:${groupId}`;
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

/** A sent message's images (shown as pictures) and other files (shown as chips). */
export function splitBotGroupMessageAttachments(attachments: readonly BotGroupAttachment[]): {
  images: Array<BotGroupAttachment & { url: string }>;
  files: Array<BotGroupAttachment & { path: string }>;
} {
  const images: Array<BotGroupAttachment & { url: string }> = [];
  const files: Array<BotGroupAttachment & { path: string }> = [];
  for (const attachment of attachments) {
    const { url, path } = attachment;
    if (attachment.category === 'image' && url) images.push({ ...attachment, url });
    else if (path) files.push({ ...attachment, path });
  }
  return { images, files };
}
