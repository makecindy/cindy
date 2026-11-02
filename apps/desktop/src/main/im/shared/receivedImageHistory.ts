import type { IMAttachment } from '@cindy/im';
import { parseBlobUrl } from '../../cindy-media/blobStore';
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
