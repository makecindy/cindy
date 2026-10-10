/**
 * imageLightboxModel.ts — 全屏图片查看器的手势/布局决策纯函数。
 * ---------------------------------------------------------------------------
 * ImageLightbox 组件里的 worklet 只做数值搬运,所有"判定"(缩放边界、平移钳制、
 * 越界橡皮筋与松手回弹、下滑释放是否关闭、背景透明度、页索引)集中在这里,
 * node 环境可单测。
 */

export const LIGHTBOX_MIN_SCALE = 1;
export const LIGHTBOX_MAX_SCALE = 4;
/** 双击放大的目标倍率(IM 惯例 2~3 倍之间)。 */
export const LIGHTBOX_DOUBLE_TAP_SCALE = 2.5;
/** 视为「已放大」的最小超出量,避免 1.0001 这种浮点噪声锁住翻页。 */
export const LIGHTBOX_ZOOM_EPS = 0.01;
/** 下滑关闭:位移超过此值(px)或速度超过 velocity 阈值即关闭。 */
export const LIGHTBOX_DISMISS_DISTANCE = 120;
export const LIGHTBOX_DISMISS_VELOCITY = 800;
/**
 * 单击关闭允许的最大位移(pt)。RNGH Tap 默认 maxDist 为无限(NAN 跳过校验),
 * 与平移 Simultaneous 时,500ms 内的短拖松手会被当成单击,lightbox 直接关掉。
 */
export const LIGHTBOX_TAP_MAX_DISTANCE = 12;
/** 橡皮筋系数(对齐 UIScrollView 的 0.55):越界量 x 显示为 (1 - 1/(x·c/d + 1))·d。 */
export const LIGHTBOX_RUBBER_BAND_COEFFICIENT = 0.55;
/** 捏合越过 1x / 最大倍率时橡皮筋的渐近幅度(倍率),手越用力越难再缩放。 */
const LIGHTBOX_UNDER_ZOOM_RANGE = LIGHTBOX_MIN_SCALE * 0.5;
const LIGHTBOX_OVER_ZOOM_RANGE = LIGHTBOX_MAX_SCALE * 0.5;

/**
 * 越界量 → 实际显示的越界距离:越拉阻力越大,渐近 dimension 永远拉不满。
 * dimension 取容器边长时,手感与系统滚动视图的边缘回弹一致。
 */
export function lightboxRubberBand(overshoot: number, dimension: number): number {
  'worklet';
  if (overshoot <= 0 || dimension <= 0) return 0;
  return (1 - 1 / ((overshoot * LIGHTBOX_RUBBER_BAND_COEFFICIENT) / dimension + 1)) * dimension;
}

/** {@link lightboxRubberBand} 的逆运算:已显示的越界距离还原成手指实际越界量。 */
export function lightboxRubberBandInverse(distance: number, dimension: number): number {
  'worklet';
  if (distance <= 0 || dimension <= 0) return 0;
  // 显示距离理论上 < dimension;浮点 / 外部写入越过时取极大有限值,避免除零。
  const ratio = Math.min(distance / dimension, 0.999);
  return (dimension / LIGHTBOX_RUBBER_BAND_COEFFICIENT) * (1 / (1 - ratio) - 1);
}

/** 捏合倍率的橡皮筋:范围内原样,捏过 1x / 最大倍率按阻尼继续缩放。 */
export function rubberBandLightboxScale(rawScale: number): number {
  'worklet';
  if (rawScale < LIGHTBOX_MIN_SCALE) {
    return LIGHTBOX_MIN_SCALE - lightboxRubberBand(LIGHTBOX_MIN_SCALE - rawScale, LIGHTBOX_UNDER_ZOOM_RANGE);
  }
  if (rawScale > LIGHTBOX_MAX_SCALE) {
    return LIGHTBOX_MAX_SCALE + lightboxRubberBand(rawScale - LIGHTBOX_MAX_SCALE, LIGHTBOX_OVER_ZOOM_RANGE);
  }
  return rawScale;
}

/** {@link rubberBandLightboxScale} 的逆运算:回弹途中再次捏合时从当前画面接续,不跳。 */
export function unrubberLightboxScale(scale: number): number {
  'worklet';
  if (scale < LIGHTBOX_MIN_SCALE) {
    return LIGHTBOX_MIN_SCALE - lightboxRubberBandInverse(LIGHTBOX_MIN_SCALE - scale, LIGHTBOX_UNDER_ZOOM_RANGE);
  }
  if (scale > LIGHTBOX_MAX_SCALE) {
    return LIGHTBOX_MAX_SCALE + lightboxRubberBandInverse(scale - LIGHTBOX_MAX_SCALE, LIGHTBOX_OVER_ZOOM_RANGE);
  }
  return scale;
}

