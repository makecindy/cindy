/**
 * 群聊时间线里用户消息的附件（docs/product-rules/bot-group-chat.md §8）。
 *
 * 复用会话消息的附件条（MessageRenderer 的 AttachmentStrip）：图片按原始比例显示缩略图，
 * 经远程媒体从电脑取件，点开进入与聊天相同的看图器；文件是「类型图标 + 文件名」的小条。
 * 文件留在电脑上（手机拿不到路径），点一下只说明去电脑上打开，与交接文件一致。
 */
import { useMemo, useState } from 'react';
import { Alert, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BotGroupAttachment } from '@cindy/maker-shared/botGroupChat';
import { ImageLightbox } from './ImageLightbox';
import { AttachmentStrip } from './MessageRenderer';
import { buildMessageContentLayout } from './messageContentLayout';
import type { MobileMessageGalleryImage } from './messageGallery';
import type { NormalizedAttachment } from './messageNormalize';
import { buildAttachmentPayload, type MessagePayload } from './messagePayload';
import type { ResolveRemoteMediaFn } from './remoteMedia';

/** A group attachment in the shape session messages render; an image without an address is a file. */
export function botGroupAttachmentForDisplay(attachment: BotGroupAttachment): NormalizedAttachment {
  return attachment.category === 'image' && attachment.url
    ? { kind: 'image', name: attachment.name, uri: attachment.url, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}), previewable: false }
    : { kind: 'file', name: attachment.name, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}), previewable: false };
}

/** The message's pictures as one gallery, keyed like the strip's open payloads. */
export function botGroupAttachmentGallery(messageId: string, attachments: readonly NormalizedAttachment[]): MobileMessageGalleryImage[] {
  return attachments.flatMap((attachment, index) => {
    if (attachment.kind !== 'image') return [];
    const payload = buildAttachmentPayload(attachment);
    return payload.kind === 'media'
      ? [{ key: `${messageId}:attachment:${index}`, title: attachment.name, url: payload.media.url, payload, groupKey: messageId }]
      : [];
  });
}

export function BotGroupMessageAttachments({ messageId, attachments, onResolveRemoteMedia }: {
  messageId: string;
  attachments: readonly BotGroupAttachment[];
  onResolveRemoteMedia: ResolveRemoteMediaFn;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const layout = useMemo(() => buildMessageContentLayout({ screenWidth: width }), [width]);
  const items = useMemo(() => attachments.map(botGroupAttachmentForDisplay), [attachments]);
  const gallery = useMemo(() => botGroupAttachmentGallery(messageId, items), [items, messageId]);
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const open = (payload: MessagePayload) => {
    if (payload.kind === 'media' && payload.media.kind === 'image') {
      setOpenUrl(payload.media.url);
      return;
    }
    Alert.alert(payload.kind === 'file' ? payload.title : '', t('groupChat.files.onComputer'));
  };
  return <>
    <AttachmentStrip attachments={items} messageKey={messageId} align="right" layout={layout} onOpen={open}
      onResolveRemoteMedia={onResolveRemoteMedia} />
    {openUrl ? <ImageLightbox images={gallery} initialUrl={openUrl} onClose={() => setOpenUrl(null)}
      onResolveRemoteMedia={onResolveRemoteMedia} /> : null}
  </>;
}
