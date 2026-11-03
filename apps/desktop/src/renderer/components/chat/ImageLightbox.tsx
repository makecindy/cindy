import { usePreviewFocusReturn } from './PreviewChrome';
/**
 * ImageLightbox
 * ---------------------------------------------------------------------------
 * 通过 React Portal 渲染的全屏图片 lightbox。
 *
 * - 遮罩：使用 `--overlay-lightbox` 主题 token，保持 lightbox 遮罩语义一致。
 * - 图片：`object-fit: contain`，四周保留 40px 安全边距。
 * - 缩放/平移(手势数学共用 `lightboxGestures`,与 MermaidLightbox 同一套):
 *   - 各平台一致:触控板双指捏合(macOS、Windows 精密触摸板的 pinch 都由 Chromium
 *     合成为带 ctrlKey 的 wheel 事件)/ Ctrl(⌘)+滚轮 / 鼠标滚轮 → 以光标为焦点缩放;
 *     触控板双指滑动在放大后平移,适配态不响应。鼠标还是触控板按事件特征推断
 *     (见 lightboxGestures.classifyWheelSample),判不准时按鼠标处理(缩放)。
 *   - 双击图片:1x ↔ 2x 切换(以双击点为焦点)。
 *   - 放大后左键拖拽平移;松手时若拖动超过阈值,该次 click 不触发关闭。
 *   - 键盘 +/- 步进缩放,0 重置。翻页(←/→ 或箭头按钮)时视口自动重置。
 *   - 缩放范围 1x(适配窗口)~ 8x,图片不缩到比适配尺寸更小。
 * - 关闭：点击黑色背景或按 Escape 关闭。点击图片本身**不再**关闭(为双击缩放
 *   让路,也符合常见图片查看器习惯;旧行为是点图片也关闭)。
 * - 媒体动作(对齐手机版 lightbox 的功能集,底部胶囊操作栏 + 右键菜单双入口):
 *   复制图片 / 打开所在目录(右键) / 用默认应用打开 / 另存为 / 发送到对话。
 *   可用性按 src scheme 分层,见 `mediaActionCapabilities`:本地源
 *   (xdt-image:// / cindy-media:// / xdt-file://)全量;http(s)、data:image 与
 *   cindy-remote-media 的字节动作共用安全取件和原生剪贴板入口;目录定位仅
 *   用于真实本机文件或可定位的远端工作目录。其它 scheme 只读预览。
 * - 发送到对话:经 `media:cache-for-session` 为当前会话复制一份新缓存,再合入
 *   composerDraftStore(与手机版语义一致——加入输入框附件托盘,不直接发消息)。
 *   当前会话 id 来自 ChatSessionFileContext(portal 不断 context 链);聊天流外
 *   复用本组件(文件浏览器 / 输入框预览)拿到默认值 undefined,不显示该动作。
 * - 标注模式(笔按钮 / autoAnnotate / 托盘编辑):Pointer Events 落笔(鼠标、触屏、
 *   笔统一,pointer capture 保证移出图片仍能收尾),绘制中不经 React 重渲染;
 *   ⌘/Ctrl+Z 撤销、⇧⌘Z / Ctrl+Shift+Z(非 mac 另有 Ctrl+Y)重做;放大后按住 Space
 *   或中键拖拽平移;Esc / X 放弃——笔迹偏离基线时先经统一确认框确认。
 * - 右键：菜单关闭后的同一次背景点击不能顺带关闭 lightbox,见 `lastMenuCloseAt`。
 * - 动画：200ms 透明度淡入淡出。
 * - 焦点：FocusScope 打开时把焦点移入 overlay 并圈禁 Tab;卸载时还给打开前的焦点元素。
 * - 滚动锁定：打开期间给 `[data-scroll-container]` 设置 `overflowY: hidden`。
 * - 关闭按钮：按设计不显示 X 关闭按钮。
 * - 会话画廊：`enableGallery` 开启后，可用 ←/→ 或屏幕箭头在会话图片间翻页，并显示
 *   “n / 总数”计数。列表优先来自 `ImageGalleryContext`(MessageStream 下发的全量
 *   会话图片)，否则退回扫描 DOM 中的 `[data-gallery-src]`。起始下标由被点击元素的
 *   `data-gallery-active` 定位，细节见 `collectGallery` / `resolveStartIndexInFull`。
 */

import { useImageClipboard } from './useImageClipboard';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FocusScope } from '@radix-ui/react-focus-scope';
import {
  Minus,
  Plus,
  Maximize,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  MessageSquarePlus,
  Pen,
  Redo2,
  Undo2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { isEditableKeyboardTarget } from '@/lib/editableKeyboardTarget';
import { extractIpcError } from '@/utils/ipcError';
import { getMimeType, extractExt, type AttachedFile } from '@/lib/fileTypes';
import {
  blobToDataUrl,
  burnInAnnotations,
  isImageBytesReachable,
  loadImageSourceBase64,
} from '@/lib/annotationBurnIn';
import { parseRemoteMediaUrl } from '../../../shared/remoteMediaUrl';
import { toWorkdirRel } from '../../../shared/workdirPath';
import { openFileInSidebarFileBrowser } from '@/features/right-sidebar/lib/openInSidebarFileBrowser';
import { useSidebarTargetSessionId } from '@/features/cc-agent/embeddedSessionNavigation';
import {
  extendDraftSvgPath,
  normalizePoint,
  shouldAppendPoint,
  type AnnotationStroke,
  type DraftSvgPathCache,
} from './lightboxAnnotations';
import {
  INTERRUPTED_STROKE_DISCARD_SCREEN_PX,
  annotationStrokeScreenLength,
} from '@cindy/maker-shared/image-annotation';
import { AnnotationStrokesSvg, type AnnotationDraftPathRefs } from './AnnotationStrokesSvg';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getDraft, saveDraft } from '@/lib/composerDraftStore';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useChatSessionFile } from './ChatSessionFileContext';
import {
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_WHEEL_IDLE_MS,
  LIGHTBOX_ZOOM_STEP,
  clampScale,
  createWheelSourceTracker,
  imageLightboxWheelIntent,
  type LightboxViewport,
  normalizeWheelDelta,
  wheelZoomFactor,
  zoomAtPoint,
} from './lightboxGestures';
import { ImageGalleryContext, type GalleryImage } from './ImageGalleryContext';
import { containImageSize } from './imageDisplaySize';
import {
  ActivePreviewCollection,
  AttachmentCollectionPreview,
  useOpeningCollection,
} from './AttachmentCollection';
import {
  PreviewHeader,
  PreviewFooter,
  PreviewButton as LightboxToolbarButton,
} from './PreviewChrome';
import { previewAdjacentIndex, previewSourceName } from '@cindy/maker-shared/attachment-preview';

/** 图片不允许缩得比"适配窗口"更小,所以下限是 1 而不是共享常量的 0.2。 */
const IMAGE_MIN_SCALE = 1;
/** 双击放大的目标倍率(再次双击回到适配)。 */
const IMAGE_DOUBLE_CLICK_SCALE = 2;
/** 拖拽平移的位移阈值(px):超过则视为拖拽手势,松手后的 click 不关闭 lightbox。 */
const DRAG_CLICK_SUPPRESS_PX = 4;
/** 视口初始态:适配窗口、无平移。 */
const FIT_VIEWPORT: LightboxViewport = { scale: 1, tx: 0, ty: 0 };

const log = createLogger('ImageLightbox');

/** 标注层与图片盒严格同尺寸;事件由 transform 容器接管。 */
const ANNOTATION_OVERLAY_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
};

const EMPTY_STROKES: readonly AnnotationStroke[] = [];

/**
 * 画廊项可编辑的持久化笔迹:原图(annotationSourceUrl)与笔迹成对存在、且原图
 * 未被判定丢失时才返回笔迹;否则返回空(显示烧录图本身,在其上叠新标)。
 */
function editableItemStrokes(
  item: GalleryImage | undefined,
  failedSources: ReadonlySet<string>,
): readonly AnnotationStroke[] {
  if (!item?.annotationSourceUrl || !item.annotationStrokes?.length) return EMPTY_STROKES;
  return failedSources.has(item.annotationSourceUrl) ? EMPTY_STROKES : item.annotationStrokes;
}

/**
 * 标注模式下 Space 按住 = 平移修饰键;但焦点在可编辑控件或按钮类控件上时让位
 * (Space 在按钮上是激活键,键盘用户仍需用它操作工具栏 / 确认框)。
 */
function isSpacePanExemptTarget(target: EventTarget | null): boolean {
  if (isEditableKeyboardTarget(target)) return true;
  return (
    target instanceof Element &&
    target.closest('button, a[href], [role="button"], [role="menuitem"], [role="checkbox"]') !==
      null
  );
}

function isMacPlatform(): boolean {
  return typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
}

