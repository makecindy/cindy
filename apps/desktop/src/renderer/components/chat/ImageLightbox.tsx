/**
 * ImageLightbox
 * ---------------------------------------------------------------------------
 * 通过 React Portal 渲染的全屏图片 lightbox。
 *
 * - 遮罩：使用 `--overlay-lightbox` 主题 token，保持 lightbox 遮罩语义一致。
 * - 图片：`object-fit: contain`，四周保留 40px 安全边距。
 * - 缩放/平移(手势数学共用 `lightboxGestures`,与 MermaidLightbox 同一套):
 *   - 滚轮 / 触控板双指捏合(macOS、Windows 精密触摸板的 pinch 都由 Chromium
 *     合成为带 ctrlKey 的 wheel 事件)/ Ctrl(⌘)+滚轮 → 以光标为焦点缩放。
 *     普通滚轮不区分修饰键也直接缩放(Windows 看图器惯例,鼠标用户单手可缩放)。
 *   - 双击图片:1x ↔ 2x 切换(以双击点为焦点)。
 *   - 放大后左键拖拽平移;松手时若拖动超过阈值,该次 click 不触发关闭。
 *   - 键盘 +/- 步进缩放,0 重置。翻页(←/→ 或箭头按钮)时视口自动重置。
 *   - 缩放范围 1x(适配窗口)~ 8x,图片不缩到比适配尺寸更小。
 * - 关闭：点击黑色背景或按 Escape 关闭。点击图片本身**不再**关闭(为双击缩放
 *   让路,也符合常见图片查看器习惯;旧行为是点图片也关闭)。
 * - 媒体动作(对齐手机版 lightbox 的功能集,底部胶囊操作栏 + 右键菜单双入口):
 *   复制图片 / 打开所在目录(右键) / 用默认应用打开 / 另存为 / 发送到对话。
 *   可用性按 src scheme 分层,见 `mediaActionCapabilities`:本地源
 *   (xdt-image:// / xdt-file://)全量;http(s):// 与 data:image 只有
 *   另存为 + 发送到对话(main 侧取字节);cindy-remote-media://(远程会话)与
 *   其它 scheme 一律只读预览。
 * - 发送到对话:经 `media:cache-for-session` 为当前会话复制一份新缓存,再合入
 *   composerDraftStore(与手机版语义一致——加入输入框附件托盘,不直接发消息)。
 *   当前会话 id 来自 ChatSessionFileContext(portal 不断 context 链);聊天流外
 *   复用本组件(文件浏览器 / 输入框预览)拿到默认值 undefined,不显示该动作。
 * - 右键：菜单关闭后的同一次背景点击不能顺带关闭 lightbox,见 `lastMenuCloseAt`。
 * - 动画：200ms 透明度淡入淡出。
 * - 滚动锁定：打开期间给 `[data-scroll-container]` 设置 `overflowY: hidden`。
 * - 关闭按钮：按设计不显示 X 关闭按钮。
 * - 会话画廊：`enableGallery` 开启后，可用 ←/→ 或屏幕箭头在会话图片间翻页，并显示
 *   “n / 总数”计数。列表优先来自 `ImageGalleryContext`(MessageStream 下发的全量
 *   会话图片)，否则退回扫描 DOM 中的 `[data-gallery-src]`。起始下标由被点击元素的
 *   `data-gallery-active` 定位，细节见 `collectGallery` / `resolveStartIndexInFull`。
 */

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
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
  Undo2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
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
  ANNOTATION_OUTLINE_COLOR,
  ANNOTATION_STROKE_COLOR,
  annotationStrokeWidth,
  normalizePoint,
  shouldAppendPoint,
  strokeToSvgPath,
  type AnnotationStroke,
} from './lightboxAnnotations';
import { getDraft, saveDraft } from '@/lib/composerDraftStore';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { useChatSessionFile } from './ChatSessionFileContext';
import {
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_WHEEL_IDLE_MS,
  LIGHTBOX_ZOOM_STEP,
  clampScale,
  type LightboxViewport,
  wheelZoomFactor,
  zoomAtPoint,
} from './lightboxGestures';
import { ImageGalleryContext, type GalleryImage } from './ImageGalleryContext';
import { containImageSize } from './imageDisplaySize';

