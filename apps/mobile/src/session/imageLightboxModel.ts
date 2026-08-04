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

/** 单页的图像层可见性(见 {@link lightboxImageLayers})。 */
export interface LightboxImageLayers {
  /** 是否渲染缩略图垫底层(在原图层之下)。 */
  showPreview: boolean;
  /** 是否渲染转圈(仅在连缩略图都没有、否则就是纯黑时)。 */
  showSpinner: boolean;
  /** 是否渲染失败终态文案(原图已确证失败且没有重试路径,不能永远转圈)。 */
  showFailure: boolean;
}

/**
 * 渐进出图的层决策:打开瞬间必须有像素接住画面。
 *
 * 点开的图在聊天列表里已经解码好了,所以缩略图从**打开那一刻**就垫在底下,
 * 一直垫到原图 `onLoad` 真正落地(有像素)才撤 —— 空档窗口有两段,取件在途
 * (还没有原图地址)与原图地址已拿到、字节仍在下载,两段都必须被垫住。
 * 此前只垫住了第一段(且垫底状态挂在取件态里,取件一完成就连带丢失),于是
 * 第二段裸露成纯黑:用户已经在列表看过这张图,点开反而先黑一段再跳出来。
 *
 * 拿不到缩略图时(直连 http 图、缓存未命中)退一步给转圈:宁可有反馈,
 * 不要纯黑无提示。有缩略图时**不叠**转圈 —— 画面已经完整可读(只是软),
 * 再压一个转圈反而制造"还在加载"的噪声,对齐主流 IM 的渐进出图观感。
 *
 * 但「有地址」不等于「有像素」:缩略图的磁盘文件可能被 LRU / 系统清理掉,而取件
 * 队列的内存缓存仍持有那个永不过期的 file://。这种垫底图根本画不出来,若仍据此
 * 隐藏转圈,整段就退回纯黑、还比旧实现少了转圈反馈,所以 previewFailed 必须参与
 * 判定(PR #1125 review;DESIGN.md 双模式门槛也要求改动触及的 loading / error 态
 * 都被覆盖)。
 */
export function lightboxImageLayers(input: {
  /** 原图可渲染地址;取件完成前为 null。 */
  fullUri: string | null;
  /** 列表缩略图地址;取不到为 null。 */
  previewUri: string | null;
  /** 原图是否已 onLoad。仅在与当前 fullUri 对应时为 true(换图即失效)。 */
  fullLoaded: boolean;
  /** 垫底图是否已确认 onError(文件被清理等);失败的垫底不能顶替转圈。 */
  previewFailed?: boolean;
  /**
   * 原图已确证 onError,且这条路径没有自动重取 / 重试入口(直连 http 图)。
   * 此时既没有像素也不会再有,必须给失败终态——转圈会一直谎报"还在加载"。
   */
  fullFailedTerminally?: boolean;
}): LightboxImageLayers {
  // fullUri 为空时 fullLoaded 一律不成立:防调用方漏重置造成"已加载"的假阳性
  // (会把垫底和转圈同时撤掉,又回到纯黑)。
  if (input.fullUri && input.fullLoaded) {
    return { showPreview: false, showSpinner: false, showFailure: false };
  }
  // 垫底可用时优先给内容(软图也是内容),胜过失败文案与转圈。
  if (input.previewUri && !input.previewFailed) {
    return { showPreview: true, showSpinner: false, showFailure: false };
  }
  if (input.fullFailedTerminally) {
    return { showPreview: false, showSpinner: false, showFailure: true };
  }
  return { showPreview: false, showSpinner: true, showFailure: false };
}

/** 可分享判定:本地 file:// 直接分享;http(s) 可下载后分享;data: 不支持。 */
export function canShareLightboxImage(displayUri: string | null): boolean {
  if (!displayUri) return false;
  return displayUri.startsWith('file://') || displayUri.startsWith('http://') || displayUri.startsWith('https://');
}
