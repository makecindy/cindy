import {
  collectMobileMarkdownImages,
  isMobileMarkdownImageDirectUrl,
  mobileMarkdownImageTitle,
  mobileMarkdownManagedImagePreviewUrl,
} from '@/session/messageMarkdown';
import type { NormalizedRemoteMessage, NormalizedToolMedia } from '@/session/messageNormalize';
import type { MessagePayload } from '@/session/messagePayload';
import { buildAttachmentPayload, buildMediaPayload, payloadMediaKindLabel } from '@/session/messagePayload';
import type { MobileMessageRenderItem, MobileWorkChildItem } from '@/session/messageRenderModel';
import { logUnhandledRenderItem } from '@/session/assertNever';
import { applySentAttachmentThumbOverlay, getSentAttachmentThumbUri } from '@/session/sentAttachmentThumbStore';
import { sentImageGalleryKey, type GetSentMessageImagePreview } from '@/session/sentMessageImagePreviews';
import { i18n } from '@/i18n';
import { svgAttachmentForDisplay } from '@/session/messageAttachments';
import { pendingSendGalleryImage } from '@/session/pendingSendImages';

/**
 * 全屏查看器的一页:图片或视频(同一条消息里的图片与视频可连续横滑;名字沿用
 * Image 是历史原因,composer 托盘 / 文件浏览器来源只放图片)。
 */
export interface MobileMessageGalleryImage {
  key: string;
  title: string;
  url: string;
  payload: Extract<MessagePayload, { kind: 'media' }>;
  /** 文件语境的 meta(大小 · 日期);lightbox 文件顶栏用,聊天图集不填。 */
  subtitle?: string;
  /**
   * 所属消息组(顶层 render item 的 key)。lightbox 翻页只在**同一条消息**的
   * 图片间进行(产品决策 2026-07-08):跨轮次的图不串进同一个图集。
   * 非聊天来源(composer 托盘 / 文件浏览器)不填,调用方自行决定集合范围。
   */
  groupKey?: string;
  /**
   * 手机本地已有的同图(发送时留下的预览 / 本地缩略兜底),即气泡正在显示的那张。
   * 查看器拿它从打开那一刻垫底,原图取到前不再黑屏转圈。
   */
  previewUri?: string;
}

/** 可进全屏查看器翻页的媒体:图片与视频;音频仍走通用查看器。 */
export function isLightboxMediaKind(kind: string): kind is 'image' | 'video' {
  return kind === 'image' || kind === 'video';
}

