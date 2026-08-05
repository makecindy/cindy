import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

/**
 * 聊天列表图片缩略图懒取件的接线断言(源码字符串模式,同 messageContentDesktopFirst):
 * 保证 strip → MediaPreview 的取件回调透传、payload 查看器的 image 关闭即删豁免、
 * 以及缩略图三态帧不被后续重构悄悄拆掉。
 */
describe('mobile message media thumbnail wiring', () => {
  const rendererSource = readTextLf(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
  const screenSource = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

  it('threads onResolveRemoteMedia from actions through both media blocks into MediaPreview', () => {
    expect(rendererSource).toContain('onResolveRemoteMedia={actions.onResolveRemoteMedia}');
    const attachmentStrip = rendererSource.slice(
      rendererSource.indexOf('function AttachmentStrip'),
      rendererSource.indexOf('function ToolMediaBlock'),
    );
    const toolMediaBlock = rendererSource.slice(
      rendererSource.indexOf('function ToolMediaBlock'),
      rendererSource.indexOf('function MediaPreview'),
    );
    expect(attachmentStrip).toContain('onResolveRemoteMedia={onResolveRemoteMedia}');
    expect(toolMediaBlock).toContain('onResolveRemoteMedia={actions.onResolveRemoteMedia}');
  });

  it('renders same-size resolving and fallback frames inside MediaPreview', () => {
    const mediaPreview = rendererSource.slice(
      rendererSource.indexOf('function MediaPreview'),
      rendererSource.indexOf('const FILE_CHIP_TEST_IDS'),
    );
    expect(mediaPreview).toContain('shouldAutoResolveMediaThumbnail');
    expect(mediaPreview).toContain('mediaThumbnailPhase');
    expect(mediaPreview).toContain('message.mediaThumbLoading');
    expect(mediaPreview).toContain('message.mediaThumbFallback');
    // 查看器插队 + 缩略图可取消
    expect(mediaPreview).toContain('signal, forceRefresh');
  });

  it('renders image attachments desktop-style: outside the bubble, aspect-contained, no filename', () => {
    // 附件条渲染在气泡外(文字气泡上方),纯图片消息不渲染空气泡
    expect(rendererSource).toContain('{attachmentStripNode}');
    expect(rendererSource).toContain(
      '{hasBubbleContent || (!attachmentStripNode && messageQuotes.length === 0) ? bubble : null}',
    );
    const attachmentStrip = rendererSource.slice(
      rendererSource.indexOf('function AttachmentStrip'),
      rendererSource.indexOf('function ToolMediaBlock'),
    );
    // 图片附件走 attachment 变体(contain 进 max 框),逐张竖排不再拼贴换行
    expect(attachmentStrip).toContain('variant="attachment"');
    expect(attachmentStrip).not.toContain('attachmentImageRow');
    const mediaPreview = rendererSource.slice(
      rendererSource.indexOf('function MediaPreview'),
      rendererSource.indexOf('const FILE_CHIP_TEST_IDS'),
    );
    expect(mediaPreview).toContain('attachmentImageDisplaySize');
    // 附件取件失败留在附件帧内(不回落小卡片帧造成 reflow)
    expect(mediaPreview).toContain('attachmentImageFallback');
    // 图片缩略图不再带文件名 caption(对齐桌面版 user-attached / tool-output)
    expect(mediaPreview).not.toContain('mediaCaption');
  });

  it('exempts images from close-time release in the payload viewer', () => {
    expect(rendererSource).toContain("remoteMedia.kind !== 'image'");
    // 查看器取件插队头;重试按钮显式 forceRefresh 穿透负缓存(挂载取件不传)
    expect(rendererSource).toContain('{ front: true, forceRefresh }');
    expect(rendererSource).toContain('resolve(true);');
  });

  it('routes session-screen resolution through the resolve queue with per-session cleanup', () => {
    expect(screenSource).toContain('createRemoteMediaResolveQueue');
    expect(screenSource).toContain('.request(media, opts)');
    expect(screenSource).toContain('releaseAll()');
    // 切 sessionId(本屏不重挂载)与退屏共用清理:释放 + 补删 + 换新队列实例
    expect(screenSource).toContain('[sessionId, createRemoteMediaQueue, deleteRemoteMediaObject]');
    expect(screenSource).toContain('remoteMediaQueueRef.current = createRemoteMediaQueue()');
  });

  it('routes image payloads to the fullscreen ImageLightbox instead of the generic modal', () => {
    expect(rendererSource).toContain("payload?.kind === 'media' && payload.media.kind === 'image'");
    expect(rendererSource).toContain('<ImageLightbox');
    expect(rendererSource).toContain('lightboxImagesForPayload(galleryImages, payload)');
    // 旧的内嵌缩放查看器与图库箭头已退役
    expect(rendererSource).not.toContain('ZoomablePayloadImage');
    expect(rendererSource).not.toContain('message.imageZoomInButton');
    expect(rendererSource).not.toContain('message.galleryPrevButton');
    const lightboxSource = readTextLf(resolve(process.cwd(), 'src/session/ImageLightbox.tsx'), 'utf8');
    expect(lightboxSource).toContain('message.imageLightbox');
    expect(lightboxSource).toContain('shouldDismissLightbox');
    expect(lightboxSource).toContain('Gesture.Pinch()');
    // 分享按产品决策走系统分享单;expo-sharing 必须动态 import(旧构建缺原生模块)
    const screenShare = screenSource.includes("await import('expo-sharing')");
    expect(screenShare).toBe(true);
    expect(screenSource).not.toMatch(/^import \* as Sharing from 'expo-sharing';/m);
  });

  it('wires stale-key self-heal: lightbox onError force refresh and orphan release DELETE', () => {
    const lightboxSource = readTextLf(resolve(process.cwd(), 'src/session/ImageLightbox.tsx'), 'utf8');
    // 悬空 key 404 → 一次性 forceRefresh 自愈;重试按钮也走 forceRefresh(穿透负缓存)
    expect(lightboxSource).toContain('onError={onImageError && retryable');
    expect(lightboxSource).toContain('handleImageLoadError');
    // 重试 / onError 都是带 image 参数的稳定回调,不被内联闭包击穿 LightboxPage memo
    expect(lightboxSource).toContain('handleRetryPage');
    expect(lightboxSource).toContain('resolveImage(image, true, true)');
    // 垫底预取只吃缓存:不许触发新取件(gif/老被控端会回落成整图下载,叠成双下载)
    expect(lightboxSource).toContain('cachedOnly: true');
    // 退屏后完成的 in-flight 取件经 orphan 回调补 DELETE
    expect(screenSource).toContain('onOrphanResolved');
    // 取件成功但 mime 非图片 → 视为失败给重试按钮,不停留在永久 spinner
    expect(lightboxSource).toContain('resolvedUnsupported');
    // 取件中 / 失败分支必须可单击关闭(无关闭按钮,不能困在全屏 Modal)
    expect(lightboxSource).toContain('onPress={onRequestClose}');
    // lightbox images 引用稳定,父层流式重渲染不空转取件 effect / FlatList
    expect(rendererSource).toContain('const lightboxImages = useMemo');
    // 语义未变时复用上一份数组;关闭回调稳定化,流式期间不重建手势图
    expect(rendererSource).toContain('lightboxImagesRef');
    expect(rendererSource).toContain('onClose={closePayload}');
    // 旋转(宽度变化)时按 activeIndex 重锚 FlatList,页码 / 分享目标不错位
    expect(lightboxSource).toContain('scrollToOffset');
    // 退屏 DELETE 前等待后台落盘完成,不把 store 下载打成 404 白丢缓存
    expect(screenSource).toContain('pendingDiskStoresRef');
    expect(screenSource).toContain('deleteRemoteMediaObject');
    const queueSource = readTextLf(resolve(process.cwd(), 'src/session/remoteMediaResolveQueue.ts'), 'utf8');
    expect(queueSource).toContain('onOrphanResolved?.(resolved)');
  });

  it('layers the image disk cache in front of remote fetch with empty-ossKey release exemption', () => {
    expect(screenSource).toContain('createRemoteMediaDiskCache');
    expect(screenSource).toContain('createExpoRemoteMediaDiskCacheIO');
    // 源键带设备命名空间:不同账号/设备的同名 url 不互相命中(隐私 + 内容错乱);
    // 缩略图与原图是同 url 的不同产物,磁盘键按 thumbnail 变体再分离。
    expect(screenSource).toContain("const diskSource = (media.thumbnail ? 'thumb\\u0000' : '') + bareDiskSource;");
    expect(screenSource).toContain('diskCache.lookup(diskSource)');
    // 缩略图查找带裸键兜底:回落原图(gif/老被控端)只落裸键,缩略图直接复用不二次下载
    expect(screenSource).toContain('media.thumbnail ? await diskCache.lookup(bareDiskSource)');
    // inline 缩略图落盘走 storeBytes(字节已随回包到手,不经网络下载)
    expect(screenSource).toContain('diskCache.storeBytes(diskSource, resolved.inlineBase64, resolved.mimeType)');
    // 带 size:超缓存预算的对象跳过落盘,不白下载
    expect(screenSource).toContain('diskCache.store(bareDiskSource, resolved.url, resolved.mimeType, resolved.size)');
    expect(screenSource).toContain('deviceIdRef.current');
    // ref 同步用 layout effect:子组件被动 effect 起跑前 deps/命名空间已切到新会话
    expect(screenSource).toContain('useLayoutEffect(() => {\n    remoteMediaDepsRef.current = { auth, maker };');
    expect(screenSource).toContain('useLayoutEffect(() => {\n    deviceIdRef.current = deviceId;');
    // direct 图分享按 url 扩展名推断 mime,不再一律 .jpg 落地
    expect(screenSource).toContain('imageMimeFromUrl(displayUri)');
    // 分享路径与取件落盘共用同一命名空间键,不留裸 url 读写口
    expect(screenSource).not.toContain('diskCache.lookup(media.url)');
    expect(screenSource).not.toContain('diskCache.store(media.url');
    // 分享超预算对象:store 被 LRU 立即逐出时,绕开 LRU 走一次性临时文件
    expect(screenSource).toContain('downloadRemoteMediaShareTemp');
    // 空 ossKey(磁盘缓存命中)豁免 DELETE 收敛在 deleteRemoteMediaObject 内
    expect(screenSource).toContain('if (!media.ossKey) return;');
    // Expo 适配层下载原子落位:临时名下载、正尺寸后 moveSync 顶替,失败不动现有好文件
    const expoIoSource = readTextLf(resolve(process.cwd(), 'src/session/remoteMediaDiskCacheExpo.ts'), 'utf8');
    expect(expoIoSource).toContain('.dl.tmp');
    expect(expoIoSource).toContain('tmp.moveSync(new File(dir, name), { overwrite: true })');
  });
});