export function isLightboxZoomed(scale: number): boolean {
  'worklet';
  return scale > LIGHTBOX_MIN_SCALE + LIGHTBOX_ZOOM_EPS;
}

/**
 * contain 适配后的显示尺寸。自然尺寸未知时退回容器(按铺满估算,宁可少拖一点)。
 * 与 annotationBaseRect 同源,但不返回 left/top——平移钳制只需要边长。
 */
export function lightboxContainedSize(
  containerWidth: number,
  containerHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } {
  'worklet';
  if (containerWidth <= 0 || containerHeight <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
    return { width: containerWidth, height: containerHeight };
  }
  const fit = Math.min(containerWidth / naturalWidth, containerHeight / naturalHeight);
  return { width: naturalWidth * fit, height: naturalHeight * fit };
}

/** 某轴允许的平移半幅:放大后的显示边超出容器的一半;未超出则为 0。 */
export function lightboxPanOverflow(
  containerSize: number,
  displayedSize: number,
  scale: number,
): number {
  'worklet';
  const size = displayedSize <= 0 ? containerSize : displayedSize;
  return Math.max(0, (size * scale - containerSize) / 2);
}

/**
 * 放大后的平移钳制:图片按 contain 显示后再乘 scale,超出容器的部分才允许平移;
 * 未超出的轴锁死在 0,防止把图拖出屏幕。displayedSize 缺省时按铺满容器估算
 * (旧调用点 / 自然尺寸未到)。
 */
export function clampLightboxTranslation(
  value: number,
  containerSize: number,
  scale: number,
  displayedSize?: number,
): number {
  'worklet';
  const overflow = lightboxPanOverflow(
    containerSize,
    displayedSize == null ? containerSize : displayedSize,
    scale,
  );
  if (value < -overflow) return -overflow;
  if (value > overflow) return overflow;
  return value;
}

/**
 * 显示尺寸变化后(自然尺寸到达 / 旋转)按新 contain 边界重钳位移。
 * 未知尺寸按铺满容器估算,横图 onLoad 后高变小,旧位移必须立刻收回,
 * 不能等下次拖动手才跳回边界。
 */
export function reclampLightboxPan(
  translateX: number,
  translateY: number,
  containerWidth: number,
  containerHeight: number,
  scale: number,
  displayedWidth: number,
  displayedHeight: number,
): { x: number; y: number } {
  'worklet';
  return {
    x: clampLightboxTranslation(translateX, containerWidth, scale, displayedWidth),
    y: clampLightboxTranslation(translateY, containerHeight, scale, displayedHeight),
  };
}

/** 捏合焦点相对容器中心,作为 scale 的 transform origin。 */
export function lightboxPinchOrigin(focal: number, containerSize: number): number {
  'worklet';
  return focal - containerSize / 2;
}

/**
 * 捏合的缩放锚点:手指焦点下那一点在图片自身坐标里的位置(相对图片中心、未缩放)。
 * transform 为 T + origin + s·(p - origin),只有 p = origin 的点在缩放中不动;
 * 已放大 / 已平移时这一点不是焦点的屏幕坐标,直接用焦点会让二次捏合绕错的中心
 * 缩放、图往外漂。translate 为 bake 后(origin=0)的位移。
 */
export function lightboxPinchAnchor(
  focal: number,
  containerSize: number,
  translate: number,
  scale: number,
): number {
  'worklet';
  if (scale <= 0) return lightboxPinchOrigin(focal, containerSize);
  return (lightboxPinchOrigin(focal, containerSize) - translate) / scale;
}

/**
 * 把 origin 缩放折进 translation,之后 origin 可归零而不跳变。
 * p' = (p - origin) * scale + origin + translate
 *    = p * scale + origin * (1 - scale) + translate
 */
export function bakeLightboxOrigin(translate: number, origin: number, scale: number): number {
  'worklet';
  return translate + origin * (1 - scale);
}

/**
 * bake 的逆运算:已有缩放时再设 origin,从 translate 扣掉 origin*(1-scale),
 * 画面公式不变。二次捏合若不补偿,imageStyle 会立刻加上 origin*(1-scale) 跳一下,
 * 结束时 bake 还会把这次跳变写进位移。
 */
export function compensateLightboxOrigin(translate: number, origin: number, scale: number): number {
  'worklet';
  return translate - origin * (1 - scale);
}

/**
 * 平移的橡皮筋:边界内原样;越过图片边缘(含未溢出、钳在 0 的轴)仍可继续拖,
 * 越界部分按容器边长阻尼。value 是 bake 后的画面中心位移。
 */
export function rubberBandLightboxTranslation(
  value: number,
  containerSize: number,
  scale: number,
  displayedSize: number,
): number {
  'worklet';
  const overflow = lightboxPanOverflow(containerSize, displayedSize, scale);
  if (value > overflow) return overflow + lightboxRubberBand(value - overflow, containerSize);
  if (value < -overflow) return -overflow - lightboxRubberBand(-overflow - value, containerSize);
  return value;
}