export function collectMobileMessageGalleryImages(
  items: readonly MobileMessageRenderItem[],
  workdir?: string,
  remoteHostId?: string,
  sessionId?: string,
  getSentImagePreview?: GetSentMessageImagePreview,
): MobileMessageGalleryImage[] {
  const images: MobileMessageGalleryImage[] = [];
  // 去重按「组内」进行(键 = groupKey + url):翻页组是单条消息,跨消息出现的
  // 同一 url 各自保留 entry,后一条消息的图才有自己的组,点它不会错开到前一条
  // 消息的图集(review P2)。同组内(附件 + 正文 md 重复引用)仍去重。
  const seenUrls = new Set<string>();
  // 当前顶层 render item 的 key:一条消息(气泡 / 一轮 work_group)= 一个翻页组。
  let currentGroupKey = '';

  const push = (
    key: string,
    title: string,
    payload: Extract<MessagePayload, { kind: 'media' }>,
    previewUri?: string | null,
  ) => {
    const url = payload.media.url.trim();
    if (!url || !isLightboxMediaKind(payload.media.kind)) return;
    // 待发送的两个附件可能物化到同一个内容地址，仍须与两个可点击缩略图逐槽对应。
    const dedupeKey = `${currentGroupKey}::${payload.galleryImageKey ? `slot:${payload.galleryImageKey}` : `url:${url}`}`;
    if (seenUrls.has(dedupeKey)) return;
    seenUrls.add(dedupeKey);
    // Distinct attachment identities remain separate pages; body references to their URL still dedupe.
    seenUrls.add(`${currentGroupKey}::url:${url}`);
    images.push({ key, title, url, payload, groupKey: currentGroupKey, ...(previewUri ? { previewUri } : {}) });
  };

  // includeBodyImages: 只有 body 真正经 MarkdownBody 渲染的 message 气泡才收正文 Markdown 图片;
  // thinking / tool_group 的 body 以纯 Text 展示,图片标记不会渲染成图,收进图集会让 lightbox
  // 翻页翻到聊天里看不到、也点不到的"隐藏页"。orcaCard / systemCardType 消息同理:它们的 body
  // 分别走 OrcaCollabCard / MobileSystemCard 的纯 Text 渲染,不是 MarkdownBody(见 RenderItemView 路由)。
  const rendersMarkdownBody = (message: NormalizedRemoteMessage): boolean =>
    !message.orcaCard && !message.systemCardType;

  const visitMessage = (message: NormalizedRemoteMessage, keyPrefix: string, includeBodyImages: boolean) => {
    const clientId = message.source.clientId ?? message.source.id;
    // 与 AttachmentStrip 同口径:本地发送预览按「第几张图片附件」对位。
    let imageIndex = -1;
    message.attachments?.forEach((rawAttachment, index) => {
      const displayAttachment = svgAttachmentForDisplay(rawAttachment, workdir, message.key, remoteHostId, sessionId);
      if (displayAttachment.kind === 'image') imageIndex += 1;
      // 图片附件,以及按 MIME 识别成视频的文件附件(AttachmentStrip 点开同样是 media payload)。
      if (displayAttachment.kind === 'image' && !displayAttachment.uri) return;
      // 与 AttachmentStrip 同源 overlay(cindy-oss-attach:// → 本地缩略兜底):气泡
      // 点开时 initialUrl 是替换后的 file://,图集条目必须同步替换才能匹配进翻页组。
      const attachment = applySentAttachmentThumbOverlay(displayAttachment);
      const payload = buildAttachmentPayload(attachment);
      if (payload.kind !== 'media') return;
      // 与气泡 MediaPreview 同源取本地图:被控端物化后 url 已换成远程引用,
      // 但手机本地仍留着发送时的那张,查看器用它垫底。持久副本优先:发送预览多指向
      // 发件箱上传文件,消息送达后即被清理(气泡靠加载失败再换持久副本兜住);
      // 只有持久副本尚未写好的发送窗口才用它。
      const localPreview = attachment.kind === 'image' && clientId
        ? getSentImagePreview?.(clientId, imageIndex, displayAttachment.name, undefined, displayAttachment.sha256, displayAttachment.uri)
        : undefined;
      const previewUri = attachment.kind === 'image' && displayAttachment.uri
        ? (getSentAttachmentThumbUri(localPreview?.sourceRef ?? displayAttachment.uri) ?? localPreview?.uri)
          : null;
      // The verified send snapshot bridges outbox/queue keys to formal history, even when
      // an earlier unreadable upload first enters the gallery at this exact handoff.
      const galleryImageKey = localPreview && clientId
        ? (localPreview.galleryImageKey ?? sentImageGalleryKey(clientId, localPreview.attachmentId))
        : undefined;
      push(galleryImageKey ?? `${keyPrefix}:attachment:${index}`, attachment.name,
        galleryImageKey ? { ...payload, galleryImageKey } : payload, previewUri);
    });
    message.media?.forEach((media, index) => pushMedia(media, `${keyPrefix}:media:${index}`));
    // 正文 Markdown 图片(![](url) / 安全 <img>)也纳入图集,点开后可与附件图片一起横滑翻页。
    if (includeBodyImages && message.body) {
      collectMobileMarkdownImages(message.body).forEach((image, index) => {
        // The viewer automatically fetches neighboring pages. Apply the same
        // workdir/realpath boundary as inline previews before adding any page.
        const url = isMobileMarkdownImageDirectUrl(image.url) ? image.url : mobileMarkdownManagedImagePreviewUrl(
          image.url,
          workdir,
          message.key,
          remoteHostId,
          sessionId,
        );
        if (!url) return;
        const title = mobileMarkdownImageTitle(url, image.alt);
        // http(s) 直连预览;xdt 系 scheme 非直连,查看器经 remote-media resolver 取图。
        const payload = buildMediaPayload(
          { kind: 'image', url, title, previewable: isMobileMarkdownImageDirectUrl(url) },
          title,
        );
        if (payload.kind === 'media') push(`${keyPrefix}:mdimg:${index}`, title, payload);
      });
    }
  };

  const pushMedia = (media: NormalizedToolMedia, key: string) => {
    if (!isLightboxMediaKind(media.kind)) return;
    const title = media.title || media.url.split('/').pop() || (media.kind === 'video'
      ? payloadMediaKindLabel('video')
      : i18n.t('message.renderer.imageFallbackTitle'));
    const payload = buildMediaPayload(media, title);
    if (payload.kind === 'media') push(key, title, payload);
  };

  const visitChild = (child: MobileWorkChildItem) => {
    if (child.type === 'message' || child.type === 'thinking') {
      visitMessage(child.message, child.key, child.type === 'message' && rendersMarkdownBody(child.message));
      return;
    }
    if (child.type === 'tool_group') {
      child.tools.forEach((tool, index) => visitMessage(tool, `${child.key}:tool:${index}`, false));
      return;
    }
    // 回合结束后「工作过程」会按正文切成嵌套的 work_group(createCompletedWorkGroup):
    // 必须递归,否则嵌套段里的图在回合结束那一刻从图集里消失——点开只剩单图,
    // 流式中却能翻(「开始能滑、过一会儿不行」的根因)。
    if (child.type === 'work_group') child.children.forEach(visitChild);
  };

  const visitItem = (item: MobileMessageRenderItem) => {
    switch (item.type) {
      case 'message':
      case 'thinking':
        visitMessage(item.message, item.key, item.type === 'message' && rendersMarkdownBody(item.message));
        break;
      case 'tool_group':
        item.tools.forEach((tool, index) => visitMessage(tool, `${item.key}:tool:${index}`, false));
        break;
      case 'work_group':
        item.children.forEach(visitChild);
        break;
      case 'subagent_group':
        // 子 agent 内层图片也纳入相册(lightbox 分页),递归其 childItems。
        item.childItems.forEach(visitItem);
        break;
      case 'tool_media':
        // tool 产出媒体的独立渲染项(所属 tool_group 内同一批 tool 消息的再呈现):
        // 图片已随 tool_group 路径进图集,这里 no-op,保证每个 url 只属于一个组。
        // 从这块点开时来源 key 不在图集里,按 url 唯一命中 tool_group 所在组;
        // 回合结束重组后来源 key 失效(work- → work-summary-)也同样按 url 找回。
        break;
      case 'todo':
        // todo 卡无图片,no-op。
        break;
      case 'agent_task':
        // 子 agent 任务卡只含文本(prompt / 摘要 / 输出文件),无相册图片,no-op。
        break;
      case 'fork_origin':
        // fork 来源标记只含导航 UI,no-op。
        break;
      case 'pending_send':
        item.thumbs.forEach((thumb, slot) => {
          const image = pendingSendGalleryImage(thumb, undefined, slot);
          if (image) push(image.key, image.title, image.payload, image.previewUri);
        });
        break;
      default:
        // 穷尽性保证:新增 render-item 变体会被 typecheck 拦下(入参 never)。运行时降级为 log+skip
        // (不 throw),与 RenderItemView 一致——相册收集在 useMemo 路径,不能让单个未知 item 崩。
        logUnhandledRenderItem(item);
    }
  };

  for (const item of items) {
    currentGroupKey = item.key;
    visitItem(item);
  }

  return images;
}