interface ImageLightboxProps {
  src: string;
  filename?: string;
  onClose: () => void;
  /**
   * Stable identity of the clicked gallery item. Needed when the source lives
   * inside an iframe, where the host DOM active-marker fallback cannot reach.
   */
  galleryId?: string;
  /**
   * 会话内翻图。开启后,lightbox 提供左右箭头 + ←/→ 键盘翻页 + "n / 总数" 计数,
   * 在当前会话的所有图片间切换。
   *
   * 图片列表优先取 `ImageGalleryContext` 下发的**全量**列表(由 MessageStream 从
   * 未裁剪的 allRenderItems 派生),所以计数立刻是整个会话的总数、也能直接翻到
   * 渲染窗口之外的早期图;拿不到 context 时退回扫描 DOM 里带 `data-gallery-src`
   * 的图(只覆盖已加载部分)。`src` 是打开时显示的那张,用来定位起始位置。
   *
   * 不传(默认 false)时行为和以前完全一致——只显示单张 `src`,无翻页 UI。
   * 这样上传预览条 / 输入框预览 / 文件浏览器等非会话场景不受影响。
   */
  enableGallery?: boolean;
  /**
   * "发送到对话"的目标会话。聊天流内不用传(从 ChatSessionFileContext 取);
   * 聊天流外的宿主(文件浏览器等)不在 provider 内,通过这个 prop 显式指定。
   * 两者都拿不到时不显示"发送到对话"。
   */
  sessionId?: string;
  /**
   * 托盘附件的"标注编辑"模式(非破坏性标注):调用方传入已有笔迹,lightbox
   * 打开即显示"原图 + 矢量笔迹",可继续画、也可撤销之前保存的笔迹。标注
   * 工具栏的出口从"发送到对话"换成"保存"——烧录结果经 onSave 交回调用方
   * 替换托盘附件;笔迹全部撤光时 onSave 收到空 strokes,调用方恢复原图。
   * 传入本 prop 时 src 应是**未烧录的原图**(annotationSourceUrl)。
   */
  annotationEdit?: {
    initialStrokes?: readonly AnnotationStroke[];
    /** 保存 = 只回传矢量笔迹(空数组 = 撤光恢复原图)。惰性烧录:位图在
     *  发送消息时才由 materializeAnnotatedAttachmentsForSend 统一生成。 */
    onSave: (result: { strokes: AnnotationStroke[] }) => void | Promise<void>;
  };
  /**
   * 打开时预置的笔迹(历史带标注图的"再编辑"场景:src 传未烧录原图,这里传
   * 持久化的笔迹)。与 annotationEdit 互斥使用;出口仍是"发送到对话"。
   */
  initialStrokes?: readonly AnnotationStroke[];
  /**
   * 与 initialStrokes 配套:该标注图的**烧录图** url。未烧录原图(src)加载失败
   * (原图缓存已被清理)时退回显示烧录图、清空预置笔迹——用户仍能查看并在其上
   * 叠加新标注,而不是提示"图片已丢失"后直接关闭(imageRef 注释的降级语义)。
   */
  annotationFallbackSrc?: string;
  /**
   * 打开即进入标注模式(等价于用户点了笔按钮)。「Mermaid/表格/公式 → 标注」
   * 这类"光栅化后直奔涂画"的入口用它省一次点击;默认 false 不影响既有场景。
   */
  autoAnnotate?: boolean;
}

/** `xdt-file://local/?path=<enc>` → 绝对路径;非该 scheme 或解析失败返回 null。 */
function xdtFileUrlToPath(url: string): string | null {
  if (!url.startsWith('xdt-file://')) return null;
  try {
    return new URL(url).searchParams.get('path');
  } catch {
    return null;
  }
}

/**
 * 复用现有 `showItemInFolder` / `copyMediaToClipboard` IPC 的参数形态:
 * xdt-image:// 走 url(main 侧 resolveSafe),xdt-file:// 解出绝对路径走 filePath。
 */
function legacyMediaIpcParams(src: string): { url?: string; filePath?: string } {
  const filePath = xdtFileUrlToPath(src);
  return filePath ? { filePath } : { url: src };
}

/**
 * 会话图片缓存原生支持的扩展名/mime 子集(与 main 侧 CACHEABLE_IMAGE_EXTS
 * 一致)。此外的可见图片格式(svg/bmp/ico、非四位图 data:)并非不可发送——
 * 发送时由 renderer 经 canvas 光栅化为 PNG 再入缓存,见 handleSendToChat。
 */
const DIRECT_CACHEABLE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const DIRECT_CACHEABLE_DATA_RE = /^data:image\/(png|jpeg|gif|webp);base64,/i;

/**
 * 能力判定 = 字节可达 + 语义适用两问(能力矩阵见文件头注释):
 * - 字节级动作(复制/另存/标注/发送):任何 lightbox 能显示的源字节都可达
 *   (本地 IPC 直读、data: 归一化、http 经 main 下载、remote 经协议取件),
 *   全部开放;
 * - 文件级动作按实体位置分语义:本地文件 → 系统打开/Finder 定位;远程会话
 *   图落临时文件打开、workdir 内文件经侧边栏文件浏览器定位(组件内解析);
 *   http 图换成"在浏览器打开原链接"。
 */
function mediaActionCapabilities(src: string, hasSession: boolean) {
  const isImageCache = src.startsWith('xdt-image://') || src.startsWith('cindy-media://');
  const localFilePath = xdtFileUrlToPath(src);
  const isLocalMedia = isImageCache || localFilePath !== null;
  const isHttp = /^https?:\/\//.test(src);
  const isRemoteMedia = src.startsWith('cindy-remote-media://');
  const bytesReachable = isImageBytesReachable(src);
  return {
    canCopy: bytesReachable,
    canReveal: isLocalMedia,
    canOpenWith: isLocalMedia || isRemoteMedia,
    canSaveAs: bytesReachable,
    canSendToChat: hasSession && bytesReachable,
    canOpenInBrowser: isHttp,
  };
}

/**
 * 该源能否直接交给 main 的 cache-for-session(否则走 renderer 光栅化 PNG)。
 * 本地源/data: 按扩展名/头部精确预判;http/remote 源 URL 无 MIME 语义,这里
 * 乐观返回 true 以保留 GIF 动图等原格式,读到字节后被缓存店拒收(svg/bmp/ico)
 * 时由 handleSendToChat 降级光栅化兜底。
 */