/** {@link rubberBandLightboxTranslation} 的逆运算:画面位移还原为手指的实际位移。 */
export function unrubberLightboxTranslation(
  value: number,
  containerSize: number,
  scale: number,
  displayedSize: number,
): number {
  'worklet';
  const overflow = lightboxPanOverflow(containerSize, displayedSize, scale);
  if (value > overflow) return overflow + lightboxRubberBandInverse(value - overflow, containerSize);
  if (value < -overflow) return -overflow - lightboxRubberBandInverse(-overflow - value, containerSize);
  return value;
}

/**
 * 捏合中某一轴的 raw translate:手指下的锚点跟手,越界部分按**当前倍率**的边界阻尼。
 * 先算「锚点不动」时的画面位移 anchored = start + anchor·(startScale - scale),
 * 在当前倍率下还原成手指量、加上焦点位移,再按当前倍率套橡皮筋,最后补偿回带
 * origin 的 raw。不能把起始倍率下还原的手指量跨倍率复用:起点处在越界回弹区时,
 * 两套边界的差会被 origin 缩放项放大,锚点从手指下滑开。
 * startTranslate 为捏合开始时 bake 后的画面位移;起点越界且倍率未变时第一帧连续。
 */
export function lightboxPinchTranslation(
  startTranslate: number,
  anchor: number,
  startScale: number,
  scale: number,
  focalDelta: number,
  containerSize: number,
  displayedSize: number,
): number {
  'worklet';
  const anchored = startTranslate + anchor * (startScale - scale);
  const finger = unrubberLightboxTranslation(anchored, containerSize, scale, displayedSize) + focalDelta;
  const visual = rubberBandLightboxTranslation(finger, containerSize, scale, displayedSize);
  return compensateLightboxOrigin(visual, anchor, scale);
}

/**
 * 跟手位移的橡皮筋:raw translate(可带 origin)先 bake 成画面中心,越界部分阻尼,
 * 再补偿回 raw。origin≠0 时直接处理 raw 会按错误的边界阻尼(画面实际越界量不同),
 * 松手 bake 再跳;origin=0 时 bake/补偿是恒等。标注双指平移与捏合同时进行时用它。
 */
export function rubberBandLightboxVisualPan(
  translateX: number,
  translateY: number,
  originX: number,
  originY: number,
  containerWidth: number,
  containerHeight: number,
  scale: number,
  displayedWidth: number,
  displayedHeight: number,
): { x: number; y: number } {
  'worklet';
  return {
    x: compensateLightboxOrigin(
      rubberBandLightboxTranslation(
        bakeLightboxOrigin(translateX, originX, scale),
        containerWidth,
        scale,
        displayedWidth,
      ),
      originX,
      scale,
    ),
    y: compensateLightboxOrigin(
      rubberBandLightboxTranslation(
        bakeLightboxOrigin(translateY, originY, scale),
        containerHeight,
        scale,
        displayedHeight,
      ),
      originY,
      scale,
    ),
  };
}

/**
 * {@link rubberBandLightboxVisualPan} 的逆运算:捏合开始时若画面已处在越界回弹中,
 * 先还原成手指位移再作为起点,第一帧不跳。
 */
export function unrubberLightboxVisualPan(
  translateX: number,
  translateY: number,
  originX: number,
  originY: number,
  containerWidth: number,
  containerHeight: number,
  scale: number,
  displayedWidth: number,
  displayedHeight: number,
): { x: number; y: number } {
  'worklet';
  return {
    x: compensateLightboxOrigin(
      unrubberLightboxTranslation(
        bakeLightboxOrigin(translateX, originX, scale),
        containerWidth,
        scale,
        displayedWidth,
      ),
      originX,
      scale,
    ),
    y: compensateLightboxOrigin(
      unrubberLightboxTranslation(
        bakeLightboxOrigin(translateY, originY, scale),
        containerHeight,
        scale,
        displayedHeight,
      ),
      originY,
      scale,
    ),
  };
}

/**
 * 增量拖动(单指平移 / 标注双指平移):当前画面先还原成手指位移,加上本帧增量,
 * 再套橡皮筋。无状态,缩放同时变化(边界随之变化)时也连续。
 */
export function dragLightboxVisualPan(
  translateX: number,
  translateY: number,
  deltaX: number,
  deltaY: number,
  originX: number,
  originY: number,
  containerWidth: number,
  containerHeight: number,
  scale: number,
  displayedWidth: number,
  displayedHeight: number,
): { x: number; y: number } {
  'worklet';
  const raw = unrubberLightboxVisualPan(
    translateX,
    translateY,
    originX,
    originY,
    containerWidth,
    containerHeight,
    scale,
    displayedWidth,
    displayedHeight,
  );
  return rubberBandLightboxVisualPan(
    raw.x + deltaX,
    raw.y + deltaY,
    originX,
    originY,
    containerWidth,
    containerHeight,
    scale,
    displayedWidth,
    displayedHeight,
  );
}