export function galleryImageIndexForPayload(
  images: readonly MobileMessageGalleryImage[],
  payload: MessagePayload | null,
): number {
  if (!payload || payload.kind !== 'media' || !isLightboxMediaKind(payload.media.kind)) return -1;
  if (payload.galleryImageKey) {
    const identityIndex = images.findIndex((image) => image.key === payload.galleryImageKey);
    if (identityIndex >= 0 || payload.galleryImageSlot === undefined) return identityIndex;
    // The selected message's slot can be replaced between the press and viewer mount.
    // Count placeholders too; readable-page indices can change while uploads settle.
    return images.findIndex((image) => image.payload.galleryImageSlot === payload.galleryImageSlot);
  }
  const url = payload.media.url.trim();
  if (!url) return -1;
  return images.findIndex((image) => image.url === url);
}

/**
 * 全屏查看器的图片集:被打开的图在会话图集里 → 取它**所属消息**(groupKey)
 * 内的图片 / 视频子集(同一条消息多张才可横滑翻页,跨轮次不串,产品决策 2026-07-08)。
 *
 * 所属消息优先用点击来源(sourceGroupKey:点开时所在的顶层 render item):同一
 * url 可能再次出现在后面的消息里,只凭 url 反查会命中多个组。来源不在图集里
 * (tool_media 等不收图的独立块、回合结束重组后失效的旧 key)或调用方没给来源
 * 时按 url 反查:唯一命中一组取该组;命中多组无法判定点的是哪条消息 → 保守
 * 退化单图,绝不错开到别的消息的图组(review P2)。
 * 完全不在图集里(理论兜底)→ 同样退化单图。
 */