/** 图片不允许缩得比"适配窗口"更小,所以下限是 1 而不是共享常量的 0.2。 */
const IMAGE_MIN_SCALE = 1;
/** 双击放大的目标倍率(再次双击回到适配)。 */
const IMAGE_DOUBLE_CLICK_SCALE = 2;
/** 拖拽平移的位移阈值(px):超过则视为拖拽手势,松手后的 click 不关闭 lightbox。 */
const DRAG_CLICK_SUPPRESS_PX = 4;
/** 视口初始态:适配窗口、无平移。 */
const FIT_VIEWPORT: LightboxViewport = { scale: 1, tx: 0, ty: 0 };

interface ImageLightboxProps {
  src: string;
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
  return localFilePath !== null && DIRECT_CACHEABLE_EXTS.has(extractExt(localFilePath).toLowerCase());
}

/** 左右翻页圆形按钮的内联样式。lightbox overlay 不走 Tailwind,这里同样用内联。 */
function navButtonStyle(side: 'left' | 'right'): React.CSSProperties {
  return {
    position: 'fixed',
    top: '50%',
    [side]: 24,
    transform: 'translateY(-50%)',
    width: 48,
    height: 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '9999px',
    border: 'none',
    background: 'rgba(0,0,0,0.45)',
    color: '#fff',
    cursor: 'pointer',
    zIndex: 10000,
  };
}

/**
 * 顶部居中 "n / 总数" 计数器的内联样式。原在底部,底部让位给媒体操作栏后移到
 * 顶部居中——与手机版 lightbox 的页码位置一致。
 */
const counterStyle: React.CSSProperties = {
  position: 'fixed',
  top: 24,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '4px 12px',
  borderRadius: '9999px',
  background: 'rgba(0,0,0,0.45)',
  color: '#fff',
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
  userSelect: 'none',
  zIndex: 10000,
};

/**
 * 收集当前聊天滚动区里所有可翻阅图片,按 DOM 顺序(即视觉 / 时间顺序)返回。
 * 数据源是各图片组件 `<img>` 上的 `data-gallery-src` 属性。优先限定在
 * [data-scroll-container](聊天消息区,和 scroll-lock 同一个)内,避免抓到
 * 其它面板里的图。
 *
 * `activeIndex` 是被点击那张图在列表里的位置:点击时调用方会在被点的 `<img>`
 * 上打一个临时 `data-gallery-active="1"` 标记,这里据此精确定位起始图。这样
 * 即便同一 URL 在会话里非相邻地出现多次(用户重复上传 / 工具返回同一缓存图),
 * 也能从用户真正点的那张开始,而不是按 URL 搜到的第一张。找不到标记时返回 -1,
 * 由调用方退回按 src 搜索。注意:这里**不做去重**,让列表下标和 DOM 元素一一
 * 对应,activeIndex 才准。
 */
function collectGallery(): { items: GalleryImage[]; activeIndex: number } {
  const root: ParentNode =
    document.querySelector('[data-scroll-container]') ?? document;
  const els = Array.from(
    root.querySelectorAll<HTMLElement>('[data-gallery-src]'),
  );
  const items: GalleryImage[] = [];
  let activeIndex = -1;
  els.forEach((el, i) => {
    items.push({ src: el.dataset.gallerySrc ?? '' });
    if (el.dataset.galleryActive === '1') activeIndex = i;
  });
  return { items, activeIndex };
}

/** 清掉所有遗留的 `data-gallery-active` 临时标记(lightbox 读取起始下标后调用)。 */
function clearGalleryActiveMarks(): void {
  document
    .querySelectorAll<HTMLElement>('[data-gallery-active]')
    .forEach((el) => {
      delete el.dataset.galleryActive;
    });
}