/** 松手甩动低于此速度(px/s)不做惯性滑行,避免慢放手时图片还微微漂一下。 */
export const LIGHTBOX_FLING_MIN_VELOCITY = 50;

/**
 * 平移松手后单轴的收尾方式:
 *   - settle:已越界,弹簧回到最近的边界(带松手速度,继续往外甩会先多冲一点再回)。
 *   - fling:边界内且有甩动速度,惯性滑行;滑到边界时由橡皮筋衰减冲过一点再弹回。
 *   - none:边界内慢慢放手,原地停住。
 */
export type LightboxPanRelease =
  | { kind: 'settle'; to: number }
  | { kind: 'fling'; min: number; max: number }
  | { kind: 'none' };

export function lightboxPanRelease(
  value: number,
  velocity: number,
  containerSize: number,
  scale: number,
  displayedSize: number,
): LightboxPanRelease {
  'worklet';
  const overflow = lightboxPanOverflow(containerSize, displayedSize, scale);
  if (value > overflow) return { kind: 'settle', to: overflow };
  if (value < -overflow) return { kind: 'settle', to: -overflow };
  if (Math.abs(velocity) < LIGHTBOX_FLING_MIN_VELOCITY) return { kind: 'none' };
  return { kind: 'fling', min: -overflow, max: overflow };
}

/**
 * 捏合松手后的落点:倍率回到 [1, 最大倍率],位移回到该倍率的边界内。
 * 捏过最大倍率时绕最后的焦点缩回,手指下那一点保持不动;缩到 1x 及以下一律回正。
 * translate 为 bake 后(origin=0)的位移,focal 为焦点相对容器中心的坐标。
 */
export function lightboxPinchSettle(input: {
  scale: number;
  translateX: number;
  translateY: number;
  focalX: number;
  focalY: number;
  containerWidth: number;
  containerHeight: number;
  displayedWidth: number;
  displayedHeight: number;
}): { scale: number; x: number; y: number } {
  'worklet';
  if (!isLightboxZoomed(input.scale)) return { scale: LIGHTBOX_MIN_SCALE, x: 0, y: 0 };
  const scale = Math.min(input.scale, LIGHTBOX_MAX_SCALE);
  let x = input.translateX;
  let y = input.translateY;
  if (scale !== input.scale) {
    // 焦点 F 下的图片点 p 满足 F = p·s + T;缩到 s' 后保持 F 不动:T' = F - (F - T)·s'/s。
    // 倍率不变时跳过,免得浮点误差让本已合法的落点也起一段动画。
    const ratio = scale / input.scale;
    x = input.focalX - (input.focalX - input.translateX) * ratio;
    y = input.focalY - (input.focalY - input.translateY) * ratio;
  }
  return {
    scale,
    x: clampLightboxTranslation(x, input.containerWidth, scale, input.displayedWidth),
    y: clampLightboxTranslation(y, input.containerHeight, scale, input.displayedHeight),
  };
}

/**
 * 双击目标平移:点击点在缩放到 targetScale 后仍停在原处;缩回 1x 时归零。
 */
export function lightboxDoubleTapTranslate(
  tap: number,
  containerSize: number,
  targetScale: number,
): number {
  'worklet';
  if (!isLightboxZoomed(targetScale)) return 0;
  return lightboxPinchOrigin(tap, containerSize) * (1 - targetScale);
}

/**
 * 下滑手势释放时是否应关闭(距离或甩动速度任一超阈值)。
 * 放大后一律不关:contain 横图即使 2.5x 也常无纵向溢出,同一记向下滑会被 Simultaneous
 * 的关闭手势当成 dismiss;scale 必须参与判定,不能只靠手势 fail()。
 */
export function shouldDismissLightbox(
  translationY: number,
  velocityY: number,
  scale: number = LIGHTBOX_MIN_SCALE,
): boolean {
  'worklet';
  if (isLightboxZoomed(scale)) return false;
  return Math.abs(translationY) > LIGHTBOX_DISMISS_DISTANCE
    || Math.abs(velocityY) > LIGHTBOX_DISMISS_VELOCITY;
}

/** 单击是否关闭:仅 1x。放大时单击留给看图,避免和拖图/双击抢手势。 */
export function shouldCloseLightboxOnTap(scale: number): boolean {
  'worklet';
  return !isLightboxZoomed(scale);
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
  return isLightboxZoomed(currentScale) ? LIGHTBOX_MIN_SCALE : LIGHTBOX_DOUBLE_TAP_SCALE;
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
