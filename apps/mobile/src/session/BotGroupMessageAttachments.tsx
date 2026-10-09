/**
 * 群聊时间线里各成员消息的附件（docs/product-rules/bot-group-chat.md §8）。
 *
 * 复用会话消息的附件条（MessageRenderer 的 AttachmentStrip）：图片按原始比例显示缩略图，
 * 经远程媒体从电脑取件，点开进入与聊天相同的看图器；文件是「类型图标 + 文件名」的小条。
 * 旧电脑文件仍提示在电脑打开；服务器附件点击时独立授权，图片复用看图器，文件使用短期下载地址。
 */
import { openBrowserAsync } from 'expo-web-browser';
import { useTheme } from '@/theme';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, View, useWindowDimensions } from 'react-native';
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

export function BotGroupMessageAttachments({ messageId, attachments, align, onResolveRemoteMedia, resolveServerMedia }: {
  messageId: string;
  attachments: readonly BotGroupAttachment[];
  align: 'left' | 'right';
  onResolveRemoteMedia: ResolveRemoteMediaFn;
  resolveServerMedia?: (id: string) => Promise<BotGroupAttachment>;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const layout = useMemo(() => buildMessageContentLayout({ screenWidth: width }), [width]);
  const items = useMemo(() => attachments.map(botGroupAttachmentForDisplay), [attachments]);
  const gallery = useMemo(() => botGroupAttachmentGallery(messageId, items), [items, messageId]);
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  if (resolveServerMedia) return <ServerAttachments attachments={attachments} align={align} resolve={resolveServerMedia} />;
  const open = (payload: MessagePayload) => {
    if (payload.kind === 'media' && payload.media.kind === 'image') {
      setOpenUrl(payload.media.url);
      return;
    }
    Alert.alert(payload.kind === 'file' ? payload.title : '', t('groupChat.files.onComputer'));
  };
  return <>
    <AttachmentStrip attachments={items} messageKey={messageId} align={align} layout={layout} onOpen={open}
      onResolveRemoteMedia={onResolveRemoteMedia} usePreviewState={useState} />
    {openUrl ? <ImageLightbox images={gallery} initialUrl={openUrl} onClose={() => setOpenUrl(null)}
      onResolveRemoteMedia={onResolveRemoteMedia} /> : null}
  </>;
}

/** Signed download URLs are acquired on tap and kept only in the open viewer. */
function ServerAttachments({ attachments, align, resolve }: {
  align: 'left' | 'right';
  attachments: readonly BotGroupAttachment[]; resolve(id: string): Promise<BotGroupAttachment>;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const layout = useMemo(() => buildMessageContentLayout({ screenWidth: width }), [width]);
  const [image, setImage] = useState<BotGroupAttachment | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const open = async (id: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(id);
    try {
      const value = await resolve(id);
      if (!mounted.current) return;
      if (!value.url) throw new Error('MEDIA_NOT_FOUND');
      if (value.category === 'image') setImage(value);
      else await openBrowserAsync(value.url);
    } catch { if (mounted.current) Alert.alert(t('groupChat.server.attachmentFailed')); }
    finally { pending.current = false; if (mounted.current) setBusy(null); }
  };
  return <>
    {attachments.map(attachment => <View key={attachment.id}>
      <AttachmentStrip attachments={[{ kind: 'file', name: attachment.name, previewable: false }]}
        messageKey={attachment.id} align={align} layout={layout} onOpen={() => { void open(attachment.id); }} usePreviewState={useState} />
      {busy === attachment.id ? <ActivityIndicator color={colors.textSecondary} /> : null}
    </View>)}
    {image?.url ? <ImageLightbox images={botGroupAttachmentGallery(image.id, [botGroupAttachmentForDisplay(image)])}
      initialUrl={image.url} onClose={() => setImage(null)} /> : null}
  </>;
}
