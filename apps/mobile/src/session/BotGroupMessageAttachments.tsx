/**
 * 群聊时间线里各成员消息的附件（docs/product-rules/bot-group-chat.md §8）。
 *
 * 复用会话消息的附件条（MessageRenderer 的 AttachmentStrip）：图片按原始比例显示缩略图，
 * 经远程媒体从电脑取件，点开进入与聊天相同的看图器；文件是「类型图标 + 文件名」的小条。
 * 旧电脑文件仍提示在电脑打开；服务器图片授权后显示预览，点击时重新授权；文件使用短期下载地址。
 */
import { useAuth } from '@/auth/AuthContext';
import { openBrowserAsync } from 'expo-web-browser';
import { Text } from '@/components/AppText';
import { spacing, textStyles, useTheme } from '@/theme';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BotGroupAttachment } from '@cindy/maker-shared/botGroupChat';
import { ImageLightbox } from './ImageLightbox';
import { MessageListVisibilityContext, useMessageListItemVisible } from './messageListVisibility';
import { AttachmentStrip } from './MessageRenderer';
import { buildMessageContentLayout } from './messageContentLayout';
import type { MobileMessageGalleryImage } from './messageGallery';
import type { NormalizedAttachment } from './messageNormalize';
import { buildAttachmentPayload, isPayloadDirectPreviewableUrl, type MessagePayload } from './messagePayload';
import type { ResolveRemoteMediaFn } from './remoteMedia';

/**
 * A group attachment in the shape session messages render; an image without an address is a file.
 * An authorized HTTPS image loads directly; `cindy-media://` and older media addresses are fetched from the computer.
 */
