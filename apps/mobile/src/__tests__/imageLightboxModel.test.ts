import { describe, expect, it } from 'vitest';
import {
  LIGHTBOX_DOUBLE_TAP_SCALE,
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  LIGHTBOX_TAP_MAX_DISTANCE,
  bakeLightboxOrigin,
  canShareLightboxImage,
  compensateLightboxOrigin,
  clampLightboxScale,
  clampLightboxTranslation,
  clampLightboxVisualPan,
  isLightboxZoomed,
  lightboxBackgroundOpacity,
  lightboxContainedSize,
  lightboxDoubleTapTranslate,
  lightboxImageLayers,
  lightboxInitialIndex,
  lightboxPageIndex,
  lightboxPageLabel,
  lightboxPanOverflow,
  lightboxPinchOrigin,
  nextDoubleTapScale,
  reclampLightboxPan,
  shouldCloseLightboxOnTap,
  shouldDismissLightbox,
} from '@/session/imageLightboxModel';

describe('imageLightboxModel', () => {
  it('clamps scale into [min, max]', () => {
    expect(clampLightboxScale(0.3)).toBe(LIGHTBOX_MIN_SCALE);
    expect(clampLightboxScale(2)).toBe(2);
    expect(clampLightboxScale(99)).toBe(LIGHTBOX_MAX_SCALE);
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

  it('compensates translation when applying a pinch origin onto an existing scale', () => {
    // 双击 2.5x 后 translate=-150;再在 origin=100 处捏合,补偿后画面公式不变
    expect(compensateLightboxOrigin(-150, 100, LIGHTBOX_DOUBLE_TAP_SCALE)).toBe(0);
    expect(bakeLightboxOrigin(0, 100, LIGHTBOX_DOUBLE_TAP_SCALE)).toBe(-150);
    // 1x 时 origin 项为 0,补偿是空操作
    expect(compensateLightboxOrigin(0, 100, 1)).toBe(0);
  });

  it('clamps baked visual pan then compensates when origin is nonzero', () => {
    // origin=0: bake/补偿恒等,与直接钳 raw 相同
    expect(clampLightboxVisualPan(250, 0, 0, 0, 400, 800, 2, 400, 800)).toEqual({ x: 200, y: 0 });
    // origin=100, scale=2: visual = T + 100*(1-2) = T-100。T=-200 钳 raw 看似贴边,
    // 画面却在 -300,越出 overflow 200。只修捏合、不修标注 pan 的半边修法过不了这条。
    expect(clampLightboxTranslation(-200, 400, 2, 400)).toBe(-200);
    expect(clampLightboxVisualPan(-200, 0, 100, 0, 400, 800, 2, 400, 800)).toEqual({ x: -100, y: 0 });
    expect(bakeLightboxOrigin(-100, 100, 2)).toBe(-200);
    // 画面未越界时 raw 保持不动
    expect(clampLightboxVisualPan(250, 0, 100, 0, 400, 800, 2, 400, 800)).toEqual({ x: 250, y: 0 });
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