export function lightboxImagesForPayload(
  images: readonly MobileMessageGalleryImage[],
  payload: Extract<MessagePayload, { kind: 'media' }>,
  sourceGroupKey?: string | null,
  previousImages?: readonly MobileMessageGalleryImage[] | null,
  sourceGroupPresent = false,
  retainPendingSnapshot = false,
): MobileMessageGalleryImage[] {
  // 待发送消息仍在时跟随该消息的当前图集：编辑可替换最初点开的附件身份。
  if (payload.galleryImageKey && sourceGroupKey) {
    const currentGroup = images.filter((image) => image.groupKey === sourceGroupKey);
    // A present row with no readable images is an edit, not a row handoff. Never revive its old payload.
    if (currentGroup.length > 0 || sourceGroupPresent) return currentGroup;
  }
  const url = payload.media.url.trim();
  // 待发送附件的临时文件、持久副本、远端原图地址会变化，匹配应跟随附件身份。
  const matches = images.filter((image) => payload.galleryImageKey
    ? image.key === payload.galleryImageKey
    : !!url && image.url === url);
  if (matches.length > 0) {
    if (sourceGroupKey && matches.some((image) => image.groupKey === sourceGroupKey)) {
      return images.filter((image) => image.groupKey === sourceGroupKey);
    }
    const groupKey = matches[0].groupKey;
    // 组信息缺失(非聊天来源构造的集合)保持整集语义,由调用方决定范围。
    if (groupKey === undefined) return [...images];
    if (matches.every((image) => image.groupKey === groupKey)) {
      return images.filter((image) => image.groupKey === groupKey);
    }
  }
  // Only a live outbox/queue/settling item may bridge a temporary gap in formal history.
  // Canceled rows and expired settling items must not revive their original payload.
  if (payload.galleryImageKey && !retainPendingSnapshot) return [];
  // 最初点开的附件可能已被编辑替换，因此有来源时按消息归属保留最新快照。
  if (payload.galleryImageKey && previousImages) {
    const previousGroup = previousImages.filter((image) => sourceGroupKey
      ? image.groupKey === sourceGroupKey
      : image.key === payload.galleryImageKey);
    if (previousGroup.length > 0) return sourceGroupKey ? previousGroup : [...previousImages];
  }
  return [{
    key: 'lightbox:payload',
    title: payload.title,
    url: payload.media.url,
    payload,
  }];
}

/** A snapshot for the opening message, including documents alongside media. */
export function collectMobileMessageAttachmentPayloads(
  item: MobileMessageRenderItem,
  workdir?: string,
  remoteHostId?: string,
  sessionId?: string,
): MessagePayload[] {
  const payloads: MessagePayload[] = [];
  const visitMessage = (message: NormalizedRemoteMessage) => {
    for (const attachment of message.attachments ?? [])
      payloads.push(
        buildAttachmentPayload(
          svgAttachmentForDisplay(
            attachment,
            workdir,
            message.key,
            remoteHostId,
            sessionId,
          ),
        ),
      );
    for (const media of message.media ?? [])
      payloads.push(
        buildMediaPayload(
          media,
          media.title ?? payloadMediaKindLabel(media.kind),
        ),
      );
  };
  const visit = (row: MobileMessageRenderItem | MobileWorkChildItem) => {
    if (row.type === "message" || row.type === "thinking")
      visitMessage(row.message);
    else if (row.type === "tool_group") row.tools.forEach(visitMessage);
    else if (row.type === "work_group") row.children.forEach(visit);
    else if (row.type === "subagent_group") row.childItems.forEach(visit);
  };
  visit(item);
  for (const image of collectMobileMessageGalleryImages(
    [item],
    workdir,
    remoteHostId,
    sessionId,
  )) {
    if (
      !payloads.some(
        (payload) =>
          payload.kind === "media" && payload.media.url === image.url,
      )
    )
      payloads.push(image.payload);
  }
  return payloads;
}
