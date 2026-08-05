/**
 * imageLightboxModel.ts — 全屏图片查看器的手势/布局决策纯函数。
 * ---------------------------------------------------------------------------
 * ImageLightbox 组件里的 worklet 只做数值搬运,所有"判定"(缩放边界、平移钳制、
 * 下滑释放是否关闭、背景透明度、页索引)集中在这里,node 环境可单测。
 */

export const LIGHTBOX_MIN_SCALE = 1;
export const LIGHTBOX_MAX_SCALE = 4;
/** 双击放大的目标倍率(IM 惯例 2~3 倍之间)。 */
export const LIGHTBOX_DOUBLE_TAP_SCALE = 2.5;
/** 下滑关闭:位移超过此值(px)或速度超过 velocity 阈值即关闭。 */
export const LIGHTBOX_DISMISS_DISTANCE = 120;
export const LIGHTBOX_DISMISS_VELOCITY = 800;

export function clampLightboxScale(scale: number): number {
  'worklet';
  if (scale < LIGHTBOX_MIN_SCALE) return LIGHTBOX_MIN_SCALE;
  if (scale > LIGHTBOX_MAX_SCALE) return LIGHTBOX_MAX_SCALE;
  return scale;
}

/**
 * 放大后的平移钳制:图片(contain 适配后与容器同尺寸的逻辑框)按 scale 放大,
 * 超出容器的部分才允许平移;未超出的轴锁死在 0,防止把图拖出屏幕。
 */
export function clampLightboxTranslation(
  value: number,
  containerSize: number,
  scale: number,
): number {
  'worklet';
  const overflow = Math.max(0, (containerSize * scale - containerSize) / 2);
  if (value < -overflow) return -overflow;
  if (value > overflow) return overflow;
  return value;
}

/** 下滑手势释放时是否应关闭(距离或甩动速度任一超阈值)。 */
export function shouldDismissLightbox(translationY: number, velocityY: number): boolean {
  'worklet';
  return Math.abs(translationY) > LIGHTBOX_DISMISS_DISTANCE
    || Math.abs(velocityY) > LIGHTBOX_DISMISS_VELOCITY;
}

/** 下滑拖动中的背景不透明度:拖过半屏降到 0.3,跟手渐隐。 */
export function lightboxBackgroundOpacity(translationY: number, containerHeight: number): number {
  'worklet';
  if (containerHeight <= 0) return 1;
  const progress = Math.min(1, Math.abs(translationY) / (containerHeight / 2));
  return 1 - progress * 0.7;
}

/** 双击在 1x 与放大倍率间切换。 */
export function nextDoubleTapScale(currentScale: number): number {
  'worklet';
  return currentScale > LIGHTBOX_MIN_SCALE + 0.01 ? LIGHTBOX_MIN_SCALE : LIGHTBOX_DOUBLE_TAP_SCALE;
}

/** 横向分页偏移 → 页索引(pagingEnabled 的 momentum end)。 */
export function lightboxPageIndex(offsetX: number, pageWidth: number, pageCount: number): number {
  if (pageWidth <= 0 || pageCount <= 0) return 0;
  const index = Math.round(offsetX / pageWidth);
  return Math.min(Math.max(index, 0), pageCount - 1);
}

/**
 * 初始页:按 url 定位,找不到回退 0(单图打开必命中)。
 * 两侧都 trim:gallery 键是 trimmed url,而 initialUrl 来自未 trim 的
 * payload.media.url,带空白的 url 不 trim 会静默落回第 0 张。
 */
export function lightboxInitialIndex(urls: readonly string[], initialUrl: string): number {
  const target = initialUrl.trim();
  const index = urls.findIndex((url) => url.trim() === target);
  return index >= 0 ? index : 0;
}

/** 页码指示文案;单图不显示。 */
export function lightboxPageLabel(index: number, count: number): string | null {
  if (count <= 1) return null;
  return `${index + 1} / ${count}`;
}

/** 可分享判定:本地 file:// 直接分享;http(s) 可下载后分享;data: 不支持。 */
export function canShareLightboxImage(displayUri: string | null): boolean {
  if (!displayUri) return false;
  return displayUri.startsWith('file://') || displayUri.startsWith('http://') || displayUri.startsWith('https://');
}
