import { describe, expect, it } from 'vitest';
import {
  LIGHTBOX_DOUBLE_TAP_SCALE,
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  LIGHTBOX_TAP_MAX_DISTANCE,
  bakeLightboxOrigin,
  canShareLightboxImage,
  compensateLightboxOrigin,
  clampLightboxTranslation,
  dragLightboxVisualPan,
  isLightboxZoomed,
  lightboxBackgroundOpacity,
  lightboxContainedSize,
  lightboxDoubleTapTranslate,
  lightboxImageLayers,
  lightboxInitialIndex,
  lightboxPageIndex,
  lightboxPageLabel,
  lightboxPanOverflow,
  lightboxPanRelease,
  lightboxPinchAnchor,
  lightboxPinchOrigin,
  lightboxPinchSettle,
  lightboxPinchTranslation,
  lightboxRubberBand,
  lightboxRubberBandInverse,
  nextDoubleTapScale,
  reclampLightboxPan,
  rubberBandLightboxScale,
  rubberBandLightboxTranslation,
  rubberBandLightboxVisualPan,
  shouldCloseLightboxOnTap,
  shouldDismissLightbox,
  unrubberLightboxScale,
  unrubberLightboxTranslation,
  unrubberLightboxVisualPan,
} from '@/session/imageLightboxModel';