/**
 * 在「会话全量列表 `full`」里定位用户点的那张图的下标。
 *
 * 渲染窗口是全量列表的**末尾连续段**,所以 DOM 里已加载的 gallery 图就是 full 的
 * 尾巴。据此可做精确的位置映射:被点图在已加载段里的序号 `k`(由 data-gallery-active
 * 标记定位)+「full 长度 − 已加载数」= 它在 full 里的精确位置 —— 即便同一 URL 在
 * 会话里非相邻出现多次,也能落到用户真正点的那张(修 greptile P1)。
 *
 * 映射结果再用 src 校验一次:`full[mapped] === src` 才采用;不一致(列表与 DOM 口径
 * 偶有偏差,如失败图被换成占位符)则退回按 src 搜索的首个匹配,保证不会定位到错图。
 */
function resolveStartIndexInFull(full: readonly GalleryImage[], src: string): number {
  const { items: domItems, activeIndex } = collectGallery();
  const M = domItems.length;
  const T = full.length;
  if (activeIndex >= 0 && M > 0 && T >= M) {
    const mapped = T - M + activeIndex;
    if (full[mapped]?.src === src) return mapped;
  }
  const bySrc = full.findIndex((g) => g.src === src);
  return bySrc >= 0 ? bySrc : 0;
}

