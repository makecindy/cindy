import {
  collectMobileMarkdownImages,
  isMobileMarkdownImageDirectUrl,
  mobileMarkdownImageTitle,
  mobileMarkdownImageUrlForWorkdir,
} from '@/session/messageMarkdown';
import type { NormalizedRemoteMessage, NormalizedToolMedia } from '@/session/messageNormalize';
import type { MessagePayload } from '@/session/messagePayload';
import { buildAttachmentPayload, buildMediaPayload } from '@/session/messagePayload';
import type { MobileMessageRenderItem, MobileWorkChildItem } from '@/session/messageRenderModel';
import { logUnhandledRenderItem } from '@/session/assertNever';
import { applySentAttachmentThumbOverlay } from '@/session/sentAttachmentThumbStore';
import { i18n } from '@/i18n';

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
}

export function collectMobileMessageGalleryImages(
  items: readonly MobileMessageRenderItem[],
  workdir?: string,
  remoteHostId?: string,
  sessionId?: string,
): MobileMessageGalleryImage[] {
  const images: MobileMessageGalleryImage[] = [];
  // 去重按「组内」进行(键 = groupKey + url):翻页组是单条消息,跨消息出现的
  // 同一 url 各自保留 entry,后一条消息的图才有自己的组,点它不会错开到前一条
  // 消息的图集(review P2)。同组内(附件 + 正文 md 重复引用)仍去重。
  const seenUrls = new Set<string>();
  // 当前顶层 render item 的 key:一条消息(气泡 / 一轮 work_group)= 一个翻页组。
  let currentGroupKey = '';

  const push = (key: string, title: string, payload: Extract<MessagePayload, { kind: 'media' }>) => {
    const url = payload.media.url.trim();
    if (!url || payload.media.kind !== 'image') return;
    const dedupeKey = `${currentGroupKey}::${url}`;
    if (seenUrls.has(dedupeKey)) return;
    seenUrls.add(dedupeKey);
    images.push({ key, title, url, payload, groupKey: currentGroupKey });
  };

  // includeBodyImages: 只有 body 真正经 MarkdownBody 渲染的 message 气泡才收正文 Markdown 图片;
  // thinking / tool_group 的 body 以纯 Text 展示,图片标记不会渲染成图,收进图集会让 lightbox
  // 翻页翻到聊天里看不到、也点不到的"隐藏页"。orcaCard / systemCardType 消息同理:它们的 body
  // 分别走 OrcaCollabCard / MobileSystemCard 的纯 Text 渲染,不是 MarkdownBody(见 RenderItemView 路由)。
  const rendersMarkdownBody = (message: NormalizedRemoteMessage): boolean => (
    !message.orcaCard && !message.systemCardType
  );

  const visitMessage = (message: NormalizedRemoteMessage, keyPrefix: string, includeBodyImages: boolean) => {
    message.attachments?.forEach((rawAttachment, index) => {
      if (rawAttachment.kind !== 'image' || !rawAttachment.uri) return;
      // 与 AttachmentStrip 同源 overlay(cindy-oss-attach:// → 本地缩略兜底):气泡
      // 点开时 initialUrl 是替换后的 file://,图集条目必须同步替换才能匹配进翻页组。
      const attachment = applySentAttachmentThumbOverlay(rawAttachment);
      const payload = buildAttachmentPayload(attachment);
      if (payload.kind === 'media') push(`${keyPrefix}:attachment:${index}`, attachment.name, payload);
    });
    message.media?.forEach((media, index) => pushMedia(media, `${keyPrefix}:media:${index}`));
    // 正文 Markdown 图片(![](url) / 安全 <img>)也纳入图集,点开后可与附件图片一起横滑翻页。
    if (includeBodyImages && message.body) {
      collectMobileMarkdownImages(message.body).forEach((image, index) => {
        const url = mobileMarkdownImageUrlForWorkdir(
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
    if (media.kind !== 'image') return;
    const title = media.title || media.url.split('/').pop() || i18n.t('message.renderer.imageFallbackTitle');
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
    }
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
        // 图片已随 tool_group 路径进图集(push 亦按 url 去重),这里 no-op 防双计。
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
  if (!payload || payload.kind !== 'media' || payload.media.kind !== 'image') return -1;
  const url = payload.media.url.trim();
  if (!url) return -1;
  return images.findIndex((image) => image.url === url);
}

/**
 * 全屏查看器的图片集:被打开的图在会话图集里 → 取它**所属消息**(groupKey)
 * 内的图片子集(同一条消息多图才可横滑翻页,跨轮次不串,产品决策 2026-07-08);
 * 同一 url 出现在多条消息(多个组)时,payload 只有 url、无法判定点的是哪条
 * 消息 → 保守退化为单图集合,绝不错开到别的消息的图组(review P2)。
 * 完全不在图集里(理论兜底)→ 同样退化单图。
 */
export function lightboxImagesForPayload(
  images: readonly MobileMessageGalleryImage[],
  payload: Extract<MessagePayload, { kind: 'media' }>,
): MobileMessageGalleryImage[] {
  const url = payload.media.url.trim();
  const matches = url ? images.filter((image) => image.url === url) : [];
  if (matches.length > 0) {
    const groupKey = matches[0].groupKey;
    // 组信息缺失(非聊天来源构造的集合)保持整集语义,由调用方决定范围。
    if (groupKey === undefined) return [...images];
    if (matches.every((image) => image.groupKey === groupKey)) {
      return images.filter((image) => image.groupKey === groupKey);
    }
  }
  return [{
    key: 'lightbox:payload',
    title: payload.title,
    url: payload.media.url,
    payload,
  }];
}
