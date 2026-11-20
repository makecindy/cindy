import type { IMAttachment } from '@cindy/im';
import { stat } from 'node:fs/promises';
import { getBlobInfo } from '../../cindy-media/ledger';
import { getCurrentDbClientSnapshot } from '../../localDb/client/current';
import { getGroupHistoryImages, type GroupHistorySearchLane } from './groupHistorySearch';
import { parseBlobUrl, resolveSafe } from '../../cindy-media/blobStore.desktop';
import type { GroupHistoryAccessScope } from './groupHistoryAccess';
import { DEFAULT_GROUP_WINDOW_RETENTION, recordGroupWindowEntry } from './groupWindowCore';

/** Only host-received, managed media is indexed; never accept a filesystem path or CDN URL. */
export function receivedImageRefs(attachments: readonly IMAttachment[]) {
  return attachments
    .flatMap((attachment) =>
      attachment.url &&
      parseBlobUrl(attachment.url) &&
      /^image\/(png|jpeg|gif|webp)$/.test(attachment.mimeType)
        ? [
            {
              fileId: attachment.url,
              name: attachment.originalName.slice(0, 256),
              mimeType: attachment.mimeType,
            },
          ]
        : [],
    )
    .slice(0, 4);
}

export function receivedHistoryScope(
  channel: string,
  botId: string,
  chatId: string,
  threadId = '',
): GroupHistoryAccessScope {
  const provider = `${channel}-personal:${botId}`;
  return { access: 'lane', provider, lane: { provider, chatId, threadId } };
}

export async function recordReceivedImageMessage(args: {
  scope: GroupHistoryAccessScope;
  messageId: string;
  text: string;
  attachments: readonly IMAttachment[];
  author?: string;
  chatName?: string;
  protectedContent?: boolean;
}): Promise<void> {
  if (!args.scope.lane || args.protectedContent) return;
  const refs = receivedImageRefs(args.attachments);
  // Text-only history already belongs to the channel/session. This index adds only images.
  if (!refs.length) return;
  await recordGroupWindowEntry(
    {
      ...args.scope.lane,
      messageId: args.messageId,
      text: args.text,
      author: { name: args.author ?? 'user' },
      chatName: args.chatName,
      fileNames: args.attachments.map((attachment) => attachment.originalName),
      imageRefs: refs,
      sentAt: Date.now(),
    },
    DEFAULT_GROUP_WINDOW_RETENTION,
  );
}

/** Materialize only images indexed on the selected window rows in this account and lane. */
export async function receivedWindowImages(lane: GroupHistorySearchLane, messageIds: readonly string[],
  currentFiles: readonly IMAttachment[]): Promise<IMAttachment[]> {
  if (!messageIds.length) return [];
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) return [];
  const available = Math.max(0, 6 - currentFiles.filter(file => file.kind === 'image').length);
  const seen = new Set(currentFiles.map(file => file.url));
  const images: IMAttachment[] = [];
  for (const messageId of [...messageIds].reverse()) {
    if (images.length >= available) break;
    if (getCurrentDbClientSnapshot() !== snapshot) return [];
    const row = await getGroupHistoryImages({ lane, messageId });
    for (const ref of row?.imageRefs ?? []) {
      if (images.length >= available || seen.has(ref.fileId) || !parseBlobUrl(ref.fileId)) continue;
      const blob = resolveSafe(ref.fileId);
      const info = await getBlobInfo(blob.hash, snapshot.client.drizzle);
      if (!info || info.bytes > 20 * 1024 * 1024 || info.mimeType !== ref.mimeType) continue;
      const disk = await stat(blob.absPath).catch(() => null);
      if (!disk?.isFile() || !disk.size || disk.size !== info.bytes) continue;
      images.push({ kind: 'image', originalName: ref.name, mimeType: info.mimeType, absPath: blob.absPath, url: ref.fileId });
      seen.add(ref.fileId);
    }
  }
  return getCurrentDbClientSnapshot() === snapshot ? images : [];
}