export function ImageLightbox({
  src,
  onClose,
  enableGallery = false,
  galleryId,
  sessionId: sessionIdProp,
  annotationEdit,
  initialStrokes,
  autoAnnotate = false,
}: ImageLightboxProps) {
  const { t } = useTranslation();
  // 会话全量图片列表(MessageStream 下发);非聊天场景无 Provider 时为 null。
  const sessionImages = useContext(ImageGalleryContext);
  // 当前会话 id(发送到对话用):prop 优先(文件浏览器等 provider 外宿主),
  // 否则取聊天流 context;都没有则为 undefined → 不显示该动作。
  const { sessionId: contextSessionId, workingDir } = useChatSessionFile();
  const chatSessionId = sessionIdProp ?? contextSessionId;
  const sidebarTargetSessionId = useSidebarTargetSessionId(chatSessionId);
  const [isVisible, setIsVisible] = useState(false);
  // 会话内翻图列表 + 起始下标。只在挂载时算一次,翻页只在已知列表内移动下标。
  // enableGallery 关时退化成单张 [src]。开启时:
  //   1) 优先用 context 的全量列表(覆盖整个会话,含渲染窗口外的早期图),
  //      起始下标用位置映射精确定位用户点的那张;
  //   2) 没有 context(理论上不该发生)才退回扫 DOM —— 只覆盖已加载部分。
  // 关键守卫:只有当 `src` 确实在候选列表里时才进画廊。否则(例如 Markdown /
  // 本地文件**链接**复用同一个 lightbox 打开,但它们不是画廊图片)退回单张,
  // 不然会套用会话画廊、起始落到不相干的第 0 张图。
  const [gallery] = useState<{ items: readonly GalleryImage[]; start: number }>(() => {
    if (!enableGallery) return { items: [{ src }], start: 0 };
    const keyedIndex =
      galleryId && sessionImages
        ? sessionImages.findIndex((item) => item.galleryId === galleryId)
        : -1;
    if (sessionImages && keyedIndex >= 0) {
      return { items: sessionImages, start: keyedIndex };
    }
    if (sessionImages?.some((g) => g.src === src)) {
      return { items: sessionImages, start: resolveStartIndexInFull(sessionImages, src) };
    }
    const { items, activeIndex } = collectGallery();
    if (items.some((g) => g.src === src)) {
      const bySrc = items.findIndex((g) => g.src === src);
      const start = activeIndex >= 0 ? activeIndex : bySrc;
      return { items, start };
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
  const currentSrc =
    currentItem.annotationSourceUrl && currentItem.annotationStrokes?.length
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
  const [strokes, setStrokes] = useState<AnnotationStroke[]>(() => [
    ...baselineStrokesRef.current,
  ]);
  const [draftStroke, setDraftStroke] = useState<AnnotationStroke | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
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
        viewportSize.height - 80,
      )
    : null;

  const undoLastStroke = useCallback(() => {
    setStrokes((s) => s.slice(0, -1));
  }, []);

  /**
   * 放弃标注:恢复到打开时的笔迹(编辑模式=上次保存的;发送模式=空)并退出
   * 标注模式。X 按钮与标注中的 Esc 都走这里。
   *
   * autoAnnotate 宿主(Mermaid/表格/公式的「标注」入口)整个 lightbox 就是
   * 为标注而开的临时光栅化图,放弃标注后留在图片界面没有意义——直接关闭
   * 整个 lightbox 回到原界面。
   */
  const discardAnnotation = useCallback(() => {
    if (autoAnnotate) {
      handleClose();
      return;
    }
    setStrokes([...baselineStrokesRef.current]);
    setDraftStroke(null);
    setIsDrawing(false);
    setIsAnnotating(false);
  }, [autoAnnotate, handleClose]);

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
    baselineStrokesRef.current = galleryItems[index]?.annotationStrokes ?? [];
    setStrokes([...baselineStrokesRef.current]);
    setDraftStroke(null);
    setIsDrawing(false);
    setNaturalSize(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: galleryItems 挂载时固定。
  }, [index, resetViewport]);

  // 滚轮缩放。native listener + passive:false 才能 preventDefault,阻止事件穿透
  // 到底下的聊天区,也阻止 Chromium 对 ctrl+wheel 的页面级缩放。
  // 不区分修饰键:普通滚轮、Ctrl(⌘)+滚轮、触控板 pinch(Chromium 把 macOS /
  // Windows 精密触摸板的捏合合成为 ctrlKey=true 的 wheel)统一以光标为焦点缩放。
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();
      if (e.deltaY === 0) return;
      const current = viewportRef.current;
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

  /** 放大状态下按住图片开始拖拽平移。 */
  function handleImageMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    // preventDefault 同时抑制 <img> 的原生拖拽 ghost 与文字选区。
    e.preventDefault();
    if (viewportRef.current.scale <= 1) return;
    dragMovedRef.current = false;
    setIsDragging(true);
    const current = viewportRef.current;
    dragStartRef.current = { x: e.clientX, y: e.clientY, tx: current.tx, ty: current.ty };
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

  // 进行中笔迹的事实源:ref(事件 handler 同步读写),state 仅驱动 SVG 渲染。
  // ⚠️ 提交笔迹绝不能写在 setState updater 内部——updater 必须是纯函数,
  // StrictMode(dev)会双调 updater,曾导致每笔被 push 两次:两条笔迹完全
  // 重叠肉眼不可见,表现为"撤销要点两次才生效"。
  const draftStrokeRef = useRef<AnnotationStroke | null>(null);

  /** 标注模式画笔:mousedown 起笔(替代平移拖拽)。 */
  function handleAnnotateMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const point = normalizePoint(e.clientX, e.clientY, rect);
    if (!point) return;
    draftStrokeRef.current = { points: [point] };
    setDraftStroke(draftStrokeRef.current);
    setIsDrawing(true);
  }

  // 画笔进行中:move/up 绑 window(移出图片仍能收尾),仅 isDrawing 时挂载。
  useEffect(() => {
    if (!isDrawing) return;
    const onMove = (e: globalThis.MouseEvent) => {
      const draft = draftStrokeRef.current;
      if (!draft) return;
      const rect = imgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const point = normalizePoint(e.clientX, e.clientY, rect);
      if (!point || !shouldAppendPoint(draft, point)) return;
      draftStrokeRef.current = { points: [...draft.points, point] };
      setDraftStroke(draftStrokeRef.current);
    };
    const onUp = () => {
      const draft = draftStrokeRef.current;
      draftStrokeRef.current = null;
      setIsDrawing(false);
      setDraftStroke(null);
      if (draft && draft.points.length > 0) {
        setStrokes((s) => [...s, draft]);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDrawing]);

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

  // 起始下标已在 useState 初始化时从 data-gallery-active 读出,标记使命完成,
  // 挂载后立即清掉,避免污染下一次打开(否则下次扫描会读到上次的残留标记)。
  useEffect(() => {
    clearGalleryActiveMarks();
  }, []);

  // Esc 关闭；+/-/0 缩放;开启会话画廊时用 ←/→ 翻图。
  // biome-ignore lint/correctness/useExhaustiveDependencies: galleryItems 在挂载时固定；这里只订阅一次全局键盘事件，避免反复绑定 DOM listener。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (performance.now() - lastMenuCloseAt.current < 150) return;
        // 标注模式中 Esc = 放弃标注(清笔迹退出),再按一次才关 lightbox。
        if (isAnnotatingRef.current) {
          discardAnnotation();
          return;
        }
        handleClose();
        return;
      }
      // 标注模式撤销上一笔(在修饰键放行守卫之前拦截)。
      if (
        isAnnotatingRef.current &&
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        (e.key === 'z' || e.key === 'Z')
      ) {
        e.preventDefault();
        undoLastStroke();
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
        setIndex((i) => (i + 1) % galleryItems.length);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIndex((i) => (i - 1 + galleryItems.length) % galleryItems.length);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // handleClose / gallery 都在组件生命周期内稳定(onClose 是调用方传的稳定
    // setState dispatch;gallery 由 useState 初始化后不再变)。只在挂载/卸载
    // 订阅一次是有意为之——每次渲染重订阅会带来无谓的 DOM listener 抖动。
  }, []);

  // 打开期间锁住聊天滚动容器。
  useEffect(() => {
    const container = document.querySelector(
      '[data-scroll-container]',
    ) as HTMLElement | null;
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
    canCopy || canReveal || canRevealRemote || canOpenWith || canSaveAs || canSendToChat || canOpenInBrowser;

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
    // 有笔迹时复制"所见"(烧录合成图);data:/http/remote 源本机没有文件实体,
    // 同样走位图复制(字节层统一取字节)。canvas 输出统一 PNG——ClipboardItem
    // 仅接受 image/png。本地源无笔迹保持文件引用复制(可粘进 Finder)。
    const isLocalFileSource =
      currentSrc.startsWith('xdt-image://') ||
      currentSrc.startsWith('cindy-media://') ||
      xdtFileUrlToPath(currentSrc) !== null;
    if (strokesRef.current.length > 0 || !isLocalFileSource) {
      try {
        const { blob } = await materializeAnnotatedImage('image/png');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast.success(t('chat.media.imageCopied'));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('chat.media.copyFailed'));
      }
      return;
    }
    const res = await window.electronAPI.copyMediaToClipboard(legacyMediaIpcParams(currentSrc));
    if (res.success) {
      toast.success(t('chat.media.imageCopied'));
    } else {
      toast.error(res.error ?? t('chat.media.copyFailed'));
    }
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
  async function handleSendToChat(): Promise<void> {
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
      const existing = getDraft(chatSessionId);
      saveDraft(chatSessionId, {
        text: existing?.text ?? null,
        attachments: [...(existing?.attachments ?? []), attached],
        quotes: existing?.quotes ?? [],
        browserComments: existing?.browserComments ?? [],
      });
      toast.success(t('chat.media.sentToChat'));
      handleClose();
    } catch (err) {
      toast.error(extractIpcError(err)?.message ?? t('chat.media.sendToChatFailed'));
    }
  }

  /**
   * 编辑模式出口:把当前笔迹(可能为空——用户撤光了之前的编辑)交回调用方
   * 更新托盘附件。惰性烧录:这里不产位图,发送消息时统一物化。
   */
  async function handleAnnotationSave(): Promise<void> {
    if (!annotationEdit) return;
    try {
      await annotationEdit.onSave({
        strokes: strokesRef.current.map((stroke) => ({ points: [...stroke.points] })),
      });
      handleClose();
    } catch (err) {
      toast.error(extractIpcError(err)?.message ?? t('chat.media.annotateSaveFailed'));
    }
  }

  // 遮罩颜色走统一 token，不再按 Light / Dark 分支判断。
  const overlay = (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 全屏 overlay 的键盘关闭由全局 Escape 处理；点击关闭是 lightbox 本身的交互。
    <div
      ref={overlayRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'var(--overlay-lightbox)',
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
            ? 'crosshair'
            : scale > 1
              ? isDragging
                ? 'grabbing'
                : 'grab'
              : 'default',
        }}
        onMouseDown={isAnnotating ? handleAnnotateMouseDown : handleImageMouseDown}
        onDoubleClick={isAnnotating ? undefined : handleImageDoubleClick}
      >
        <img
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
            maxHeight: 'calc(100vh - 80px)',
            objectFit: 'contain',
            userSelect: 'none',
          }}
          onLoad={(e) => {
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
          onError={() => {
            toast.warning(t('chat.media.imageMissing'));
            handleClose();
          }}
        />
        {/* 标注层:viewBox = 图片自然尺寸,归一化笔迹 × 自然尺寸 = path 坐标,
            与烧录坐标一致(所见即所得)。pointerEvents 关闭,事件由容器接管。 */}
        {currentNaturalSize && (strokes.length > 0 || draftStroke) ? (
          <svg
            viewBox={`0 0 ${currentNaturalSize.w} ${currentNaturalSize.h}`}
            preserveAspectRatio="none"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
            }}
            aria-hidden
          >
            {[...strokes, ...(draftStroke ? [draftStroke] : [])].map((stroke, i) => {
              const d = strokeToSvgPath(stroke, currentNaturalSize.w, currentNaturalSize.h);
              if (!d) return null;
              const w = annotationStrokeWidth(currentNaturalSize.w, currentNaturalSize.h);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: 笔迹列表只增/尾删,index 稳定。
                <g key={i}>
                  <path
                    d={d}
                    fill="none"
                    stroke={ANNOTATION_OUTLINE_COLOR}
                    strokeWidth={Math.round(w * 1.8)}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d={d}
                    fill="none"
                    stroke={ANNOTATION_STROKE_COLOR}
                    strokeWidth={w}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
              );
            })}
          </svg>
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
              <DropdownMenuItem onClick={handleSendToChat}>
                <MessageSquarePlus className="mr-2 h-4 w-4" />
                {t('chat.media.sendToChat')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {/* 底部媒体操作栏(视觉复用 MermaidLightbox 的胶囊 toolbar)。点按不冒泡,
          否则会被 overlay 的 click-to-close 吞掉。标注模式下切换为画笔工具组。 */}
      {isAnnotating ? (
        // 标注模式:只有三个选择——放弃(X)/ 撤销上一笔 / 发送到聊天。
        // 标注的唯一出口是发送,没有"完成后保留笔迹"的中间态。
        <div
          className={cn(
            'fixed bottom-6 left-1/2 -translate-x-1/2 z-[10000]',
            'flex items-center gap-1 rounded-full',
            'border border-[var(--lightbox-toolbar-border)] bg-[var(--lightbox-toolbar-bg)] px-2 py-1',
            'backdrop-blur',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <LightboxToolbarButton onClick={discardAnnotation} label={t('chat.media.annotateDiscard')}>
            <X className="h-4 w-4" />
          </LightboxToolbarButton>
          <LightboxToolbarButton onClick={undoLastStroke} label={t('chat.media.annotateUndo')}>
            <Undo2 className="h-4 w-4" />
          </LightboxToolbarButton>
          <div className="mx-1 h-5 w-px bg-[var(--lightbox-toolbar-border)]" />
          {annotationEdit ? (
            <LightboxToolbarButton
              onClick={handleAnnotationSave}
              label={t('chat.media.annotateSave')}
            >
              <Check className="h-4 w-4" />
            </LightboxToolbarButton>
          ) : (
            <LightboxToolbarButton onClick={handleSendToChat} label={t('chat.media.sendToChat')}>
              <MessageSquarePlus className="h-4 w-4" />
            </LightboxToolbarButton>
          )}
        </div>
      ) : hasAnyAction || canAnnotate ? (
        <div
          className={cn(
            'fixed bottom-6 left-1/2 -translate-x-1/2 z-[10000]',
            'flex items-center gap-1 rounded-full',
            'border border-[var(--lightbox-toolbar-border)] bg-[var(--lightbox-toolbar-bg)] px-2 py-1',
            'backdrop-blur',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {canCopy ? (
            <LightboxToolbarButton onClick={handleCopyImage} label={t('chat.media.copyImage')}>
              <Copy className="h-4 w-4" />
            </LightboxToolbarButton>
          ) : null}
          {canOpenWith ? (
            <LightboxToolbarButton onClick={handleOpenWithApp} label={t('chat.media.openWithApp')}>
              <ExternalLink className="h-4 w-4" />
            </LightboxToolbarButton>
          ) : null}
          {canOpenInBrowser ? (
            <LightboxToolbarButton onClick={handleOpenInBrowser} label={t('chat.media.openInBrowser')}>
              <Globe className="h-4 w-4" />
            </LightboxToolbarButton>
          ) : null}
          {canSaveAs ? (
            <LightboxToolbarButton onClick={handleSaveAs} label={t('chat.media.saveAs')}>
              <Download className="h-4 w-4" />
            </LightboxToolbarButton>
          ) : null}
          {/* 标注与发送是一组:圈点的产物就是发到对话,分隔线右侧成组摆放。 */}
          {canAnnotate || canSendToChat ? (
            <>
              <div className="mx-1 h-5 w-px bg-[var(--lightbox-toolbar-border)]" />
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
                  onClick={handleSendToChat}
                  label={t('chat.media.sendToChat')}
                >
                  <MessageSquarePlus className="h-4 w-4" />
                </LightboxToolbarButton>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {/* 会话内翻图:左右箭头 + 计数。点按钮时 stopPropagation,否则会冒泡到
          overlay 的 onClick 把整个 lightbox 关掉。只有 >1 张才显示;标注中或
          标注模式中隐藏(翻页会清空笔迹,防误触)。 */}
      {hasMultiple && !isAnnotating ? (
        <>
          <button
            type="button"
            aria-label={t('chat.media.prevImage')}
            onClick={(e) => {
              e.stopPropagation();
              setIndex((i) => (i - 1 + galleryItems.length) % galleryItems.length);
            }}
            style={navButtonStyle('left')}
          >
            <ChevronLeft size={28} strokeWidth={2.5} />
          </button>
          <button
            type="button"
            aria-label={t('chat.media.nextImage')}
            onClick={(e) => {
              e.stopPropagation();
              setIndex((i) => (i + 1) % galleryItems.length);
            }}
            style={navButtonStyle('right')}
          >
            <ChevronRight size={28} strokeWidth={2.5} />
          </button>
          {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 计数器不是交互控件；onClick 只阻止冒泡关闭 lightbox。 */}
          <div style={counterStyle} onClick={(e) => e.stopPropagation()}>
            {index + 1} / {galleryItems.length}
          </div>
        </>
      ) : null}
    </div>
  );

  return createPortal(overlay, document.body);
}

/**
 * 底部操作栏的圆形图标按钮,样式与 MermaidLightbox 的 ToolbarButton 一致。
 * Tips 用应用统一的 Radix Tooltip(跨平台一致,原生 title 在 Electron 下延迟
 * 且样式不可控);lightbox overlay 是 z-9999,content 需抬到其上。
 */
function LightboxToolbarButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Tip text={label} contentClassName="z-[10001]">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={cn(
          'inline-flex h-7 w-7 items-center justify-center',
          'rounded-full text-[var(--lightbox-toolbar-fg)]',
          'hover:bg-[var(--lightbox-toolbar-hover-bg)] hover:text-[var(--lightbox-toolbar-fg-hover)]',
        )}
      >
        {children}
      </button>
    </Tip>
  );
}