export function botGroupAttachmentForDisplay(attachment: BotGroupAttachment): NormalizedAttachment {
  return attachment.category === 'image' && attachment.url
    ? { kind: 'image', name: attachment.name, uri: attachment.url, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      previewable: isPayloadDirectPreviewableUrl(attachment.url) }
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

export function BotGroupMessageAttachments({ messageId, attachments, align, onResolveRemoteMedia, resolveServerMedia, previewServerImages = true }: {
  messageId: string;
  attachments: readonly BotGroupAttachment[];
  align: 'left' | 'right';
  onResolveRemoteMedia: ResolveRemoteMediaFn;
  resolveServerMedia?: (id: string, signal?: AbortSignal) => Promise<BotGroupAttachment>;
  /** Cloud transcripts keep the tap-only contract in cloud-companions.md §3.1. */
  previewServerImages?: boolean;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const { accountGeneration } = useAuth();
  const visibility = useContext(MessageListVisibilityContext);
  const rowVisible = useMessageListItemVisible(messageId);
  const previewVisible = previewServerImages && (!visibility || rowVisible);
  const layout = useMemo(() => buildMessageContentLayout({ screenWidth: width }), [width]);
  const items = useMemo(() => attachments.filter(attachment => !attachment.state).map(botGroupAttachmentForDisplay), [attachments]);
  const gallery = useMemo(() => botGroupAttachmentGallery(messageId, items), [items, messageId]);
  const runs = useMemo(() => botGroupAttachmentRuns(attachments), [attachments]);
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  if (resolveServerMedia) return <ServerAttachments key={`${accountGeneration}:${messageId}`} runs={runs} visible={previewVisible}
    previewServerImages={previewServerImages} align={align} layout={layout} resolve={resolveServerMedia} />;
  const open = (payload: MessagePayload) => {
    if (payload.kind === 'media' && payload.media.kind === 'image') {
      setOpenUrl(payload.media.url);
      return;
    }
    Alert.alert(payload.kind === 'file' ? payload.title : '', t('groupChat.files.onComputer'));
  };
  return <>
    {/* Sent order: an attachment the computer has not fetched yet keeps its place with its state. */}
    {runs.map((run, index) => run.kind === 'pending'
      ? <PendingAttachment key={run.attachment.id} attachment={run.attachment} align={align} layout={layout} />
      : <AttachmentStrip key={index === 0 ? messageId : `${messageId}:${index}`} attachments={run.attachments.map(botGroupAttachmentForDisplay)}
        messageKey={index === 0 ? messageId : `${messageId}:${index}`} align={align} layout={layout} onOpen={open}
        onResolveRemoteMedia={onResolveRemoteMedia} usePreviewState={useState} />)}
    {openUrl ? <ImageLightbox images={gallery} initialUrl={openUrl} onClose={() => setOpenUrl(null)}
      onResolveRemoteMedia={onResolveRemoteMedia} /> : null}
  </>;
}

/**
 * The message's attachments in sent order. `AttachmentStrip` draws its pictures before its
 * files, so a strip only ever holds neighbours of one display kind; each attachment not on
 * the computer yet stands alone.
 */
export function botGroupAttachmentRuns(attachments: readonly BotGroupAttachment[]): Array<
  { kind: 'ready'; display: NormalizedAttachment['kind']; attachments: BotGroupAttachment[] }
  | { kind: 'pending'; attachment: BotGroupAttachment & { state: NonNullable<BotGroupAttachment['state']> } }
> {
  const runs: ReturnType<typeof botGroupAttachmentRuns> = [];
  for (const attachment of attachments) {
    const { state } = attachment;
    if (state) { runs.push({ kind: 'pending', attachment: { ...attachment, state } }); continue; }
    const display = botGroupAttachmentForDisplay(attachment).kind;
    const last = runs.at(-1);
    if (last?.kind === 'ready' && last.display === display) last.attachments.push(attachment);
    else runs.push({ kind: 'ready', display, attachments: [attachment] });
  }
  return runs;
}

/** The same file chip, plus the computer's loading / unavailable state; tapping explains it. */
function PendingAttachment({ attachment, align, layout }: {
  attachment: BotGroupAttachment & { state: NonNullable<BotGroupAttachment['state']> };
  align: 'left' | 'right';
  layout: ReturnType<typeof buildMessageContentLayout>;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const loading = attachment.state === 'loading';
  const status = t(loading ? 'groupChat.files.loading' : 'groupChat.files.unavailable');
  return <View accessibilityLabel={`${attachment.name}, ${status}`} style={{ alignItems: align === 'right' ? 'flex-end' : 'flex-start', gap: spacing.xs }}>
    <AttachmentStrip attachments={[{ kind: 'file', name: attachment.name, previewable: false }]} messageKey={attachment.id} align={align} layout={layout}
      onOpen={() => Alert.alert(attachment.name, status)} usePreviewState={useState} />
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
      {loading ? <ActivityIndicator size="small" color={colors.textTertiary} /> : null}
      <Text style={[textStyles.caption, { color: colors.textTertiary }]}>{status}</Text>
    </View>
  </View>;
}

// Bound passive authorization across mounted messages; no account data or URLs are cached here.
type PreviewJob = {
  run(signal: AbortSignal): Promise<void>;
  controller: AbortController;
  active: boolean;
  finished: boolean;
};
const previewJobs: PreviewJob[] = [];
let activePreviews = 0;
function finishPreview(job: PreviewJob) {
  if (job.finished) return;
  job.finished = true;
  if (job.active) activePreviews--;
  else {
    const index = previewJobs.indexOf(job);
    if (index >= 0) previewJobs.splice(index, 1);
  }
  drainPreviews();
}
function authorizePreview(run: PreviewJob['run']): () => void {
  const job: PreviewJob = { run, controller: new AbortController(), active: false, finished: false };
  previewJobs.push(job);
  drainPreviews();
  return () => {
    if (job.finished) return;
    job.controller.abort();
    finishPreview(job);
  };
}
function drainPreviews() {
  while (activePreviews < 3 && previewJobs.length) {
    const job = previewJobs.shift()!;
    job.active = true;
    activePreviews++;
    void job.run(job.controller.signal).then(() => finishPreview(job), () => finishPreview(job));
  }
}

/** Image preview URLs live only in this mounted message; opening always re-authorizes. */
function ServerAttachments({ runs, visible, previewServerImages, align, layout, resolve }: {
  visible: boolean;
  previewServerImages: boolean;
  align: 'left' | 'right';
  runs: ReturnType<typeof botGroupAttachmentRuns>;
  layout: ReturnType<typeof buildMessageContentLayout>;
  resolve(id: string, signal?: AbortSignal): Promise<BotGroupAttachment>;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [previews, setPreviews] = useState<Record<string, BotGroupAttachment>>({});
  const failedPreviewIds = useRef(new Set<string>());
  const retriedPreviewIds = useRef(new Set<string>());
  const retryPreview = useRef<((id: string) => void) | null>(null);
  const [previewVersions, setPreviewVersions] = useState<Record<string, number>>({});
  const resolveRef = useRef(resolve); resolveRef.current = resolve;
  const previewsRef = useRef(previews); previewsRef.current = previews;
  const previewIds = JSON.stringify(runs.flatMap(run => run.kind === 'ready' ? run.attachments.map(item => item.id) : []));
  useEffect(() => {
    let cancelled = false;
    if (!visible) return;
    const cancelJobs: Array<() => void> = [];
    const schedule = (id: string) => {
      cancelJobs.push(authorizePreview(async signal => {
        if (cancelled || (previewsRef.current[id] && !failedPreviewIds.current.has(id))) return;
        const refreshing = failedPreviewIds.current.has(id);
        const previousPreview = previewsRef.current[id];
        try {
          const value = await resolveRef.current(id, signal);
          const preview = value.category === 'image' ? value : { ...value, url: null };
          if (!cancelled && !signal.aborted && previewsRef.current[id] === previousPreview) {
            previewsRef.current = { ...previewsRef.current, [id]: preview };
            setPreviews(previewsRef.current);
            failedPreviewIds.current.delete(id);
            // A renewed authorization can return the same URL after a transient CDN failure.
            // Remount only the failed image too, resetting its native error state.
            if (refreshing) setPreviewVersions(versions => ({ ...versions, [id]: (versions[id] ?? 0) + 1 }));
          }
        } catch {
          if (!cancelled && previewsRef.current[id] === previousPreview) failedPreviewIds.current.delete(id);
          // Keep the chip / fallback available for an explicit retry on tap.
        }
      }));
    };
    retryPreview.current = schedule;
    for (const id of JSON.parse(previewIds) as string[]) schedule(id);
    return () => {
      cancelled = true;
      retryPreview.current = null;
      cancelJobs.forEach(cancel => cancel());
    };
  }, [previewIds, visible]);
  const displayRuns = botGroupAttachmentRuns(runs.flatMap(run => run.kind === 'pending'
    ? [run.attachment] : run.attachments.map(item => previews[item.id] ?? { ...item, url: null })));
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
      if (value.category === 'image') {
        setImage(value);
        // Cloud transcripts never populate this cache: their media remains tap-only.
        if (previewServerImages) {
          previewsRef.current = { ...previewsRef.current, [id]: value };
          setPreviews(previewsRef.current);
          failedPreviewIds.current.delete(id);
          setPreviewVersions(versions => ({ ...versions, [id]: (versions[id] ?? 0) + 1 }));
        }
      }
      else await openBrowserAsync(value.url);
    } catch { if (mounted.current) Alert.alert(t('groupChat.server.attachmentFailed')); }
    finally { pending.current = false; if (mounted.current) setBusy(null); }
  };
  return <>
    {/* Stretch like a session strip, so the chip keeps the same width as in a task message. */}
    {displayRuns.map(run => run.kind === 'pending'
      ? <PendingAttachment key={run.attachment.id} attachment={run.attachment} align={align} layout={layout} />
      : <View key={run.attachments[0]!.id} style={styles.serverAttachment}>
        <AttachmentStrip attachments={run.attachments.map(botGroupAttachmentForDisplay)}
          imageReloadKeys={run.attachments.map(item => previewVersions[item.id] ?? 0)}
          messageKey={run.attachments[0]!.id} align={align} layout={layout}
          onOpen={payload => {
            if (payload.kind === 'media') {
              const attachment = run.attachments.find(item => item.url === payload.media.url);
              if (attachment) void open(attachment.id);
            }
          }}
          onImageError={index => {
            const attachment = run.attachments[index];
            if (!attachment || retriedPreviewIds.current.has(attachment.id)
              || previewsRef.current[attachment.id]?.url !== attachment.url) return;
            retriedPreviewIds.current.add(attachment.id);
            failedPreviewIds.current.add(attachment.id);
            retryPreview.current?.(attachment.id);
          }}
          onOpenFile={index => { void open(run.attachments[index]!.id); }} usePreviewState={useState} />
        {run.attachments.some(attachment => busy === attachment.id)
          ? <ActivityIndicator color={colors.textSecondary} style={align === 'right' ? styles.busyRight : styles.busyLeft} />
          : null}
      </View>)}
    {image?.url ? <ImageLightbox images={botGroupAttachmentGallery(image.id, [botGroupAttachmentForDisplay(image)])}
      initialUrl={image.url} onClose={() => setImage(null)} /> : null}
  </>;
}

const styles = StyleSheet.create({
  serverAttachment: { alignSelf: 'stretch' },
  busyLeft: { alignSelf: 'flex-start' },
  busyRight: { alignSelf: 'flex-end' },
});