describe('imageLightboxModel', () => {
  it('rubber-bands pinch scale past both ends instead of hard-stopping', () => {
    expect(rubberBandLightboxScale(2)).toBe(2);
    // 捏过两端仍会继续变化,但越捏越沉,且永远到不了渐近线
    const under = rubberBandLightboxScale(0.5);
    expect(under).toBeLessThan(LIGHTBOX_MIN_SCALE);
    expect(under).toBeGreaterThan(0.5);
    expect(rubberBandLightboxScale(0.3)).toBeLessThan(under);
    expect(rubberBandLightboxScale(0)).toBeGreaterThan(LIGHTBOX_MIN_SCALE * 0.5);
    const over = rubberBandLightboxScale(LIGHTBOX_MAX_SCALE + 2);
    expect(over).toBeGreaterThan(LIGHTBOX_MAX_SCALE);
    expect(over).toBeLessThan(LIGHTBOX_MAX_SCALE + 2);
    expect(rubberBandLightboxScale(99)).toBeLessThan(LIGHTBOX_MAX_SCALE * 1.5);
    // 逆运算:回弹途中再捏时从当前画面接续
    for (const raw of [0.2, 0.7, 1, 2.5, 4, 5, 9]) {
      expect(unrubberLightboxScale(rubberBandLightboxScale(raw))).toBeCloseTo(raw, 6);
    }
  });

  it('rubber band grows monotonically with diminishing returns and inverts cleanly', () => {
    expect(lightboxRubberBand(0, 400)).toBe(0);
    expect(lightboxRubberBand(-10, 400)).toBe(0);
    expect(lightboxRubberBand(10, 0)).toBe(0);
    const a = lightboxRubberBand(100, 400);
    const b = lightboxRubberBand(200, 400);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(100);
    // 越拉越沉:第二个 100px 换来的位移少于第一个
    expect(b - a).toBeGreaterThan(0);
    expect(b - a).toBeLessThan(a);
    expect(lightboxRubberBand(1e9, 400)).toBeLessThan(400);
    expect(lightboxRubberBandInverse(a, 400)).toBeCloseTo(100, 6);
    expect(Number.isFinite(lightboxRubberBandInverse(400, 400))).toBe(true);
  });

  it('lets the pan run past the image edge with resistance, including locked axes', () => {
    // 2x:溢出 200;边界内原样
    expect(rubberBandLightboxTranslation(150, 400, 2, 400)).toBe(150);
    const past = rubberBandLightboxTranslation(300, 400, 2, 400);
    expect(past).toBeGreaterThan(200);
    expect(past).toBeLessThan(300);
    expect(rubberBandLightboxTranslation(-300, 400, 2, 400)).toBeCloseTo(-past, 9);
    // 未溢出的轴(横图纵向)也能拖动一点,而不是锁死在 0
    const locked = rubberBandLightboxTranslation(80, 800, 2.5, 225);
    expect(locked).toBeGreaterThan(0);
    expect(locked).toBeLessThan(80);
    expect(unrubberLightboxTranslation(past, 400, 2, 400)).toBeCloseTo(300, 6);
    expect(unrubberLightboxTranslation(-locked, 800, 2.5, 225)).toBeCloseTo(-80, 6);
  });

  it('drags incrementally: dragging out and back returns to the same spot', () => {
    let pos = { x: 180, y: 0 };
    for (let i = 0; i < 10; i += 1) {
      pos = dragLightboxVisualPan(pos.x, pos.y, 20, 0, 0, 0, 400, 800, 2, 400, 800);
    }
    // 手指越界 180px,画面只多走一截
    expect(pos.x).toBeGreaterThan(200);
    expect(pos.x).toBeLessThan(380);
    for (let i = 0; i < 10; i += 1) {
      pos = dragLightboxVisualPan(pos.x, pos.y, -20, 0, 0, 0, 400, 800, 2, 400, 800);
    }
    expect(pos.x).toBeCloseTo(180, 6);
  });

  it('decides how a released pan settles on each axis', () => {
    // 越界:弹回最近的边界
    expect(lightboxPanRelease(260, 0, 400, 2, 400)).toEqual({ kind: 'settle', to: 200 });
    expect(lightboxPanRelease(-260, 900, 400, 2, 400)).toEqual({ kind: 'settle', to: -200 });
    expect(lightboxPanRelease(30, 0, 800, 2.5, 225)).toEqual({ kind: 'settle', to: 0 });
    // 边界内:有速度惯性滑行,慢放手原地停
    expect(lightboxPanRelease(100, 1200, 400, 2, 400)).toEqual({ kind: 'fling', min: -200, max: 200 });
    expect(lightboxPanRelease(100, 20, 400, 2, 400)).toEqual({ kind: 'none' });
  });

  it('settles a pinch back into range around the last focal point', () => {
    const base = { containerWidth: 400, containerHeight: 800, displayedWidth: 400, displayedHeight: 800 };
    // 缩到 1x 及以下一律回正
    expect(lightboxPinchSettle({ ...base, scale: 0.7, translateX: 40, translateY: -30, focalX: 0, focalY: 0 }))
      .toEqual({ scale: LIGHTBOX_MIN_SCALE, x: 0, y: 0 });
    // 范围内且边界内:原样(不因浮点误差起一段动画)
    expect(lightboxPinchSettle({ ...base, scale: 2.1, translateX: -77.3, translateY: 12.9, focalX: 37, focalY: -90 }))
      .toEqual({ scale: 2.1, x: -77.3, y: 12.9 });
    // 范围内但越界:位移收回边界
    expect(lightboxPinchSettle({ ...base, scale: 2, translateX: 260, translateY: 0, focalX: 0, focalY: 0 }))
      .toEqual({ scale: 2, x: 200, y: 0 });
    // 捏过最大倍率:绕焦点缩回,焦点下那一点不动
    const settled = lightboxPinchSettle({ ...base, scale: 5, translateX: -100, translateY: 300, focalX: 50, focalY: 100 });
    expect(settled.scale).toBe(LIGHTBOX_MAX_SCALE);
    const pointX = (50 - -100) / 5;
    const pointY = (100 - 300) / 5;
    expect(pointX * settled.scale + settled.x).toBeCloseTo(50, 9);
    expect(pointY * settled.scale + settled.y).toBeCloseTo(100, 9);
  });

  it('clamps translation to the zoomed overflow and locks it at 1x', () => {
    // 1x:无溢出,任何平移都归零
    expect(clampLightboxTranslation(50, 400, 1)).toBe(0);
    // 2x:溢出 = (800-400)/2 = 200
    expect(clampLightboxTranslation(150, 400, 2)).toBe(150);
    expect(clampLightboxTranslation(250, 400, 2)).toBe(200);
    expect(clampLightboxTranslation(-250, 400, 2)).toBe(-200);
  });

  it('clamps translation against the contained image size, not the letterbox', () => {
    // 横图 contain 进 400×800:显示 400×200。2x 后高 400,相对 800 高仍无溢出
    expect(lightboxContainedSize(400, 800, 800, 400)).toEqual({ width: 400, height: 200 });
    expect(lightboxPanOverflow(800, 200, 2)).toBe(0);
    expect(clampLightboxTranslation(80, 800, 2, 200)).toBe(0);
    // 竖图 contain 进 400×800:显示 400×800。2x 后宽溢出 200
    expect(lightboxContainedSize(400, 800, 400, 800)).toEqual({ width: 400, height: 800 });
    expect(clampLightboxTranslation(250, 400, 2, 400)).toBe(200);
    // 自然尺寸未知时退回容器
    expect(lightboxContainedSize(400, 800, 0, 0)).toEqual({ width: 400, height: 800 });
  });

  it('reclamps leftover pan when contain size shrinks after natural size arrives', () => {
    // 未知尺寸按 400×800 铺满,2x 后 Y 仍能平移 80;横图 onLoad 后显示 400×200,Y 溢出变 0
    expect(clampLightboxTranslation(80, 800, 2, 800)).toBe(80);
    expect(reclampLightboxPan(0, 80, 400, 800, 2, 400, 200)).toEqual({ x: 0, y: 0 });
    // 旋转 / 变窄时 X 同样立刻收回,不把旧位移留到下一次拖动
    expect(reclampLightboxPan(250, 0, 400, 800, 2, 400, 800)).toEqual({ x: 200, y: 0 });
  });

  it('distinguishes reclamping the double-tap target from an in-flight intermediate', () => {
    // 双击目标 150,动画走到 80 时竖图 overflow 仍是 200:钳中间值会把目标改成 80
    // (动画停早,点击点漂向中心)。动画中必须钳 saved 目标,不能钳 live。
    // 调用方不得用这个新目标另起 withTiming:那会跟仍在跑的 scale 抢默认时长。
    expect(reclampLightboxPan(80, 0, 400, 800, 2, 400, 800)).toEqual({ x: 80, y: 0 });
    expect(reclampLightboxPan(150, 0, 400, 800, 2, 400, 800)).toEqual({ x: 150, y: 0 });
  });

  it('bakes pinch origin into translation so resetting origin does not jump', () => {
    expect(lightboxPinchOrigin(300, 400)).toBe(100);
    // translate 40, origin 100, scale 2 → 40 + 100 * (1-2) = -60
    expect(bakeLightboxOrigin(40, 100, 2)).toBe(-60);
    expect(bakeLightboxOrigin(-60, 0, 2)).toBe(-60);
  });

  it('anchors a second pinch on the image point under the fingers', () => {
    // 1x、未平移:锚点就是焦点
    expect(lightboxPinchAnchor(300, 400, 0, 1)).toBe(100);
    // 2.5x、T=-195:屏幕中心(焦点相对坐标 0)下是图片坐标 78 的点
    const anchor = lightboxPinchAnchor(200, 400, -195, 2.5);
    expect(anchor).toBeCloseTo(78, 9);
    // 补偿后,锚点在任意倍率下都停在手指下(transform = T + o + s·(p - o))
    const translate = compensateLightboxOrigin(-195, anchor, 2.5);
    for (const s of [2.5, 3, 4.2]) {
      expect(translate + anchor + s * (anchor - anchor)).toBeCloseTo(0, 9);
    }
    // 起始帧无跳变:任一图片点的屏幕位置与补偿前一致
    expect(translate + anchor + 2.5 * (10 - anchor)).toBeCloseTo(-195 + 2.5 * 10, 9);
  });

  it('keeps the pinch anchor under the fingers even when the pinch starts out of bounds', () => {
    // 2x、画面位移 300(越界,overflow=200),在屏幕中心捏:锚点 = (0 - 300) / 2 = -150
    const anchor = lightboxPinchAnchor(200, 400, 300, 2);
    expect(anchor).toBe(-150);
    const screenOfAnchor = (raw: number) => raw + anchor; // T + o + s·(o - o)
    // 第一帧(倍率未变、手指未动)与起点连续:bake 回去仍是 300
    const first = lightboxPinchTranslation(300, anchor, 2, 2, 0, 400, 400);
    expect(bakeLightboxOrigin(first, anchor, 2)).toBeCloseTo(300, 9);
    // 捏到 4x:锚定位移 600 恰在 overflow=600 内,锚点必须停在手指下(不漂)
    const at4 = lightboxPinchTranslation(300, anchor, 2, 4, 0, 400, 400);
    expect(screenOfAnchor(at4)).toBeCloseTo(0, 9);
    // 手指往边界内平移时锚点跟手;往外越界则按阻尼少走一截
    expect(screenOfAnchor(lightboxPinchTranslation(300, anchor, 2, 4, -25, 400, 400))).toBeCloseTo(-25, 9);
    const outward = screenOfAnchor(lightboxPinchTranslation(300, anchor, 2, 4, 25, 400, 400));
    expect(outward).toBeGreaterThan(0);
    expect(outward).toBeLessThan(25);
    // 锚定位移越过新边界时才阻尼:画面不越过手指目标
    const at3 = lightboxPinchTranslation(300, anchor, 2, 2.2, 0, 400, 400);
    const visual = bakeLightboxOrigin(at3, anchor, 2.2);
    expect(visual).toBeLessThanOrEqual(300 + 150 * 0.2 + 1e-9);
    expect(visual).toBeGreaterThan(lightboxPanOverflow(400, 400, 2.2));
  });

  it('compensates translation when applying a pinch origin onto an existing scale', () => {
    // 双击 2.5x 后 translate=-150;再在 origin=100 处捏合,补偿后画面公式不变
    expect(compensateLightboxOrigin(-150, 100, LIGHTBOX_DOUBLE_TAP_SCALE)).toBe(0);
    expect(bakeLightboxOrigin(0, 100, LIGHTBOX_DOUBLE_TAP_SCALE)).toBe(-150);
    // 1x 时 origin 项为 0,补偿是空操作
    expect(compensateLightboxOrigin(0, 100, 1)).toBe(0);
  });

  it('rubber-bands the baked visual pan then compensates when origin is nonzero', () => {
    // origin=0: bake/补偿恒等,与直接作用于 raw 相同
    expect(rubberBandLightboxVisualPan(150, 0, 0, 0, 400, 800, 2, 400, 800)).toEqual({ x: 150, y: 0 });
    // origin=100, scale=2: visual = T + 100*(1-2) = T-100。T=-200 看似贴边,
    // 画面却在 -300,已越出 overflow 200,必须按画面越界量阻尼。
    const next = rubberBandLightboxVisualPan(-200, 0, 100, 0, 400, 800, 2, 400, 800);
    const visual = bakeLightboxOrigin(next.x, 100, 2);
    expect(visual).toBeCloseTo(rubberBandLightboxTranslation(-300, 400, 2, 400), 9);
    expect(visual).toBeGreaterThan(-300);
    expect(visual).toBeLessThan(-200);
    // 画面未越界时 raw 保持不动
    expect(rubberBandLightboxVisualPan(250, 0, 100, 0, 400, 800, 2, 400, 800)).toEqual({ x: 250, y: 0 });
    expect(unrubberLightboxVisualPan(next.x, next.y, 100, 0, 400, 800, 2, 400, 800).x).toBeCloseTo(-200, 6);
  });

  it('double-tap zooms into the tap point and resets when returning to 1x', () => {
    expect(isLightboxZoomed(1)).toBe(false);
    expect(isLightboxZoomed(1.005)).toBe(false);
    expect(isLightboxZoomed(2.5)).toBe(true);
    // tap 300 in 400-wide view, 2.5x: origin 100 → 100 * (1-2.5) = -150
    expect(lightboxDoubleTapTranslate(300, 400, LIGHTBOX_DOUBLE_TAP_SCALE)).toBe(-150);
    expect(lightboxDoubleTapTranslate(300, 400, 1)).toBe(0);
  });

  it('dismisses on distance or fling velocity', () => {
    expect(shouldDismissLightbox(121, 0)).toBe(true);
    expect(shouldDismissLightbox(-121, 0)).toBe(true);
    expect(shouldDismissLightbox(20, 900)).toBe(true);
    expect(shouldDismissLightbox(20, 100)).toBe(false);
  });

  it('keeps tap-to-close slop tight enough that a pan is not a tap', () => {
    expect(LIGHTBOX_TAP_MAX_DISTANCE).toBeGreaterThan(0);
    expect(LIGHTBOX_TAP_MAX_DISTANCE).toBeLessThan(40);
  });

  it('closes on tap only at 1x', () => {
    expect(shouldCloseLightboxOnTap(1)).toBe(true);
    expect(shouldCloseLightboxOnTap(1.005)).toBe(true);
    expect(shouldCloseLightboxOnTap(LIGHTBOX_DOUBLE_TAP_SCALE)).toBe(false);
    expect(shouldCloseLightboxOnTap(2)).toBe(false);
  });

  it('never dismisses while zoomed, even past distance or fling', () => {
    // 放大后平移(含纵向无溢出的横图)不能变成下滑关闭
    expect(shouldDismissLightbox(200, 0, LIGHTBOX_DOUBLE_TAP_SCALE)).toBe(false);
    expect(shouldDismissLightbox(20, 900, 2)).toBe(false);
    expect(shouldDismissLightbox(200, 900, LIGHTBOX_MIN_SCALE)).toBe(true);
    expect(shouldDismissLightbox(200, 0, 1.005)).toBe(true);
  });

  it('fades the backdrop with drag progress', () => {
    expect(lightboxBackgroundOpacity(0, 800)).toBe(1);
    expect(lightboxBackgroundOpacity(200, 800)).toBeCloseTo(1 - 0.5 * 0.7);
    expect(lightboxBackgroundOpacity(4000, 800)).toBeCloseTo(0.3);
    expect(lightboxBackgroundOpacity(100, 0)).toBe(1);
  });

  it('double tap toggles between 1x and the zoom-in scale', () => {
    expect(nextDoubleTapScale(1)).toBe(LIGHTBOX_DOUBLE_TAP_SCALE);
    expect(nextDoubleTapScale(LIGHTBOX_DOUBLE_TAP_SCALE)).toBe(LIGHTBOX_MIN_SCALE);
    expect(nextDoubleTapScale(3.7)).toBe(LIGHTBOX_MIN_SCALE);
  });

  it('maps paging offset to a bounded index', () => {
    expect(lightboxPageIndex(0, 400, 3)).toBe(0);
    expect(lightboxPageIndex(410, 400, 3)).toBe(1);
    expect(lightboxPageIndex(9999, 400, 3)).toBe(2);
    expect(lightboxPageIndex(100, 0, 3)).toBe(0);
  });

  it('locates the initial page by url with a safe fallback', () => {
    expect(lightboxInitialIndex(['a', 'b', 'c'], 'b')).toBe(1);
    expect(lightboxInitialIndex(['a'], 'missing')).toBe(0);
    // gallery 键是 trimmed url,initialUrl 来自未 trim 的 payload.media.url:两侧 trim 后匹配
    expect(lightboxInitialIndex(['a', 'b', 'c'], ' b ')).toBe(1);
    expect(lightboxInitialIndex(['a', ' b ', 'c'], 'b')).toBe(1);
  });

  it('hides the page label for single images', () => {
    expect(lightboxPageLabel(0, 1)).toBeNull();
    expect(lightboxPageLabel(1, 5)).toBe('2 / 5');
  });

  describe('lightboxImageLayers', () => {
    // 打开图片的两段空档窗口都必须被垫住,否则用户看到的就是「列表里图明明已经
    // 出来了,点开反而先黑一段」。
    it('keeps the thumbnail while the original is still fetching', () => {
      expect(lightboxImageLayers({ fullUri: null, previewUri: 'file:///thumb.webp', fullLoaded: false }))
        .toEqual({ showPreview: true, showSpinner: false, showFailure: false });
    });

    it('keeps the thumbnail after the original url arrives but before it paints', () => {
      // 回归点:旧实现把垫底挂在取件态里,取件一完成(ready)就撤,这一段裸露成黑屏。
      expect(lightboxImageLayers({
        fullUri: 'https://oss.example/full.png',
        previewUri: 'file:///thumb.webp',
        fullLoaded: false,
      })).toEqual({ showPreview: true, showSpinner: false, showFailure: false });
    });

    it('drops both layers only once the original has actually loaded', () => {
      expect(lightboxImageLayers({
        fullUri: 'https://oss.example/full.png',
        previewUri: 'file:///thumb.webp',
        fullLoaded: true,
      })).toEqual({ showPreview: false, showSpinner: false, showFailure: false });
    });

    it('falls back to a spinner when no thumbnail is available', () => {
      // 直连 http 图没有缩略图可垫:给转圈,不留纯黑无反馈。
      expect(lightboxImageLayers({ fullUri: null, previewUri: null, fullLoaded: false }))
        .toEqual({ showPreview: false, showSpinner: true, showFailure: false });
      expect(lightboxImageLayers({
        fullUri: 'https://oss.example/full.png',
        previewUri: null,
        fullLoaded: false,
      })).toEqual({ showPreview: false, showSpinner: true, showFailure: false });
    });

    it('ends in a failure state instead of spinning forever when the original cannot be retried', () => {
      // 直连 http 图没有 forceRefresh 自愈也没有重试按钮:一直转圈等于一直谎报
      // "还在加载"(本次之前这条路径是一直纯黑)。
      expect(lightboxImageLayers({
        fullUri: 'https://cdn.example/broken.png',
        previewUri: null,
        fullLoaded: false,
        fullFailedTerminally: true,
      })).toEqual({ showPreview: false, showSpinner: false, showFailure: true });
    });

    it('prefers a usable thumbnail over the failure text', () => {
      // 有内容可展示(软图也是内容)就不要给失败文案。
      expect(lightboxImageLayers({
        fullUri: 'https://oss.example/full.png',
        previewUri: 'file:///thumb.webp',
        fullLoaded: false,
        fullFailedTerminally: true,
      })).toEqual({ showPreview: true, showSpinner: false, showFailure: false });
    });

    it('keeps spinning while a retryable original is still self-healing', () => {
      // 可重取的图不传 fullFailedTerminally:失败终态由父层 resolveMap 接管(带重试按钮),
      // 本页在自愈窗口内应继续给转圈,不能提前宣告失败。
      expect(lightboxImageLayers({
        fullUri: 'https://oss.example/stale.png',
        previewUri: null,
        fullLoaded: false,
        fullFailedTerminally: false,
      })).toEqual({ showPreview: false, showSpinner: true, showFailure: false });
    });

    it('restores the spinner when the thumbnail itself failed to load', () => {
      // 回归点:缩略图的磁盘文件被 LRU / 系统清掉后,队列内存缓存仍会回一个永不过期
      // 的 file://。只看「有地址」会把没有像素当成已出图,于是 spinner 被藏掉、垫底
      // 又画不出东西,整段退回纯黑,反而比旧实现少了转圈反馈。
      expect(lightboxImageLayers({
        fullUri: null,
        previewUri: 'file:///thumb.webp',
        fullLoaded: false,
        previewFailed: true,
      })).toEqual({ showPreview: false, showSpinner: true, showFailure: false });
      // 原图地址已到、字节仍在下载的那段同样要有反馈
      expect(lightboxImageLayers({
        fullUri: 'https://oss.example/full.png',
        previewUri: 'file:///thumb.webp',
        fullLoaded: false,
        previewFailed: true,
      })).toEqual({ showPreview: false, showSpinner: true, showFailure: false });
      // 原图已出图后不该再有任何附加层
      expect(lightboxImageLayers({
        fullUri: 'https://oss.example/full.png',
        previewUri: 'file:///thumb.webp',
        fullLoaded: true,
        previewFailed: true,
      })).toEqual({ showPreview: false, showSpinner: false, showFailure: false });
    });

    it('never trusts fullLoaded without a full uri', () => {
      // 调用方漏复位 loaded 标记时不能把两层同时撤掉(又回到纯黑)。
      expect(lightboxImageLayers({ fullUri: null, previewUri: 'file:///thumb.webp', fullLoaded: true }))
        .toEqual({ showPreview: true, showSpinner: false, showFailure: false });
      expect(lightboxImageLayers({ fullUri: null, previewUri: null, fullLoaded: true }))
        .toEqual({ showPreview: false, showSpinner: true, showFailure: false });
    });
  });

  it('allows sharing only for file and http(s) uris', () => {
    expect(canShareLightboxImage('file:///cache/a.png')).toBe(true);
    expect(canShareLightboxImage('https://oss.example/a.png')).toBe(true);
    expect(canShareLightboxImage('data:image/png;base64,xxx')).toBe(false);
    expect(canShareLightboxImage(null)).toBe(false);
  });
});
