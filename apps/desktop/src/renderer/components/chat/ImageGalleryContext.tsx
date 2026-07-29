/**
 * ImageGalleryContext
 * ---------------------------------------------------------------------------
 * 把"当前会话内全部可翻阅图片的有序列表"下发给 ImageLightbox。
 *
 * 为什么需要它:聊天消息流为了性能只渲染末尾一段(RENDER_WINDOW_INITIAL_ITEMS),
 * 早期消息不在 DOM 里。如果 lightbox 只扫 DOM,计数和翻页就只能覆盖"已加载"的图,
 * 用户得先往上滚动把老图加载出来才会被算进去(codex review P2)。
 *
 * 所以改由 MessageStream 从 **allRenderItems(全量,未窗口裁剪)** 派生完整列表,
 * 经本 context 传给 lightbox —— 计数立刻是整个会话的总数,也能直接翻到最早那张
 * (img 直接按 url 加载,不依赖缩略图是否挂载)。
 *
 * 列表项带标注元数据:持久化的烧录标注图翻页到达时,lightbox 据此打开
 * "原图 + 可编辑笔迹"视图(与直接点击该图的再编辑分支同语义),否则翻页会把
 * 烧录图当普通图降级发送(codex review P2)。
 *
 * 非聊天场景(上传预览条 / 输入框预览 / 文件浏览器)不在 Provider 内,取默认
 * null,ImageLightbox 退回原有的扫 DOM / 单图行为,完全不受影响。
 */
import { createContext } from 'react';
import type { AnnotationStroke } from './lightboxAnnotations';

/** 会话画廊里的一张图:src 为渲染所用 URL(标注图 = 烧录图)。 */
export interface GalleryImage {
  src: string;
  /**
   * Optional stable identity for images rendered outside the host DOM, such as
   * plugin card iframe images. It disambiguates repeated URLs when opening the
   * conversation gallery from one of those images.
   */
  galleryId?: string;
  /** 烧录标注图的未烧录原图 URL(与 ImageRef.annotationSourceUrl 同源)。 */
  annotationSourceUrl?: string;
  /** 持久化的矢量笔迹;与 annotationSourceUrl 成对出现才有意义。 */
  annotationStrokes?: readonly AnnotationStroke[];
}

/** 当前会话全部图片的有序列表(全量)。无 Provider 时为 null。 */
export const ImageGalleryContext = createContext<readonly GalleryImage[] | null>(null);
