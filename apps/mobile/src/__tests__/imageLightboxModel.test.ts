import { describe, expect, it } from 'vitest';
import {
  LIGHTBOX_DOUBLE_TAP_SCALE,
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  canShareLightboxImage,
  clampLightboxScale,
  clampLightboxTranslation,
  lightboxBackgroundOpacity,
  lightboxImageLayers,
  lightboxInitialIndex,
  lightboxPageIndex,
  lightboxPageLabel,
  nextDoubleTapScale,
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

  it('dismisses on distance or fling velocity', () => {
    expect(shouldDismissLightbox(121, 0)).toBe(true);
    expect(shouldDismissLightbox(-121, 0)).toBe(true);
    expect(shouldDismissLightbox(20, 900)).toBe(true);
    expect(shouldDismissLightbox(20, 100)).toBe(false);
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