function isDirectCacheable(src: string): boolean {
  if (
    src.startsWith('xdt-image://') ||
    src.startsWith('cindy-media://') ||
    src.startsWith('cindy-remote-media://')
  )
    return true;
  if (/^https?:\/\//.test(src)) return true;
  if (DIRECT_CACHEABLE_DATA_RE.test(src)) return true;
  const localFilePath = xdtFileUrlToPath(src);
  return (
    localFilePath !== null && DIRECT_CACHEABLE_EXTS.has(extractExt(localFilePath).toLowerCase())
  );
}

/** 左右翻页圆形按钮的内联样式。lightbox overlay 不走 Tailwind,这里同样用内联。 */
export function ImageLightbox(props: ImageLightboxProps) {
  const items = useOpeningCollection(props.annotationFallbackSrc ?? props.src);
  return items ? (
    <AttachmentCollectionPreview
      items={items}
      source={props.annotationFallbackSrc ?? props.src}
      onClose={props.onClose}
      initial={<ImageLightboxContent {...props} enableGallery={false} />}
    />
  ) : (
    <ImageLightboxContent {...props} />
  );
}

function ImageLightboxContent({
  src,
  filename,
  onClose,
  enableGallery = false,
  galleryId,
  sessionId: sessionIdProp,
  annotationEdit,
  initialStrokes,
  annotationFallbackSrc,
  autoAnnotate = false,
}: ImageLightboxProps) {
  const { t } = useTranslation();
  // 会话全量图片列表(MessageStream 下发);非聊天场景无 Provider 时为 null。
  const restorePreviewFocus = usePreviewFocusReturn();
  const sessionImages = useContext(ImageGalleryContext);
  // 当前会话 id(发送到对话用):prop 优先(文件浏览器等 provider 外宿主),
  // 否则取聊天流 context;都没有则为 undefined → 不显示该动作。
  const { sessionId: contextSessionId, workingDir } = useChatSessionFile();
  const chatSessionId = sessionIdProp ?? contextSessionId;
  const sidebarTargetSessionId = useSidebarTargetSessionId(chatSessionId);
  const [isVisible, setIsVisible] = useState(false);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  // 会话内翻图列表 + 起始下标。只在挂载时算一次,翻页只在已知列表内移动下标。
  // enableGallery 关时退化成单张 [src]。开启时:
  //   1) 优先用 context 的全量列表(覆盖整个会话,含渲染窗口外的早期图),
  //      起始下标用位置映射精确定位用户点的那张;
  //   2) 没有 context(理论上不该发生)才退回扫 DOM —— 只覆盖已加载部分。
  // 关键守卫:只有当 `src` 确实在候选列表里时才进画廊。否则(例如 Markdown /
  // 本地文件**链接**复用同一个 lightbox 打开,但它们不是画廊图片)退回单张,
  // 不然会套用会话画廊、起始落到不相干的第 0 张图。
  const [gallery] = useState<{ items: readonly GalleryImage[]; start: number }>(() => {
    if (!enableGallery) {
      // 历史标注图再编辑:单张项带上烧录图 + 原图元数据,原图丢失时可退回烧录图
      // (与画廊翻到标注图走同一套 currentSrc 推导)。
      if (annotationFallbackSrc && !annotationEdit && initialStrokes?.length) {
        return {
          items: [
            {
              src: annotationFallbackSrc,
              annotationSourceUrl: src,
              annotationStrokes: initialStrokes,
            },
          ],
          start: 0,
        };
      }
      return { items: [{ src }], start: 0 };
    }
    const keyedIndex =
      galleryId && sessionImages
        ? sessionImages.findIndex((item) => item.galleryId === galleryId)
        : -1;
    if (sessionImages && keyedIndex >= 0) {
      return { items: sessionImages, start: keyedIndex };
    }
    if (sessionImages?.some((g) => g.src === src)) {
      return { items: sessionImages, start: Math.max(
          0,
          sessionImages.findIndex((image) => image.src === src)),
      };
    }
    return { items: [{ src }], start: 0 };
  });
  const galleryItems = gallery.items;
  const [index, setIndex] = useState<number>(gallery.start);
  const hasMultiple = galleryItems.length > 1;
  // 翻页到持久化标注图:显示未烧录原图 + 预置笔迹(可编辑,与直接点击该图的
  // 再编辑分支同语义),而非把烧录图当普通图降级(review P2)。笔迹预置在
  // index effect 里(挂载首帧由 initialStrokes 承担)。
  const currentItem = galleryItems[index] ?? { src };
  // 已确认加载失败(被清理)的未烧录原图:该项退回烧录图 + 空笔迹。
  const [failedAnnotationSources, setFailedAnnotationSources] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const failedAnnotationSourcesRef = useRef(failedAnnotationSources);
  failedAnnotationSourcesRef.current = failedAnnotationSources;
  const currentSrc =
    currentItem.annotationSourceUrl &&
    currentItem.annotationStrokes?.length &&
    !failedAnnotationSources.has(currentItem.annotationSourceUrl)
      ? currentItem.annotationSourceUrl
      : currentItem.src;
  const isClosingRef = useRef(false);
  // 右键菜单位置；行为与 LightboxImage 缩略图保持一致。
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // 下拉菜单关闭时记录 performance.now()。overlay click 与 document Esc 会读取它,
  // 吞掉紧接着的同一次事件，避免 Radix 先关闭菜单后又把 lightbox 一起关掉。
  const lastMenuCloseAt = useRef(0);

  // ---- 缩放 / 平移(结构与 MermaidLightbox 一致,数学在 lightboxGestures) ----
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isWheeling, setIsWheeling] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  // viewportRef 与 React state 同步写(applyViewport 是唯一写入口),让只绑一次的
  // native wheel listener / 拖拽 handler 读到的永远是最新视口,不受闭包过期影响。
  const viewportRef = useRef<LightboxViewport>(FIT_VIEWPORT);
  const dragStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  // 本次按下-抬起手势是否发生过超阈值位移;为真时抑制随后的 overlay click 关闭。
  const dragMovedRef = useRef(false);
  const isWheelingRef = useRef(false);
  const wheelIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- 标注模式状态(鼠标当笔圈点) ----
  // autoAnnotate 只作初值:打开即进标注,退出/放弃后的行为与手动进入一致。
  const [isAnnotating, setIsAnnotating] = useState(autoAnnotate);
  // 当前图打开时的基线笔迹:放弃标注(X / Esc)恢复到这里而非一律清空——
  // 画廊翻到持久化标注图后,基线是该图的持久化笔迹。翻页 effect 同步更新。
  const baselineStrokesRef = useRef<readonly AnnotationStroke[]>(
    annotationEdit?.initialStrokes ??
      initialStrokes ??
      gallery.items[gallery.start]?.annotationStrokes ??
      [],
  );
  // 已保存的笔迹起步(托盘编辑或历史图再编辑)——"撤销之前的编辑"就是从
  // 这里往回 pop。
  const [strokes, setStrokes] = useState<AnnotationStroke[]>(() => [...baselineStrokesRef.current]);
  // 重做栈:撤销弹出的笔迹按序压栈;画新笔迹、放弃标注、翻页时清空。ref 供事件
  // handler 同步读写(按键连发),canRedo 驱动工具栏重做按钮的可用态。
  const redoStackRef = useRef<AnnotationStroke[]>([]);
  const [canRedo, setCanRedo] = useState(false);
  const setRedoStack = useCallback((next: AnnotationStroke[]) => {
    redoStackRef.current = next;
    setCanRedo(next.length > 0);
  }, []);
  // 标注模式下按住 Space = 平移修饰键(state 驱动光标,ref 供事件 handler 同步读)。
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceHeldRef = useRef(false);
  // 放弃确认框在途:期间忽略 lightbox 自己的全部快捷键,避免同一次 Esc 既关确认框
  // 又再次触发放弃(Radix 在 capture 阶段处理 Esc,本组件的 document 监听随后
  // 仍会收到同一事件)。
  const confirmPendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // 图片自然尺寸:SVG viewBox 与烧录 canvas 的坐标基准。onLoad 时设置。
  const [naturalSize, setNaturalSize] = useState<{ src: string; w: number; h: number } | null>(
    null,
  );
  const [viewportSize, setViewportSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const imgRef = useRef<HTMLImageElement>(null);
  // once-bound keydown handler 需要读到最新标注态,与 viewportRef 同一模式。
  const isAnnotatingRef = useRef(false);
  const strokesRef = useRef<AnnotationStroke[]>([]);
  isAnnotatingRef.current = isAnnotating;
  strokesRef.current = strokes;

  // 退出标注模式时复位 Space 平移修饰(keyup 可能落在模式切换之后)。
  useEffect(() => {
    if (isAnnotating || !spaceHeldRef.current) return;
    spaceHeldRef.current = false;
    setSpaceHeld(false);
  }, [isAnnotating]);

  useEffect(() => {
    const updateViewportSize = () => {
      setViewportSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', updateViewportSize);
    return () => window.removeEventListener('resize', updateViewportSize);
  }, []);

  // index 变化后的 effect 会在 commit 后清空状态；渲染阶段先按 src 校验，
  // 避免新图首帧沿用上一张图的宽高比（标注坐标也必须遵守同一约束）。
  const currentNaturalSize = naturalSize?.src === currentSrc ? naturalSize : null;
  const fittedImageSize = currentNaturalSize
    ? containImageSize(
        { width: currentNaturalSize.w, height: currentNaturalSize.h },
        viewportSize.width - 80,
        viewportSize.height - 160,
      )
    : null;

  /** 同步更新 ref 与 state:连续快捷键(按键连发)在重渲染前也读到最新笔迹。 */
  const replaceStrokes = useCallback((next: AnnotationStroke[]) => {
    strokesRef.current = next;
    setStrokes(next);
  }, []);

  const undoLastStroke = useCallback(() => {
    const current = strokesRef.current;
    if (current.length === 0) return;
    setRedoStack([...redoStackRef.current, current[current.length - 1]]);
    replaceStrokes(current.slice(0, -1));
  }, [replaceStrokes, setRedoStack]);

  const redoStroke = useCallback(() => {
    const redo = redoStackRef.current;
    if (redo.length === 0) return;
    setRedoStack(redo.slice(0, -1));
    replaceStrokes([...strokesRef.current, redo[redo.length - 1]]);
  }, [replaceStrokes, setRedoStack]);

  /**
   * 放弃标注:恢复到打开时的笔迹(编辑模式=上次保存的;发送模式=空)并退出
   * 标注模式。X 按钮与标注中的 Esc 都走这里。
   *
   * autoAnnotate 宿主(Mermaid/表格/公式的「标注」入口)整个 lightbox 就是
   * 为标注而开的临时光栅化图,放弃标注后留在图片界面没有意义——直接关闭
   * 整个 lightbox 回到原界面。
   */
  const performDiscardAnnotation = () => {
    if (autoAnnotate) {
      handleClose();
      return;
    }
    resetDraftStroke();
    setRedoStack([]);
    replaceStrokes([...baselineStrokesRef.current]);
    setIsAnnotating(false);
  };

  /**
   * 当前笔迹是否偏离基线(或有进行中的笔迹)。笔迹对象不可变、基线复制的是
   * 同一批对象引用,所以按长度 + 逐项身份比较即可:撤销后再重做回来的笔迹
   * 仍视为未改动。
   */
  const hasUnsavedStrokeChanges = (): boolean => {
    if (draftStrokeRef.current) return true;
    const current = strokesRef.current;
    const baseline = baselineStrokesRef.current;
    return current.length !== baseline.length || current.some((s, i) => s !== baseline[i]);
  };

  const confirmDialog = useOptionalConfirmDialog();
  /**
   * 放弃标注入口(X 按钮 / 标注中的 Esc)。笔迹与基线相同时行为与以往完全一致
   * (立即恢复并退出);有改动时先经应用统一确认框确认,避免误触丢掉笔迹。
   * 裸渲染环境(无 ConfirmDialogProvider)退回旧行为。
   */
  const discardAnnotation = async (): Promise<void> => {
    if (confirmPendingRef.current) return;
    if (!confirmDialog || !hasUnsavedStrokeChanges()) {
      performDiscardAnnotation();
      return;
    }
    confirmPendingRef.current = true;
    let confirmed = false;
    try {
      confirmed = await confirmDialog.confirm({
        title: t('chat.media.annotateDiscardConfirmTitle'),
        description: t('chat.media.annotateDiscardConfirmDescription'),
        confirmText: t('chat.media.annotateDiscardConfirmAction'),
        cancelText: t('chat.media.annotateDiscardConfirmCancel'),
        confirmVariant: 'destructive',
      });
    } finally {
      // 推迟到下一个宏任务再解除:关闭确认框的那次 Esc 仍在派发中(微任务会在
      // 两个监听之间清空),立即解除会让本组件的 keydown 再放弃一次。
      setTimeout(() => {
        confirmPendingRef.current = false;
      }, 0);
    }
    if (confirmed && mountedRef.current) performDiscardAnnotation();
  };
  // once-bound keydown handler 通过 ref 调用最新的放弃逻辑(依赖 confirmDialog 等
  // 每次渲染的值)。
  const activeCollection = useContext(ActivePreviewCollection);
  const requestClose = async (leave = handleClose) => {
    if (confirmPendingRef.current) return;
    if (!hasUnsavedStrokeChanges()) {
      leave();
      return;
    }
    if (!confirmDialog) return;
    confirmPendingRef.current = true;
    try {
      const canSave = Boolean(annotationEdit || chatSessionId);
      const choice = canSave
        ? await confirmDialog.confirmThree({
            title: t('chat.media.annotateDiscardConfirmTitle'),
            description: t('chat.media.annotateDiscardConfirmDescription'),
            confirmText: t('chat.media.annotateSave'),
            cancelText: t('chat.media.annotateDiscardConfirmCancel'),
            tertiaryText: t('chat.media.annotateDiscardConfirmAction'),
          })
        : (await confirmDialog.confirm({
              title: t('chat.media.annotateDiscardConfirmTitle'),
              confirmText: t('chat.media.annotateDiscardConfirmAction'),
              cancelText: t('chat.media.annotateDiscardConfirmCancel'),
            }))
          ? 'tertiary'
          : 'cancel';
      if (!mountedRef.current) return;
      if (choice === 'tertiary') leave();
      if (choice === 'confirm') {
        if (annotationEdit) await handleAnnotationSave(leave);
        else await handleSendToChat(leave);
      }
    } finally {
      setTimeout(() => {
        confirmPendingRef.current = false;
      }, 0);
    }
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => {
    if (!activeCollection) return;
    activeCollection.beforeLeave.current = (leave) => {
      void requestCloseRef.current(leave);
    };
    return () => {
      activeCollection.beforeLeave.current = null;
    };
  }, [activeCollection?.beforeLeave]);

  const applyViewport = useCallback((next: LightboxViewport) => {
    viewportRef.current = next;
    setScale(next.scale);
    setTranslate({ x: next.tx, y: next.ty });
  }, []);

  // 滚轮连续事件期间关掉 transform 过渡动画,避免高频小步缩放被 80ms transition
  // 拖出"追不上手"的粘滞感;停止滚动 LIGHTBOX_WHEEL_IDLE_MS 后恢复。
  const markWheeling = useCallback(() => {
    if (!isWheelingRef.current) {
      isWheelingRef.current = true;
      setIsWheeling(true);
    }
    if (wheelIdleTimerRef.current) clearTimeout(wheelIdleTimerRef.current);
    wheelIdleTimerRef.current = setTimeout(() => {
      isWheelingRef.current = false;
      setIsWheeling(false);
      wheelIdleTimerRef.current = null;
    }, LIGHTBOX_WHEEL_IDLE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (wheelIdleTimerRef.current) clearTimeout(wheelIdleTimerRef.current);
    };
  }, []);

  const resetViewport = useCallback(() => {
    applyViewport(FIT_VIEWPORT);
  }, [applyViewport]);

  /** 以视口中心为焦点的步进缩放(键盘 +/- 用)。 */
  const zoomBy = useCallback(
    (factor: number) => {
      const current = viewportRef.current;
      const nextScale = clampScale(current.scale * factor, IMAGE_MIN_SCALE, LIGHTBOX_MAX_SCALE);
      if (nextScale === current.scale) return;
      // 回到 1x 时顺带清掉平移,否则图片会停在偏移位置。
      if (nextScale === 1) {
        applyViewport(FIT_VIEWPORT);
        return;
      }
      applyViewport({ ...current, scale: nextScale });
    },
    [applyViewport],
  );

  // 翻页时重置视口与标注:上一张的缩放/平移/笔迹不应带到下一张;
  // 自然尺寸也随 src 失效,等新图 onLoad 重新设置。跳过挂载首帧——
  // 初始笔迹(编辑模式)与初始视口本来就是正确状态,首帧清空会把
  // initialStrokes 抹掉。
  const indexEffectRanRef = useRef(false);
  useEffect(() => {
    if (!indexEffectRanRef.current) {
      indexEffectRanRef.current = true;
      return;
    }
    resetViewport();
    setIsAnnotating(false);
    // 翻到持久化标注图时预置其笔迹(配合 currentSrc 换到原图,进入可编辑
    // 视图);普通图照旧清空。基线同步更新,放弃标注恢复到该图的基线。
    baselineStrokesRef.current = editableItemStrokes(
      galleryItems[index],
      failedAnnotationSourcesRef.current,
    );
    resetDraftStroke();
    setRedoStack([]);
    replaceStrokes([...baselineStrokesRef.current]);
    setNaturalSize(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: galleryItems 挂载时固定。
  }, [index, resetViewport]);

  // 滚轮 / 触控板。native listener + passive:false 才能 preventDefault,阻止事件穿透
  // 到底下的聊天区,也阻止 Chromium 对 ctrl+wheel 的页面级缩放。路由见
  // imageLightboxWheelIntent(各平台一致):双指捏合(Chromium 合成为 ctrlKey=true 的
  // wheel)、⌘/Ctrl+滚轮与鼠标滚轮以光标为焦点缩放;触控板双指滑动在放大后平移。
  // 鼠标 / 触控板按事件特征推断(classifyWheelSample),每段连续滚动只判定一次。
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const trackWheelSource = createWheelSourceTracker();
    const onWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();
      const current = viewportRef.current;
      const source =
        e.ctrlKey || e.metaKey
          ? 'mouse'
          : trackWheelSource(
              {
                deltaMode: e.deltaMode,
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                shiftKey: e.shiftKey,
                // 非标准的旧字段(Chromium 仍提供),推断设备类型的关键信号。
                wheelDeltaY: (e as globalThis.WheelEvent & { wheelDeltaY?: number }).wheelDeltaY,
              },
              e.timeStamp,
            );
      const intent = imageLightboxWheelIntent(e, source, current.scale);
      if (intent === 'none') return;
      if (intent === 'pan') {
        markWheeling();
        applyViewport({
          ...current,
          tx: current.tx - normalizeWheelDelta(e.deltaX, e.deltaMode),
          ty: current.ty - normalizeWheelDelta(e.deltaY, e.deltaMode),
        });
        return;
      }
      const rect = overlay.getBoundingClientRect();
      const point = {
        // 光标相对 overlay 中心的坐标。图片由 flex 居中,其盒中心与 overlay 中心
        // 重合,而 transform-origin 是图片中心,所以这就是焦点缩放的参考系。
        cx: e.clientX - rect.left - rect.width / 2,
        cy: e.clientY - rect.top - rect.height / 2,
      };
      const next = zoomAtPoint(
        current,
        point,
        wheelZoomFactor(e.deltaY, e.deltaMode),
        IMAGE_MIN_SCALE,
        LIGHTBOX_MAX_SCALE,
      );
      if (next === current) return;
      markWheeling();
      // 缩回 1x 时清平移,和 zoomBy 的语义保持一致。
      applyViewport(next.scale === 1 ? FIT_VIEWPORT : next);
    };
    overlay.addEventListener('wheel', onWheel, { passive: false });
    return () => overlay.removeEventListener('wheel', onWheel);
  }, [applyViewport, markWheeling]);

  /** 放大状态下开始拖拽平移(适配态没有可平移的范围,不响应)。 */
  function startPan(clientX: number, clientY: number) {
    if (viewportRef.current.scale <= 1) return;
    dragMovedRef.current = false;
    setIsDragging(true);
    const current = viewportRef.current;
    dragStartRef.current = { x: clientX, y: clientY, tx: current.tx, ty: current.ty };
  }

  /** 放大状态下按住图片开始拖拽平移。 */
  function handleImageMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    // preventDefault 同时抑制 <img> 的原生拖拽 ghost 与文字选区。
    e.preventDefault();
    startPan(e.clientX, e.clientY);
  }

  // 拖拽期间 move/up 绑到 window,光标移出图片仍能继续拖;仅 isDragging 时挂载。
  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: globalThis.MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.abs(dx) > DRAG_CLICK_SUPPRESS_PX || Math.abs(dy) > DRAG_CLICK_SUPPRESS_PX) {
        dragMovedRef.current = true;
      }
      applyViewport({
        scale: viewportRef.current.scale,
        tx: start.tx + dx,
        ty: start.ty + dy,
      });
    };
    const onUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
      // click 事件在 mouseup 后同步派发,先让 overlay onClick 读到抑制标记;
      // 随后异步清零,避免拖拽落在 stopPropagation 的子元素上时标记残留,
      // 误吞下一次真正的背景点击。
      setTimeout(() => {
        dragMovedRef.current = false;
      }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [applyViewport, isDragging]);

  /** 双击:适配态放大到 IMAGE_DOUBLE_CLICK_SCALE(以双击点为焦点),否则回到适配。 */
  function handleImageDoubleClick(e: React.MouseEvent) {
    const current = viewportRef.current;
    if (current.scale !== 1) {
      resetViewport();
      return;
    }
    const overlay = overlayRef.current;
    if (!overlay) return;
    const rect = overlay.getBoundingClientRect();
    const point = {
      cx: e.clientX - rect.left - rect.width / 2,
      cy: e.clientY - rect.top - rect.height / 2,
    };
    applyViewport(
      zoomAtPoint(current, point, IMAGE_DOUBLE_CLICK_SCALE, IMAGE_MIN_SCALE, LIGHTBOX_MAX_SCALE),
    );
  }

  // ---- 标注模式手势与烧录(状态声明在视口区,几何/烧录纯函数在 lightboxAnnotations) ----

  // 进行中笔迹的事实源:ref(事件 handler 同步读写)。绘制中不经 React state——
  // 每个 move 事件只往 ref 里追加一点,再由 rAF 合帧直接改写两条草稿 path 的
  // `d`(描边层 / 红线层,见 AnnotationStrokesSvg),避免每次移动都复制整条点
  // 数组并重渲染整个 lightbox。
  // ⚠️ 提交笔迹绝不能写在 setState updater 内部——updater 必须是纯函数,
  // StrictMode(dev)会双调 updater,曾导致每笔被 push 两次:两条笔迹完全
  // 重叠肉眼不可见,表现为"撤销要点两次才生效"。
  const draftStrokeRef = useRef<AnnotationStroke | null>(null);
  /** 正在绘制的指针(pointer capture 的所有者);null = 未在绘制。 */
  const drawingPointerIdRef = useRef<number | null>(null);
  const draftPathCacheRef = useRef<DraftSvgPathCache | null>(null);
  const draftRafRef = useRef<number | null>(null);
  const draftOutlinePathRef = useRef<SVGPathElement>(null);
  const draftStrokePathRef = useRef<SVGPathElement>(null);
  const draftPathRefs = useRef<AnnotationDraftPathRefs>({
    outline: draftOutlinePathRef,
    stroke: draftStrokePathRef,
  }).current;
  // rAF 回调读取的自然尺寸(与 SVG viewBox 同源)。
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
  naturalSizeRef.current = currentNaturalSize;

  function writeDraftPath(d: string) {
    draftOutlinePathRef.current?.setAttribute('d', d);
    draftStrokePathRef.current?.setAttribute('d', d);
  }

  function paintDraftStroke() {
    draftRafRef.current = null;
    const draft = draftStrokeRef.current;
    const size = naturalSizeRef.current;
    if (!draft || !size) return;
    draftPathCacheRef.current = extendDraftSvgPath(
      draft.points,
      size.w,
      size.h,
      draftPathCacheRef.current,
    );
    writeDraftPath(draftPathCacheRef.current.d);
  }

  function scheduleDraftPaint() {
    if (draftRafRef.current !== null) return;
    draftRafRef.current = requestAnimationFrame(paintDraftStroke);
  }

  /** 丢弃进行中的笔迹(放弃标注 / 翻页 / 卸载)。 */
  function resetDraftStroke() {
    if (draftRafRef.current !== null) {
      cancelAnimationFrame(draftRafRef.current);
      draftRafRef.current = null;
    }
    draftStrokeRef.current = null;
    drawingPointerIdRef.current = null;
    draftPathCacheRef.current = null;
    writeDraftPath('');
  }

  useEffect(
    () => () => {
      if (draftRafRef.current !== null) cancelAnimationFrame(draftRafRef.current);
    },
    [],
  );

  // 提交后的笔迹由 React 渲染进已提交图层;在同一次提交的 layout 阶段(绘制前)
  // 再清空草稿 path,松手瞬间不会出现"笔迹消失一帧"的闪烁。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在笔迹列表变化时收尾草稿。
  useLayoutEffect(() => {
    if (drawingPointerIdRef.current === null && draftStrokeRef.current === null) {
      draftPathCacheRef.current = null;
      writeDraftPath('');
    }
  }, [strokes]);

  /** 当前指针位置 → 归一化图片坐标(rect 已含缩放/平移 transform)。 */
  function pointFromClient(clientX: number, clientY: number) {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return normalizePoint(clientX, clientY, rect);
  }

  /**
   * 标注模式的鼠标按下:只负责平移手势(中键拖拽 / 按住 Space 左键拖拽)与
   * 抑制原生拖拽 ghost、文字选区;画笔由 pointer 事件负责(鼠标 / 触屏 / 笔统一)。
   */
  function handleAnnotateMouseDown(e: React.MouseEvent) {
    if (e.button === 1 || (e.button === 0 && spaceHeldRef.current)) {
      // 中键 preventDefault 同时阻止 Windows / Linux 的中键自动滚动。
      e.preventDefault();
      startPan(e.clientX, e.clientY);
      return;
    }
    if (e.button === 0) e.preventDefault();
  }

  /** 画笔起笔:仅主键(鼠标左键 / 触屏 / 笔尖接触),平移修饰键按住时不画。 */
  function handleAnnotatePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || spaceHeldRef.current) return;
    // 多点触控:已有指针在画时忽略其它手指。
    if (drawingPointerIdRef.current !== null) return;
    const point = pointFromClient(e.clientX, e.clientY);
    if (!point) return;
    draftStrokeRef.current = { points: [point] };
    draftPathCacheRef.current = null;
    drawingPointerIdRef.current = e.pointerId;
    // pointer capture:移出图片 / 窗口仍能继续画与收尾(等价旧实现的 window 监听)。
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // 指针已失效(极端竞态)时 capture 失败不影响本笔绘制。
    }
    scheduleDraftPaint();
  }

  function handleAnnotatePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerId !== drawingPointerIdRef.current) return;
    const draft = draftStrokeRef.current;
    if (!draft) return;
    const point = pointFromClient(e.clientX, e.clientY);
    if (!point || !shouldAppendPoint(draft, point)) return;
    // 草稿笔迹提交前只归本 ref 所有,原地追加(O(1));提交后不再修改。
    draft.points.push(point);
    scheduleDraftPaint();
  }

  /** 收笔(pointerup / 失去 capture 走这里,较长的 pointercancel 也经此提交;幂等)。 */
  function finishAnnotateStroke(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerId !== drawingPointerIdRef.current) return;
    const draft = draftStrokeRef.current;
    drawingPointerIdRef.current = null;
    draftStrokeRef.current = null;
    if (draftRafRef.current !== null) {
      cancelAnimationFrame(draftRafRef.current);
      draftRafRef.current = null;
    }
    if (draft && draft.points.length > 0) {
      setRedoStack([]);
      replaceStrokes([...strokesRef.current, draft]);
    } else {
      draftPathCacheRef.current = null;
      writeDraftPath('');
    }
  }

  /**
   * pointercancel(系统 / 浏览器接管了这次触摸或笔输入,并非用户抬笔):很短的
   * 半笔视为误触丢弃,较长的笔迹照常保留,不丢用户真正画的内容。阈值与手机端
   * 多指打断共用。
   */
  function cancelAnnotateStroke(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerId !== drawingPointerIdRef.current) return;
    const draft = draftStrokeRef.current;
    const rect = imgRef.current?.getBoundingClientRect();
    if (
      draft &&
      rect &&
      annotationStrokeScreenLength(draft.points, rect.width, rect.height) <
        INTERRUPTED_STROKE_DISCARD_SCREEN_PX
    ) {
      resetDraftStroke();
      return;
    }
    finishAnnotateStroke(e);
  }

  /** 即时烧录当前所见(复制/另存为用),实现在共享模块 annotationBurnIn。 */
  async function materializeAnnotatedImage(
    outMimeOverride?: 'image/png' | 'image/jpeg',
  ): Promise<{ blob: Blob; mimeType: string }> {
    const source = await loadImageSourceBase64(currentSrc);
    return burnInAnnotations(source, strokesRef.current, outMimeOverride);
  }

  // 挂载后触发淡入。
  useEffect(() => {
    const raf = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Esc 关闭；+/-/0 缩放;开启会话画廊时用 ←/→ 翻图。
  // biome-ignore lint/correctness/useExhaustiveDependencies: galleryItems 在挂载时固定；这里只订阅一次全局键盘事件，避免反复绑定 DOM listener。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 放弃确认框打开期间,按键归确认框(含关闭它的那次 Esc)。
      if (confirmPendingRef.current || e.defaultPrevented || isEditableKeyboardTarget(e.target)) return;
      if (e.key === 'Escape') {
        if (performance.now() - lastMenuCloseAt.current < 150) return;
        // 标注模式中 Esc = 放弃标注(清笔迹退出),再按一次才关 lightbox。
        if (isAnnotatingRef.current) {
          if (!hasUnsavedStrokeChanges()) performDiscardAnnotation();
          else void requestCloseRef.current();
          return;
        }
        handleClose();
        return;
      }
      // 标注模式按住 Space = 平移修饰键(焦点在输入 / 按钮类控件上时让位)。
      if (e.code === 'Space' || e.key === ' ') {
        if (isAnnotatingRef.current && !isSpacePanExemptTarget(e.target)) {
          e.preventDefault();
          if (!spaceHeldRef.current) {
            spaceHeldRef.current = true;
            setSpaceHeld(true);
          }
        }
        return;
      }
      // 标注模式撤销 / 重做(在修饰键放行守卫之前拦截):⌘/Ctrl+Z 撤销,
      // ⇧⌘Z / Ctrl+Shift+Z 重做,非 mac 另支持 Ctrl+Y。
      if (isAnnotatingRef.current && (e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redoStroke();
        else undoLastStroke();
        return;
      }
      if (
        isAnnotatingRef.current &&
        !isMacPlatform() &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        (e.key === 'y' || e.key === 'Y')
      ) {
        e.preventDefault();
        redoStroke();
        return;
      }
      // 步进缩放。zoomBy / resetViewport 只读写 ref + 稳定 setter,首帧闭包即终身有效。
      // 带修饰键的组合(Cmd/Ctrl +/-/0 是应用级缩放快捷键)不劫持,原样放行。
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomBy(LIGHTBOX_ZOOM_STEP);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomBy(1 / LIGHTBOX_ZOOM_STEP);
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        resetViewport();
        return;
      }
      // gallery 翻页:列表 >1 张时才接管方向键。用 setIndex updater + 闭包里
      // 稳定的 galleryItems(useState 初始化后不变),所以空依赖 effect 不会拿到
      // 过期的下标。环形翻页,到头/到尾自动绕回。
      // 标注模式中禁用翻页(翻页会清空笔迹,误触代价高)。
      if (isAnnotatingRef.current) return;
      if (galleryItems.length <= 1) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIndex((i) => previewAdjacentIndex(i, 1, galleryItems.length));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIndex((i) => previewAdjacentIndex(i, -1, galleryItems.length));
      }
    };
    // Space 松开:结束平移修饰(只处理本组件接管过的那次按键)。
    const keyUpHandler = (e: KeyboardEvent) => {
      if ((e.code === 'Space' || e.key === ' ') && spaceHeldRef.current) {
        e.preventDefault();
        spaceHeldRef.current = false;
        setSpaceHeld(false);
      }
    };
    // 窗口失焦时收不到 keyup,修饰状态必须复位,否则回来后无法落笔。
    const blurHandler = () => {
      if (!spaceHeldRef.current) return;
      spaceHeldRef.current = false;
      setSpaceHeld(false);
    };
    document.addEventListener('keydown', handler);
    document.addEventListener('keyup', keyUpHandler);
    window.addEventListener('blur', blurHandler);
    return () => {
      document.removeEventListener('keydown', handler);
      document.removeEventListener('keyup', keyUpHandler);
      window.removeEventListener('blur', blurHandler);
    };
    // handleClose / gallery 都在组件生命周期内稳定(onClose 是调用方传的稳定
    // setState dispatch;gallery 由 useState 初始化后不再变)。只在挂载/卸载
    // 订阅一次是有意为之——每次渲染重订阅会带来无谓的 DOM listener 抖动。
  }, []);

  // 打开期间锁住聊天滚动容器。
  useEffect(() => {
    const container = document.querySelector('[data-scroll-container]') as HTMLElement | null;
    if (container) container.style.overflowY = 'hidden';
    return () => {
      if (container) container.style.overflowY = '';
    };
  }, []);

  function handleClose() {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsVisible(false);
    setTimeout(() => onClose(), 200);
  }

  const { copyImage } = useImageClipboard(currentSrc);

  // 有笔迹时动作不隐藏,而是按对象分层:位图级动作(复制/另存为)作用于
  // "当前所见"——烧录合成图;文件级动作(默认应用打开/定位目录)指向原图
  // 文件(合成图没有磁盘实体)。
  const { canCopy, canReveal, canOpenWith, canSaveAs, canSendToChat, canOpenInBrowser } =
    mediaActionCapabilities(currentSrc, Boolean(chatSessionId));
  // 远程会话图:origUrl 是 workdir 内文件时,"打开所在目录"经侧边栏文件浏览器
  // 定位远端目录(被控端文件本机 Finder 无从 reveal;缓存图在 workdir 外,
  // 文件浏览器根覆盖不到,不提供)。
  const remoteWorkdirRelPath = (() => {
    if (!currentSrc.startsWith('cindy-remote-media://') || !workingDir) return null;
    const parsed = parseRemoteMediaUrl(currentSrc);
    const origPath = parsed ? xdtFileUrlToPath(parsed.origUrl) : null;
    return origPath ? toWorkdirRel(workingDir, origPath) : null;
  })();
  const canRevealRemote = Boolean(chatSessionId && remoteWorkdirRelPath);
  const hasAnyAction =
    canCopy ||
    canReveal ||
    canRevealRemote ||
    canOpenWith ||
    canSaveAs ||
    canSendToChat ||
    canOpenInBrowser;

  // 画笔入口:发送场景要求能发送到对话(标注的出口是发送);编辑场景(托盘)
  // 出口是保存,不要求会话。源条件 = 字节可达(五种来源全覆盖:http/remote
  // 经 main 取字节进 canvas,无 taint 问题)。
  const canAnnotate =
    (annotationEdit ? true : canSendToChat) &&
    naturalSize !== null &&
    isImageBytesReachable(currentSrc);

  async function handleRevealInFolder(): Promise<void> {
    const res = await window.electronAPI.showItemInFolder(legacyMediaIpcParams(currentSrc));
    if (!res.success) {
      toast.error(res.error ?? t('chat.media.openFolderFailed'));
    }
    setMenuPos(null);
  }

  /** 远程会话图:在侧边栏文件浏览器里定位该远端文件(展开所在目录并选中)。 */
  async function handleRevealRemote(): Promise<void> {
    setMenuPos(null);
    if (!sidebarTargetSessionId || !remoteWorkdirRelPath) return;
    try {
      await openFileInSidebarFileBrowser(sidebarTargetSessionId, remoteWorkdirRelPath);
    } catch {
      toast.error(t('chat.media.openFolderFailed'));
    }
  }

  /** http 图:在系统默认浏览器打开原链接(比"另存后再看"语义更直接)。 */
  async function handleOpenInBrowser(): Promise<void> {
    setMenuPos(null);
    try {
      await window.electronAPI.openExternal(currentSrc);
    } catch {
      toast.error(t('chat.media.openWithAppFailed'));
    }
  }

  async function handleCopyImage(): Promise<void> {
    setMenuPos(null);
    await copyImage(strokesRef.current);
  }

  async function handleOpenWithApp(): Promise<void> {
    try {
      await window.electronAPI.openMediaWithDefaultApp({ url: currentSrc });
    } catch (err) {
      toast.error(extractIpcError(err)?.message ?? t('chat.media.openWithAppFailed'));
    }
    setMenuPos(null);
  }

  async function handleSaveAs(): Promise<void> {
    try {
      // 有笔迹时另存"所见":烧录成 data: URL 交给同一个 save-as IPC
      // (main 侧 classify 原生支持 data:image),原图不动。
      let saveUrl = currentSrc;
      if (strokesRef.current.length > 0) {
        const { blob } = await materializeAnnotatedImage();
        saveUrl = await blobToDataUrl(blob);
      } else if (
        /^data:image\//i.test(currentSrc) &&
        !/^data:image\/[a-z0-9+.-]+;base64,/i.test(currentSrc)
      ) {
        // main 的 save-as 只认无参数的 `data:image/...;base64,` 形式:URL-encoded
        // 或带 MIME 参数(`;charset=utf-8` 等)的 data: 先经字节层归一化(字节层
        // 保证输出无参数 mime),否则按钮可见却必抛 INVALID_PARAMS(review P2)。
        const { base64, mimeType } = await loadImageSourceBase64(currentSrc);
        saveUrl = `data:${mimeType};base64,${base64}`;
      }
      const res = await window.electronAPI.saveMediaAs({ url: saveUrl });
      // 用户在系统对话框里取消不是错误,也不需要 toast。
      if (!res.canceled) toast.success(t('chat.media.imageSaved'));
    } catch (err) {
      toast.error(extractIpcError(err)?.message ?? t('chat.media.saveFailed'));
    }
    setMenuPos(null);
  }

  /**
   * 发送到对话:main 侧为当前会话复制一份新的 xdt-image:// 缓存(不能直接复用
   * 原 URL——托盘移除附件会删缓存文件,复用会误删历史消息的图),然后把
   * AttachedFile 合入 composerDraftStore。非 silent 写入会同时通知挂载中的
   * useAttachments(刷新托盘)与 ChatInput(重设文本并聚焦末尾——正好把焦点
   * 交还输入框,与手机版"回会话页聚焦 composer"一致)。成功后关闭 lightbox。
   */
  async function handleSendToChat(afterSave = handleClose): Promise<void> {
    if (!chatSessionId) return;
    setMenuPos(null);
    try {
      const strokes = strokesRef.current;
      let attached: AttachedFile;
      if (
        strokes.length > 0 &&
        (currentSrc.startsWith('xdt-image://') || currentSrc.startsWith('cindy-media://'))
      ) {
        // 带笔迹 + 会话缓存源(本会话历史图):零复制——直接**引用共享**原图,
        // 矢量笔迹随附件;烧录在发送消息时统一物化。cacheUrlShared 保证从
        // 托盘移除附件时不会误删历史消息仍在用的原图文件。
        // size/ext 在此为草稿期近似值(缓存文件名带扩展名,ext 推导通常准确;
        // size 未知记 0,托盘缩略图不展示大小)——发送物化时由
        // materializeAnnotatedAttachmentsForSend 更新为烧录图的准确值。
        const ext = extractExt(currentSrc) || '.png';
        const name = `annotated-${Date.now()}${ext}`;
        attached = {
          id: crypto.randomUUID(),
          name,
          path: `clipboard://lightbox-annotated-${Date.now()}`,
          ext,
          size: 0,
          category: 'image',
          mimeType: getMimeType(ext, 'image'),
          url: currentSrc,
          originalName: name,
          cacheUrlShared: true,
          annotationStrokes: strokes.map((stroke) => ({ points: [...stroke.points] })),
        };
      } else {
        // 缓存店不原生支持的格式:renderer 经 canvas 光栅化为 PNG 再入缓存
        // ——发送的是光栅化副本,与"模型只认位图"的语义一致;笔迹(若有)
        // 随附件惰性保存。本地源/data: 由 isDirectCacheable 预判;http/remote
        // 源 URL 无法预判 MIME,走 direct 失败后降级到这里。
        const rasterizeToAttachment = async (): Promise<AttachedFile> => {
          const source = await loadImageSourceBase64(currentSrc);
          const { blob, mimeType } = await burnInAnnotations(source, [], 'image/png');
          const name = `image-${Date.now()}.png`;
          const cached = await window.electronAPI.cacheImageFromBuffer({
            sessionId: chatSessionId,
            buffer: new Uint8Array(await blob.arrayBuffer()),
            mimeType,
            suggestedName: name,
          });
          return {
            id: crypto.randomUUID(),
            name,
            path: `clipboard://lightbox-send-${Date.now()}`,
            ext: '.png',
            size: blob.size,
            category: 'image',
            mimeType,
            url: cached.url,
            originalName: name,
            ...(strokes.length > 0
              ? {
                  annotationStrokes: strokes.map((stroke) => ({
                    points: [...stroke.points],
                  })),
                }
              : {}),
          };
        };
        if (!isDirectCacheable(currentSrc)) {
          attached = await rasterizeToAttachment();
        } else {
          // 其余源(xdt-file 四位图 / http / remote-media / base64 data:)或无
          // 笔迹:main 复制一份进会话缓存,附件私有(所有权隔离与既有行为一致)。
          try {
            const meta = await window.electronAPI.cacheMediaForSession({
              url: currentSrc,
              sessionId: chatSessionId,
            });
            attached = {
              id: crypto.randomUUID(),
              name: meta.name,
              // 与剪贴板粘贴的 `clipboard://paste-*` 同型:图片附件以 url 为准,
              // path 只是占位标识来源。
              path: `clipboard://lightbox-send-${Date.now()}`,
              ext: meta.ext,
              size: meta.size,
              category: 'image',
              mimeType: meta.mimeType,
              url: meta.url,
              originalName: meta.name,
              ...(strokes.length > 0
                ? {
                    annotationStrokes: strokes.map((stroke) => ({
                      points: [...stroke.points],
                    })),
                  }
                : {}),
            };
          } catch (err) {
            // http/remote 源的 MIME 只有读到字节后才知道:缓存店拒收的格式
            // (svg/bmp/ico 等,INVALID_PARAMS)降级光栅化 PNG,按钮不该
            // "可见却必失败"(review P2)。其它错误(网络/超限)原样上抛。
            if (extractIpcError(err)?.code !== 'INVALID_PARAMS') throw err;
            attached = await rasterizeToAttachment();
          }
        }
      }
      // 历史标注图的原图已丢失、当前显示的是烧录图:底图本身带红线,转发后仍是
      // 标注图(模型照常收到标注说明)。
      if (
        currentItem.annotationSourceUrl &&
        currentItem.annotationStrokes?.length &&
        failedAnnotationSources.has(currentItem.annotationSourceUrl)
      ) {
        attached = { ...attached, baseAnnotated: true };
      }
      const existing = getDraft(chatSessionId);
      saveDraft(
        chatSessionId,
        {
          text: existing?.text ?? null,
          attachments: [...(existing?.attachments ?? []), attached],
          quotes: existing?.quotes ?? [],
          browserComments: existing?.browserComments ?? [],
        },
        { preserveRemoteOptimisticRecovery: true },
      );
      toast.success(t('chat.media.sentToChat'));
      afterSave();
    } catch (err) {
      toast.error(extractIpcError(err)?.message ?? t('chat.media.sendToChatFailed'));
    }
  }

  /**
   * 编辑模式出口:把当前笔迹(可能为空——用户撤光了之前的编辑)交回调用方
   * 更新托盘附件。惰性烧录:这里不产位图,发送消息时统一物化。
   */
  async function handleAnnotationSave(afterSave = handleClose): Promise<void> {
    if (!annotationEdit) return;
    try {
      await annotationEdit.onSave({
        strokes: strokesRef.current.map((stroke) => ({ points: [...stroke.points] })),
      });
      afterSave();
    } catch (err) {
      toast.error(extractIpcError(err)?.message ?? t('chat.media.annotateSaveFailed'));
    }
  }

  // 遮罩颜色走统一 token，不再按 Light / Dark 分支判断。
  const overlay = (
    // FocusScope(trapped+loop):键盘打开后焦点进入弹窗并圈禁在内,Tab 不再
    // 穿过被遮挡的聊天控件。挂载焦点给 overlay 根(tabIndex=-1 由 FocusScope
    // 合入,全局 outline:none 保证不闪全屏焦点框):Enter 不触发任何动作,
    // Tab 依次到达工具栏/翻页按钮;卸载时 FocusScope 默认把焦点还给打开前
    // 的元素(ChatImageView 键盘路径 = 预览触发器,与 onClose 里的显式恢复
    // 指向同一元素)。
    <FocusScope
      onUnmountAutoFocus={restorePreviewFocus}
      asChild
      trapped
      loop
      onMountAutoFocus={(event) => {
        event.preventDefault();
        overlayRef.current?.focus();
      }}
    >
    {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 全屏 overlay 的键盘关闭由全局 Escape 处理；点击关闭是 lightbox 本身的交互。 */}
    <div
      ref={overlayRef}
      data-lightbox-layer
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'var(--surface)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'opacity 200ms ease',
        opacity: isVisible ? 1 : 0,
        cursor: 'default',
        // 放大后的图片可能超出视口,裁掉溢出部分避免出现滚动条。
        overflow: 'hidden',
      }}
      onClick={(e) => {
        // 右键菜单刚关闭时，吞掉同一次手势带来的 overlay click。
        if (performance.now() - lastMenuCloseAt.current < 150) return;
        // 标注模式中背景点击不关闭,防误触丢笔迹;放弃走 X 按钮或 Esc。
        if (isAnnotating) return;
        // 拖拽平移松手落在背景上时,同一手势的 click 不能顺带关闭。
        if (dragMovedRef.current) {
          dragMovedRef.current = false;
          return;
        }
        // 只有点在黑色背景上才关闭;点在图片(或其它子元素)上不关,给双击缩放让路。
        if (e.target !== e.currentTarget) return;
        handleClose();
      }}
    >
        <PreviewHeader
          name={filename ?? previewSourceName(currentSrc, t('attachmentPreview.image'))}
          detail={
            currentNaturalSize ? `${currentNaturalSize.w} × ${currentNaturalSize.h}` : undefined
          }
          onClose={() => {
            void requestClose();
          }}
          onSave={canSaveAs ? handleSaveAs : undefined}
          onMenuClose={() => {
            lastMenuCloseAt.current = performance.now();
          }}
          menu={
            <>
              {canCopy ? (
                <DropdownMenuItem onClick={handleCopyImage}>
                  <Copy className="mr-2 h-4 w-4" />
                  {t('chat.media.copyImage')}
                </DropdownMenuItem>
              ) : null}
              {canOpenWith ? (
                <DropdownMenuItem onClick={handleOpenWithApp}>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  {t('chat.media.openWithApp')}
                </DropdownMenuItem>
              ) : null}
              {canOpenInBrowser ? (
                <DropdownMenuItem onClick={handleOpenInBrowser}>
                  <Globe className="mr-2 h-4 w-4" />
                  {t('chat.media.openInBrowser')}
                </DropdownMenuItem>
              ) : null}
              {canSendToChat ? (
                <DropdownMenuItem onClick={() => void handleSendToChat()}>
                  <MessageSquarePlus className="mr-2 h-4 w-4" />
                  {t('chat.media.sendToChat')}
                </DropdownMenuItem>
              ) : null}
            </>
          }
        />
        {loadFailed === currentSrc ? (
          <div
            className="absolute z-[2] flex flex-col items-center gap-3 rounded-xl bg-[var(--surface)] p-6 text-[var(--text-secondary)]"
            role="status"
          >
            <p>{t('chat.media.imageMissing')}</p>
            <button
              type="button"
              className="rounded-full border border-[var(--border-default)] px-4 py-2 text-sm"
              onClick={() => {
                setLoadFailed(null);
                setRetryVersion((value) => value + 1);
              }}
            >
              {t('attachmentPreview.retry')}
            </button>
          </div>
        ) : null}
        {/* 图片 + 标注层的公共 transform 容器:缩放/平移作用在容器上,SVG 笔迹
          天然跟随图片。容器是 flex item,尺寸自适应贴合图片盒。 */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 容器接管缩放/平移/画笔手势;点击背景关闭由 overlay 处理。 */}
      <div
        style={{
          position: 'relative',
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          transformOrigin: 'center center',
          // 拖拽/连续滚轮期间关过渡,跟手;步进缩放(键盘/双击)时 80ms 平滑。
          transition: isDragging || isWheeling ? 'none' : 'transform 80ms ease-out',
          cursor: isAnnotating
            ? isDragging
              ? 'grabbing'
              : spaceHeld
                ? scale > 1
                  ? 'grab'
                  : 'default'
                : 'crosshair'
            : scale > 1
              ? isDragging
                ? 'grabbing'
                : 'grab'
              : 'default',
          // 标注模式下触屏 / 笔的拖动全部交给画笔,不触发浏览器滚动 / 缩放手势。
          touchAction: isAnnotating ? 'none' : undefined,
        }}
        onMouseDown={isAnnotating ? handleAnnotateMouseDown : handleImageMouseDown}
        onPointerDown={isAnnotating ? handleAnnotatePointerDown : undefined}
        onPointerMove={isAnnotating ? handleAnnotatePointerMove : undefined}
        onPointerUp={isAnnotating ? finishAnnotateStroke : undefined}
        onPointerCancel={isAnnotating ? cancelAnnotateStroke : undefined}
        onLostPointerCapture={isAnnotating ? finishAnnotateStroke : undefined}
        onDoubleClick={isAnnotating ? undefined : handleImageDoubleClick}
      >
        <img
            key={retryVersion}
            ref={imgRef}
          src={currentSrc}
          alt=""
          draggable={false}
          style={{
            display: 'block',
            // viewBox-only SVG 在 shrink-to-fit 容器中仅靠 max-* 会塌成 0×0；
            // onLoad 后写入 contain 结果，同时让标注层与真实图片盒严格同尺寸。
            width: fittedImageSize?.width,
            height: fittedImageSize?.height,
            maxWidth: 'calc(100vw - 80px)',
            maxHeight: 'calc(100vh - 160px)',
            objectFit: 'contain',
            userSelect: 'none',
          }}
          onLoad={(e) => {
              setLoadFailed(null);
              setNaturalSize({
              src: currentSrc,
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            });
          }}
          // 右键 context-menu 单独在下面处理。
          onContextMenu={(e) => {
            // 标注模式中不弹菜单(菜单项都作用于原图,与画笔态语义冲突)。
            if (!hasAnyAction || isAnnotating) return;
            e.preventDefault();
            e.stopPropagation();
            setMenuPos({ x: e.clientX, y: e.clientY });
          }}
          // image-local-cache F4：lightbox 只放大已知可用图片。底层文件消失时
          // (例如缓存被清理)，关闭 lightbox 并提示；背后的缩略图卡片会显示自己的
          // ImageMissingPlaceholder，用户仍能看到上下文。
          // 例外:历史标注图的未烧录原图丢失而烧录图仍在时,退回烧录图、清空预置
          // 笔迹(在烧录图上叠新标),不关闭。
          onError={() => {
            const sourceUrl = currentItem.annotationSourceUrl;
            if (sourceUrl && currentSrc === sourceUrl && currentItem.src !== sourceUrl) {
              log.info('annotation source missing, falling back to burned image');
              setFailedAnnotationSources((prev) => new Set(prev).add(sourceUrl));
              baselineStrokesRef.current = EMPTY_STROKES;
              resetDraftStroke();
              setRedoStack([]);
              replaceStrokes([]);
              return;
            }
              setLoadFailed(currentSrc);
          }}
        />
        {/* 标注层:viewBox = 图片自然尺寸,归一化笔迹 × 自然尺寸 = path 坐标,
            与烧录坐标一致(所见即所得)。pointerEvents 关闭,事件由容器接管。 */}
        {currentNaturalSize && (strokes.length > 0 || isAnnotating) ? (
          <AnnotationStrokesSvg
            strokes={strokes}
            naturalWidth={currentNaturalSize.w}
            naturalHeight={currentNaturalSize.h}
            style={ANNOTATION_OVERLAY_STYLE}
            draftRefs={draftPathRefs}
          />
        ) : null}
      </div>
      {hasAnyAction ? (
        <DropdownMenu
          open={menuPos !== null}
          onOpenChange={(open) => {
            if (!open) {
              setMenuPos(null);
              lastMenuCloseAt.current = performance.now();
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              style={{
                position: 'fixed',
                left: menuPos?.x ?? 0,
                top: menuPos?.y ?? 0,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={2}
            // lightbox overlay 是 z-9999；默认 DropdownMenuContent(z-50) 会被遮住,
            // 这里提升到 overlay 上方。
            className="z-[10000]"
          >
            {canAnnotate && !isAnnotating ? (
              <DropdownMenuItem
                onClick={() => {
                  setIsAnnotating(true);
                  setMenuPos(null);
                }}
              >
                <Pen className="mr-2 h-4 w-4" />
                {t('chat.media.annotate')}
              </DropdownMenuItem>
            ) : null}
            {canCopy ? (
              <DropdownMenuItem onClick={handleCopyImage}>
                <Copy className="mr-2 h-4 w-4" />
                {t('chat.media.copyImage')}
              </DropdownMenuItem>
            ) : null}
            {canReveal ? (
              <DropdownMenuItem onClick={handleRevealInFolder}>
                <FolderOpen className="mr-2 h-4 w-4" />
                {t('chat.media.revealImage')}
              </DropdownMenuItem>
            ) : null}
            {canRevealRemote ? (
              <DropdownMenuItem onClick={handleRevealRemote}>
                <FolderOpen className="mr-2 h-4 w-4" />
                {t('chat.media.revealImageSidebar')}
              </DropdownMenuItem>
            ) : null}
            {canOpenInBrowser ? (
              <DropdownMenuItem onClick={handleOpenInBrowser}>
                <Globe className="mr-2 h-4 w-4" />
                {t('chat.media.openInBrowser')}
              </DropdownMenuItem>
            ) : null}
            {canOpenWith ? (
              <DropdownMenuItem onClick={handleOpenWithApp}>
                <ExternalLink className="mr-2 h-4 w-4" />
                {t('chat.media.openWithApp')}
              </DropdownMenuItem>
            ) : null}
            {canSaveAs ? (
              <DropdownMenuItem onClick={handleSaveAs}>
                <Download className="mr-2 h-4 w-4" />
                {t('chat.media.saveAs')}
              </DropdownMenuItem>
            ) : null}
            {canSendToChat ? (
              <DropdownMenuItem onClick={() => void handleSendToChat()}>
                <MessageSquarePlus className="mr-2 h-4 w-4" />
                {t('chat.media.sendToChat')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
        <PreviewFooter>
          <LightboxToolbarButton
            label={t('chat.mermaidLightbox.zoomOut')}
            disabled={scale <= IMAGE_MIN_SCALE}
            onClick={() => zoomBy(1 / LIGHTBOX_ZOOM_STEP)}
          >
            <Minus className="h-4 w-4" />
          </LightboxToolbarButton>
          <DropdownMenu
            onOpenChange={(open) => {
              if (!open) lastMenuCloseAt.current = performance.now();
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="min-w-16 rounded-full px-3 py-2 text-xs tabular-nums hover:bg-[var(--surface-hover)]"
              >
                {Math.round(
                  scale *
                    (fittedImageSize && currentNaturalSize
                      ? fittedImageSize.width / currentNaturalSize.w
                      : 1) *
                    100,
                )}
                %
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="z-[10002]">
              <DropdownMenuItem onClick={resetViewport}>
                {t('attachmentPreview.fit')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  if (fittedImageSize && currentNaturalSize)
                    applyViewport({
                      scale: Math.max(1, currentNaturalSize.w / fittedImageSize.width),
                      tx: 0,
                      ty: 0,
                    });
                }}
              >
                {t('attachmentPreview.actualSize')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <LightboxToolbarButton
            label={t('chat.mermaidLightbox.zoomIn')}
            disabled={scale >= LIGHTBOX_MAX_SCALE}
            onClick={() => zoomBy(LIGHTBOX_ZOOM_STEP)}
          >
            <Plus className="h-4 w-4" />
          </LightboxToolbarButton>
          <LightboxToolbarButton label={t('attachmentPreview.fit')}
          onClick={resetViewport}>
            <Maximize className="h-4 w-4" />
          </LightboxToolbarButton>
          <div className="mx-2 h-5 w-px bg-[var(--border-default)]" />
          {isAnnotating ? (
            <>
          <LightboxToolbarButton
            onClick={() => void discardAnnotation()}
            label={t('chat.media.annotateDiscard')}
            keepPointerFocus
          >
            <X className="h-4 w-4" />
          </LightboxToolbarButton>
          <LightboxToolbarButton
            onClick={undoLastStroke}
            label={t('chat.media.annotateUndo')}
            disabled={strokes.length === 0}
            keepPointerFocus
          >
            <Undo2 className="h-4 w-4" />
          </LightboxToolbarButton>
          <LightboxToolbarButton
            onClick={redoStroke}
            label={t('chat.media.annotateRedo')}
            disabled={!canRedo}
            keepPointerFocus
          >
            <Redo2 className="h-4 w-4" />
          </LightboxToolbarButton>
          <LightboxToolbarButton
              onClick={() => void (annotationEdit ? handleAnnotationSave() : handleSendToChat())}
              label={t(annotationEdit ? 'chat.media.annotateSave' : 'chat.media.sendToChat')}
              keepPointerFocus
            >
              <Check className="h-4 w-4" />
            </LightboxToolbarButton>
            </>
          ) : (
            <>
              {canAnnotate ? (
                <LightboxToolbarButton
                  onClick={() => setIsAnnotating(true)}
                  label={t('chat.media.annotate')}
                >
                  <Pen className="h-4 w-4" />
                </LightboxToolbarButton>
              ) : null}
              {canSendToChat ? (
                <LightboxToolbarButton
                  onClick={() => void handleSendToChat()}
                  label={t('chat.media.sendToChat')}
                >
                  <MessageSquarePlus className="h-4 w-4" />
                </LightboxToolbarButton>
              ) : null}
            </>
          )}
      {hasMultiple && !isAnnotating ? (
        <>
          <div className="mx-2 h-5 w-px bg-[var(--border-default)]" />
              <LightboxToolbarButton
                label={t('chat.media.prevImage')}
                disabled={index === 0}
                onClick={() =>
                  setIndex((value) => previewAdjacentIndex(value, -1, galleryItems.length))}
          >
            <ChevronLeft className="h-4 w-4" />
          </LightboxToolbarButton>
              <DropdownMenu
                onOpenChange={(open) => {
                  if (!open) lastMenuCloseAt.current = performance.now();
                }}
              >
                <DropdownMenuTrigger asChild>
          <button
            type="button"
                    className="rounded-full px-3 py-2 text-xs tabular-nums hover:bg-[var(--surface-hover)]"
                  >
            {index + 1} / {galleryItems.length}
          </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="z-[10002] max-h-72 overflow-auto">
                  {galleryItems.map((item, itemIndex) => (
                    <DropdownMenuItem
                      key={item.galleryId ?? `${itemIndex}:${item.src}`}
                      onClick={() => setIndex(itemIndex)}
                    >
                      {itemIndex + 1}. {previewSourceName(item.src, t('attachmentPreview.image'))}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <LightboxToolbarButton
                label={t('chat.media.nextImage')}
                disabled={index === galleryItems.length - 1}
                onClick={() =>
                  setIndex((value) => previewAdjacentIndex(value, 1, galleryItems.length))
                }
              >
                <ChevronRight className="h-4 w-4" />
              </LightboxToolbarButton>
        </>
      ) : null}
        </PreviewFooter>
      </div>
    </FocusScope>
  );

  return createPortal(overlay, document.body);
}
