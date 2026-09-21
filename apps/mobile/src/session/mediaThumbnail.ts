/**
 * mediaThumbnail.ts — 聊天列表图片缩略图的渲染决策纯函数。
 * ---------------------------------------------------------------------------
 * MediaPreview 对「不可直接预览但可远程取件」的桌面端图片(xdt-image:// 等)做
 * mount 时懒取件。本模块把「要不要自动取件」「当前该渲染哪一态」的判定从组件里
 * 抽出来,保证逻辑可单测:
 *
 *   - direct    :url 本身可预览(http/data:),走现有缩略图分支;
 *   - resolving :取件中,渲染与最终缩略图同尺寸的静默占位帧(不跳变);
 *   - resolved  :取件成功,用 presign URL 渲染缩略图;
 *   - fallback  :不满足自动取件条件或取件失败,回落占位卡片文案。
 *
 * 只有 image 参与自动取件;video/audio 保持占位卡片 + 点开查看器的现状。
 */
import { isDesktopLocalMediaUrl, type MobileResolvedRemoteMedia } from '@/session/remoteMedia';

export interface MediaThumbnailSource {
  kind: 'image' | 'video' | 'audio';
  url: string;
  previewable: boolean;
}

export type MediaThumbnailFallbackReason =
  | 'not-image'
  | 'not-desktop-url'
  | 'no-resolver'
  | 'error'
  | 'unsupported-mime';

export type MediaThumbnailPhase =
  | { kind: 'direct' }
  | { kind: 'resolving' }
  | { kind: 'resolved'; uri: string }
  | { kind: 'fallback'; reason: MediaThumbnailFallbackReason };

/** MediaPreview 内部的取件状态(组件 state 的最小形状)。 */
export type MediaThumbnailResolveState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; media: MobileResolvedRemoteMedia }
  | { status: 'error' };

/** 是否应在 mount 时自动取件:仅 image、不可直接预览、桌面端媒体 URL、且有取件回调。 */
export function shouldAutoResolveMediaThumbnail(
  media: MediaThumbnailSource,
  hasResolver: boolean,
): boolean {
  return media.kind === 'image'
    && !media.previewable
    && !!media.url
    && isDesktopLocalMediaUrl(media.url)
    && hasResolver;
}

export interface AttachmentImageIntrinsicSize {
  height: number;
  width: number;
}

/**
 * 用户消息图片附件的显示尺寸(对齐桌面版 user-attached 的 object-contain 语义):
 * 按原始宽高比 contain 进 max 框、不放大;尺寸未知 / 非法时回落 max 框全尺寸
 * 占位帧(280×180 比例)——聊天图以横图居多,比正方形占位更接近最终尺寸,
 * 缩小 Image.getSize 返回后换帧的跳变幅度(rule 7)。彻底消除跳变需要取件
 * 契约带上桌面端已知的原始宽高,留待后续 PR。
 */
export function attachmentImageDisplaySize(
  intrinsic: AttachmentImageIntrinsicSize | null,
  maxWidth: number,
  maxHeight: number,
): { height: number; width: number } {
  if (!intrinsic || !(intrinsic.width > 0) || !(intrinsic.height > 0)) {
    return { height: maxHeight, width: maxWidth };
  }
  const scale = Math.min(maxWidth / intrinsic.width, maxHeight / intrinsic.height, 1);
  return {
    height: Math.max(1, Math.round(intrinsic.height * scale)),
    width: Math.max(1, Math.round(intrinsic.width * scale)),
  };
}

/** 根据媒体与取件状态推导当前渲染态。 */
export function mediaThumbnailPhase(
  media: MediaThumbnailSource,
  state: MediaThumbnailResolveState,
  hasResolver: boolean,
): MediaThumbnailPhase {
  if (media.kind !== 'image') return { kind: 'fallback', reason: 'not-image' };
  // A direct URL can still fail to decode or expire. Keep the same fallback
  // frame instead of leaving an empty Image marked as ready to preview.
  if (state.status === 'error') return { kind: 'fallback', reason: 'error' };
  if (media.previewable && media.url) return { kind: 'direct' };
  if (!media.url || !isDesktopLocalMediaUrl(media.url)) {
    return { kind: 'fallback', reason: 'not-desktop-url' };
  }
  if (!hasResolver) return { kind: 'fallback', reason: 'no-resolver' };
  if (state.status === 'ready') {
    // 取件成功但 mime 不是图片(比如 xdt-image:// 背后其实是别的文件)→ 回落占位。
    if (!state.media.previewable) return { kind: 'fallback', reason: 'unsupported-mime' };
    return { kind: 'resolved', uri: state.media.url };
  }
  return { kind: 'resolving' };
}
