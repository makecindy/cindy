/**
 * ImageLightbox — IM 级全屏图片查看器。
 * ---------------------------------------------------------------------------
 * 点缩略图直接全屏黑底看图,交互对齐主流 IM:
 *   - 双指捏合绕焦点缩放(1x~4x);放大后单指平移(钳制在 contain 后的图片边界内)
 *   - 双击在 1x / 2.5x 间切换并落到点击点;1x 单击关闭
 *   - 1x 下竖直下滑跟手关闭(位移 + 背景渐隐),横滑翻会话内图片集
 *   - 放大后单指只平移;单击不关(双击缩回,或先回到 1x 再单击/下滑)
 *   - 捏合/平移期间 chrome 让位(不抢触摸),结束后恢复
 *   - chrome 极简:顶部关闭与多图页码,底部标注/发送/分享;关闭同时支持读屏返回
 * 手势判定全部走 imageLightboxModel.ts 纯函数;取件复用会话屏的队列 + 磁盘缓存
 * (onResolveRemoteMedia),点开时通常已被列表缩略图取过、秒出。
 * 仅图片走本组件;video / audio / 文件仍走 MessagePayloadModal。
 * lightbox 是常黑沉浸语境,黑白系颜色为刻意豁免(对齐桌面 docs/design-rules/cindy-design-system.md overlay/lightbox 语义豁免),不走主题 token。
 */
import { useNavigation } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { Text } from '@/components/AppText';
import { MessageSquarePlus, Pen, Share as ShareIcon, Undo2, X } from 'lucide-react-native';
import Svg, { Path } from 'react-native-svg';
import { fontWeight, iconSize, iconStroke, motionDuration, radius, typeScale } from '@/theme';
import { Gesture, GestureDetector, GestureHandlerRootView } from '@/platform/gestureHandler';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { MobileMessageGalleryImage } from '@/session/messageGallery';
import {
  isDesktopLocalMediaUrl,
  type MobileResolvedRemoteMedia,
  type ResolveRemoteMediaFn,
} from '@/session/remoteMedia';
import {
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
  lightboxPinchOrigin,
  LIGHTBOX_TAP_MAX_DISTANCE,
  nextDoubleTapScale,
  reclampLightboxPan,
  shouldCloseLightboxOnTap,
  shouldDismissLightbox,
} from '@/session/imageLightboxModel';
import {
  ANNOTATION_OUTLINE_COLOR,
  ANNOTATION_OUTLINE_WIDTH_RATIO,
  ANNOTATION_STROKE_COLOR,
  annotationBaseRect,
  annotationDisplayRect,
  annotationStrokeToSvgPath,
  annotationStrokeWidth,
  canAnnotateImageMime,
  normalizeAnnotationPoint,
  shouldAppendAnnotationPoint,
  type AnnotationStroke,
} from '@/session/imageAnnotationModel';

// 缩略图垫底**不**挂在取件态里:它要跨过 loading → ready 的边界继续垫住原图
// 下载那一段(见 lightboxImageLayers),挂进 loading 分支会在取件完成的瞬间
// 结构性丢失,把第二段空档裸露成纯黑。垫底地址单独存 previewMap。
type PageResolveState =
  | { status: 'loading' }
  | { status: 'ready'; media: MobileResolvedRemoteMedia }
  | { status: 'error' };

/** 宿主注入的底部操作(文件浏览器:复制路径/发送到会话);回调收当前活跃页。 */
export interface ImageLightboxAction {
  key: string;
  label: string;
  icon: React.ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
  onPress: (image: MobileMessageGalleryImage) => void;
}

/**
 * 圈点标注配置(可选)。提供时,可标注的页(位图 + 已有本地/直连字节)右下角
 * 出现画笔圆钮:进入标注模式后单指作画(红笔 + 白描边,与桌面版同视觉)、
 * 双指仍可缩放平移、可撤销;提交出口由宿主决定语义(聊天=发送到对话,
 * composer 托盘=保存替换附件)。烧录发生在宿主侧(onSubmit 之后),lightbox
 * 只产出矢量笔迹。
 */
export interface ImageLightboxAnnotationConfig {
  /** 提交文案(如「发送到对话」/「保存」)。 */
  submitLabel: string;
  /**
   * 非标注态是否显示独立的直发按钮(文案同 submitLabel,提交空笔迹 = 转发
   * 原图)。聊天场景 true(对齐桌面的一级「发送到对话」);composer 托盘场景
   * 不开(图已在托盘,直发无意义)。gif 等不可标注的图也能直发。
   */
  allowDirectSubmit?: boolean;
  /**
   * 提交:strokes 为当前全部笔迹(可为空,空的语义由宿主定——聊天=转发原图,
   * 托盘再编辑=撤光恢复原图)。resolve 后 lightbox 关闭;reject 时停留在标注
   * 模式(宿主自行提示错误)。
   */
  onSubmit: (
    image: MobileMessageGalleryImage,
    displayUri: string,
    strokes: AnnotationStroke[],
    context: { mimeType?: string },
  ) => void | Promise<void>;
  /**
   * 某页的既有笔迹(托盘带标注图再编辑):打开/翻页时叠加显示,进入标注模式
   * 可继续画或撤销。不提供 = 全部从空白开始。
   */
  initialStrokesFor?: (image: MobileMessageGalleryImage) => readonly AnnotationStroke[] | undefined;
}

export interface ImageLightboxProps {
  images: readonly MobileMessageGalleryImage[];
  initialUrl: string;
  onClose(): void;
  onResolveRemoteMedia?: ResolveRemoteMediaFn;
  /** 分享当前图(displayUri 为 file:// 或 http(s));由会话屏落地本地文件后唤起系统分享单。 */
  onShareImage?: (
    media: MobileMessageGalleryImage['payload']['media'],
    displayUri: string,
    mimeType?: string,
    /** 取件已知的对象字节数:分享落盘可据此跳过超预算的 LRU 写入。 */
    sizeBytes?: number,
  ) => void | Promise<void>;
  /**
   * 额外底部操作(可选)。提供时底部渲染成图标+文字工具栏(与文件预览页
   * 底栏同构,操作显式可见);不提供维持聊天原样(仅右下分享圆钮)。
   * 聊天调用方不传,此 prop 对聊天零影响。
   */
  extraActions?: readonly ImageLightboxAction[];
  /**
   * 文件预览顶栏(可选):完成 + 文件名/meta + 分享,与 Quick Look 预览页
   * 同构(深色沉浸变体)。开启时分享上移到顶栏,底部只剩 extraActions;
   * 顶部页码并入 meta 行。聊天调用方不传,维持无顶栏的极简 chrome。
   */
  showFileHeader?: boolean;
  /** 圈点标注(可选):见 {@link ImageLightboxAnnotationConfig}。 */
  annotation?: ImageLightboxAnnotationConfig;
}

// memo:父层(消息列表)在流式回复期间每 token 重渲染,props 全部引用稳定
// (images 已在父层做语义比对复用、回调均为 useCallback),查看器打开期间整棵
// 子树对流式更新免疫(rule 7)。
export const ImageLightbox = memo(function ImageLightbox({
  images,
  initialUrl,
  onClose,
  onResolveRemoteMedia,
  onShareImage,
  extraActions,
  showFileHeader,
  annotation,
}: ImageLightboxProps) {
  const { t } = useTranslation();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const urls = useMemo(() => images.map((image) => image.url), [images]);
  const [activeIndex, setActiveIndex] = useState(() => lightboxInitialIndex(urls, initialUrl));
  const [zoomed, setZoomed] = useState(false);
  /** 捏合/平移进行中 chrome 不接收触摸,避免底栏抢走双指。 */
  const [chromeInteractive, setChromeInteractive] = useState(true);
  const [resolveMap, setResolveMap] = useState<Record<string, PageResolveState>>({});
  /**
   * trimmed url → 列表缩略图地址(渐进出图的垫底层)。独立于 resolveMap:
   * 一旦拿到就长期有效,取件态怎么流转都不丢,直到原图 onLoad 才停止使用。
   */
  const [previewMap, setPreviewMap] = useState<Record<string, string>>({});
  /** 下滑拖动量(当前活跃页写入),驱动背景与 chrome 渐隐。 */
  const dismissY = useSharedValue(0);
  /** 捏合/平移期间把 chrome 透明度打到 0;与 dismissY 相乘。 */
  const chromeHidden = useSharedValue(0);
  const handleChromeBusy = useCallback((busy: boolean) => {
    setChromeInteractive(!busy);
  }, []);

  // ---- 圈点标注状态(仅活跃页;笔迹归一化存储,显示/烧录共用同一映射)----
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [annotationSubmitting, setAnnotationSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const sharingRef = useRef(false);
  const [sharing, setSharing] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [strokes, setStrokes] = useState<AnnotationStroke[]>([]);
  const [draftStroke, setDraftStroke] = useState<AnnotationStroke | null>(null);
  /** url → 图片自然尺寸(LightboxPage onLoad 上报;overlay 与坐标换算的基准)。 */
  const [naturalSizes, setNaturalSizes] = useState<Record<string, { width: number; height: number }>>({});
  const draftStrokeRef = useRef<AnnotationStroke | null>(null);
  const activeImageForDraw = images[activeIndex] ?? null;
  const activeNaturalSize = activeImageForDraw ? naturalSizes[activeImageForDraw.key] ?? null : null;

  const handleNaturalSize = useCallback((imageKey: string, size: { width: number; height: number }) => {
    setNaturalSizes((prev) => {
      const existing = prev[imageKey];
      if (existing && existing.width === size.width && existing.height === size.height) return prev;
      return { ...prev, [imageKey]: size };
    });
  }, []);

  // 打开/翻页时装载该页既有笔迹(托盘再编辑);标注模式中禁翻页,不会中途换页。
  // 依赖「活跃图 key」而非 images 数组引用:父层因附件上传落定 / 流式回复等
  // 原因重建图集(语义未变)时,不能把用户正在画的笔迹重置掉(review P1);
  // 真正换图(翻页 / 打开另一张)时 key 变化,照常重载。images 经 ref 读最新。
  const activeImageKeyForStrokes = images[activeIndex]?.key ?? null;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => {
    const image = imagesRef.current[activeIndex];
    const initial = image ? annotation?.initialStrokesFor?.(image) : undefined;
    setStrokes(initial ? [...initial] : []);
    draftStrokeRef.current = null;
    setDraftStroke(null);
    // annotation 语义上只在打开时取一次快照,翻页时按新页(key)重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, activeImageKeyForStrokes]);

  /** 画笔落点(容器坐标 + 当页 transform 状态,LightboxPage 手势经 runOnJS 上抛)。 */
  const handleDrawPoint = useCallback((
    phase: 'start' | 'move' | 'end',
    pointX: number,
    pointY: number,
    translateX: number,
    translateY: number,
    scale: number,
  ) => {
    if (submittingRef.current) return;
    if (phase === 'end') {
      const draft = draftStrokeRef.current;
      draftStrokeRef.current = null;
      setDraftStroke(null);
      if (draft && draft.points.length > 0) {
        setStrokes((prev) => [...prev, draft]);
      }
      return;
    }
    if (!activeNaturalSize) return;
    const base = annotationBaseRect(width, height, activeNaturalSize.width, activeNaturalSize.height);
    if (!base) return;
    const rect = annotationDisplayRect(base, width, height, translateX, translateY, scale);
    const point = normalizeAnnotationPoint(pointX, pointY, rect);
    if (!point) return;
    if (phase === 'start') {
      draftStrokeRef.current = { points: [point] };
      setDraftStroke(draftStrokeRef.current);
      return;
    }
    const draft = draftStrokeRef.current;
    if (!draft) return;
    if (!shouldAppendAnnotationPoint(draft, point)) return;
    draftStrokeRef.current = { points: [...draft.points, point] };
    setDraftStroke(draftStrokeRef.current);
  }, [activeNaturalSize, width, height]);

  const undoLastStroke = useCallback(() => {
    setStrokes((prev) => prev.slice(0, -1));
    draftStrokeRef.current = null;
    setDraftStroke(null);
  }, []);

  const exitAnnotationMode = useCallback(() => {
    const image = images[activeIndex];
    const initial = image ? annotation?.initialStrokesFor?.(image) : undefined;
    setStrokes(initial ? [...initial] : []);
    draftStrokeRef.current = null;
    setDraftStroke(null);
    setIsAnnotating(false);
  }, [activeIndex, images, annotation]);

  // 每 url 只自动强制重取一次(Image 加载失败自愈),防 onError↔重取死循环;
  // 重试按钮的显式 forceRefresh 不受此限制。
  const imageErrorRetryUsedRef = useRef<Set<string>>(new Set());
  const listRef = useRef<FlatList<MobileMessageGalleryImage>>(null);

  // 旋转(宽度变化)时按 activeIndex 重锚:FlatList 保留的是旧宽度下的像素
  // contentOffset,不重锚会让可见页与页码 / 分享目标错位。
  useEffect(() => {
    listRef.current?.scrollToOffset({ animated: false, offset: activeIndex * width });
    // activeIndex 不进依赖:翻页由手势滚动驱动,这里只响应宽度突变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  const resolveImage = useCallback((
    image: MobileMessageGalleryImage,
    front: boolean,
    forceRefresh = false,
  ) => {
    if (!onResolveRemoteMedia) return;
    const media = image.payload.media;
    if (media.previewable || !isDesktopLocalMediaUrl(media.url)) return;
    // resolveMap 一律以 gallery 的 trimmed url(image.url)为键:media.url 未 trim,
    // 带空白时会和 renderItem / handleShare 的查键错位。取件请求仍传原始 media.url,
    // 与缩略图路径的队列缓存键保持一致(不产生重复上传)。
    const key = image.url;
    setResolveMap((prev) => {
      const state = prev[key];
      if (!forceRefresh && state && state.status !== 'error') return prev;
      if (state?.status === 'ready') return prev; // 强制重取期间保留旧图帧,新结果到达后整体替换
      return { ...prev, [key]: { status: 'loading' } };
    });
    void onResolveRemoteMedia(
      { kind: media.kind, url: media.url, previewable: media.previewable },
      { front, forceRefresh },
    )
      .then((resolved) => {
        setResolveMap((prev) => ({ ...prev, [key]: { status: 'ready', media: resolved } }));
      })
      .catch(() => {
        setResolveMap((prev) => ({ ...prev, [key]: { status: 'error' } }));
      });
    // 垫底缩略图:列表里这张图已经解码好了,拿来从打开那一刻接住画面,一直垫到
    // 原图 onLoad(见 lightboxImageLayers)。写入**不看取件态** —— 原图可能在同
    // 一批微任务里就从内存/磁盘缓存返回,旧实现要求"当前必须是 loading"才写垫底,
    // 这条竞态下垫底被直接丢弃,画面又退回纯黑。
    // cachedOnly:只复用列表已取过的缩略图缓存,绝不触发新取件——对 gif/老被控端,
    // thumbnail 请求会回落成整张原图下载,装饰性垫底叠加原图主取件就是双下载。
    // forceRefresh 是坏对象自愈路径,不垫可能同源的旧缩略图;取不到缩略图退回
    // spinner(lightboxImageLayers 兜底),不影响原图路径。
    if (!forceRefresh) {
      void onResolveRemoteMedia(
        { kind: media.kind, url: media.url, previewable: media.previewable, thumbnail: true },
        { front: false, cachedOnly: true },
      )
        .then((thumb) => {
          if (!thumb.previewable || !thumb.url) return;
          setPreviewMap((prev) => (prev[key] ? prev : { ...prev, [key]: thumb.url }));
        })
        .catch(() => undefined);
    }
    // setResolveMap 的 loading 守卫已防重复取件;error 态由重试按钮显式再调
  }, [onResolveRemoteMedia]);

  // 重试按钮:显式 forceRefresh 穿透负缓存。稳定引用(带 image 参数)让
  // LightboxPage 的 memo 在父层重渲染时不被内联闭包击穿。
  const handleRetryPage = useCallback((image: MobileMessageGalleryImage) => {
    resolveImage(image, true, true);
  }, [resolveImage]);

  // 取件成功但原生 Image 加载失败(典型:桌面去重缓存返回了已被删除的悬空 key,
  // presign 下载 404)→ 一次性 forceRefresh 重取自愈,再失败落错误态给重试按钮。
  const handleImageLoadError = useCallback((image: MobileMessageGalleryImage) => {
    const key = image.url; // resolveMap / 重试集统一用 trimmed gallery 键
    if (imageErrorRetryUsedRef.current.has(key)) {
      setResolveMap((prev) => ({ ...prev, [key]: { status: 'error' } }));
      return;
    }
    imageErrorRetryUsedRef.current.add(key);
    resolveImage(image, true, true);
  }, [resolveImage]);

  // 活跃页插队取件,相邻页顺队预取(翻页即无缝)。
  useEffect(() => {
    const active = images[activeIndex];
    if (active) resolveImage(active, true);
    const prev = images[activeIndex - 1];
    if (prev) resolveImage(prev, false);
    const next = images[activeIndex + 1];
    if (next) resolveImage(next, false);
  }, [activeIndex, images, resolveImage]);

  const displayUriFor = useCallback((image: MobileMessageGalleryImage): string | null => {
    const media = image.payload.media;
    if (media.previewable && media.url) return media.url;
    const state = resolveMap[image.url];
    if (state?.status === 'ready' && state.media.previewable) return state.media.url;
    return null;
  }, [resolveMap]);

  /**
   * 该页的垫底缩略图。与原图地址相同时返回 null:磁盘缓存命中会让缩略图与
   * 原图落到同一个 file://(缩不动的图按裸键落盘),此时垫同一张图纯属多解码
   * 一份,且原图本就秒出。
   */
  const previewUriFor = useCallback((image: MobileMessageGalleryImage): string | null => {
    const preview = previewMap[image.url];
    if (!preview) return null;
    return preview === displayUriFor(image) ? null : preview;
  }, [previewMap, displayUriFor]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: lightboxBackgroundOpacity(dismissY.value, height),
  }));
  const chromeStyle = useAnimatedStyle(() => ({
    opacity: lightboxBackgroundOpacity(dismissY.value, height) * (1 - chromeHidden.value),
  }));

  const activeImage = images[activeIndex] ?? null;
  const activeUri = activeImage ? displayUriFor(activeImage) : null;
  const pageLabel = lightboxPageLabel(activeIndex, images.length);
  const shareVisible = !!onShareImage && !!activeImage && canShareLightboxImage(activeUri);

  const handleShare = useCallback(() => {
    if (!activeImage || !activeUri || !onShareImage || sharingRef.current || submittingRef.current) return;
    const state = resolveMap[activeImage.url];
    const mimeType = state?.status === 'ready' ? state.media.mimeType : undefined;
    const sizeBytes = state?.status === 'ready' ? state.media.size : undefined;
    sharingRef.current = true;
    setSharing(true);
    void Promise.resolve()
      .then(() =>
        onShareImage(activeImage.payload.media, activeUri, mimeType, sizeBytes),
      )
      .catch(() => {
        // 与标注提交一致,宿主负责显示具体分享错误。
      })
      .finally(() => {
        sharingRef.current = false;
        setSharing(false);
      });
  }, [activeImage, activeUri, onShareImage, resolveMap]);

  // 活跃页 mime(取件结果优先,兜底 uri 后缀):gif / svg 不开放画笔(烧录只留首帧)。
  const activeResolveState = activeImage ? resolveMap[activeImage.url] : undefined;
  const activeMimeType = activeResolveState?.status === 'ready'
    ? activeResolveState.media.mimeType
    : undefined;
  const activeLooksGif = !!activeUri && /\.gif(?:[?#]|$)/i.test(activeUri.split('?')[0] ?? activeUri);
  const annotateVisible = !!annotation
    && !!activeImage
    && !!activeUri
    && canAnnotateImageMime(activeMimeType)
    && !activeLooksGif;
  // 独立直发(发送到对话):不要求可标注——gif 等不可画的图同样能转发。
  const directSubmitVisible = !!annotation?.allowDirectSubmit && !!activeImage && !!activeUri;

  const handleSubmitAnnotation = useCallback(() => {
    if (!annotation || !activeImage || !activeUri || submittingRef.current || sharingRef.current) return;
    submittingRef.current = true;
    setAnnotationSubmitting(true);
    // 点击提交时另一根手指可能还在画,把屏幕上最后一笔也纳入同一快照。
    const visibleStrokes = draftStrokeRef.current ? [...strokes, draftStrokeRef.current] : strokes;
    // 提交期间会忽略抬手回调,先收存草稿,失败后继续画也不会覆盖这一笔。
    setStrokes(visibleStrokes);
    draftStrokeRef.current = null;
    setDraftStroke(null);
    const submittedStrokes = visibleStrokes.map((s) => ({ points: [...s.points] }));
    void Promise.resolve()
      .then(() => annotation.onSubmit(activeImage, activeUri, submittedStrokes, {
        mimeType: activeMimeType,
      }))
      .then(() => onCloseRef.current())
      .catch(() => {
        // 宿主已提示错误;停留在标注模式让用户重试或放弃。
      })
      .finally(() => {
        submittingRef.current = false;
        setAnnotationSubmitting(false);
      });
  }, [annotation, activeImage, activeUri, activeMimeType, strokes]);

  // Android 物理返回键触发 Modal.onRequestClose,不受手势层/按钮层的
  // isAnnotating 禁用覆盖(review 发现:会绕开"标注模式中关闭均禁用"保护
  // 直接整体关闭 lightbox,未保存笔迹丢失)。标注中改为退出标注模式,
  // 提交中忽略返回键,非标注态才走原始关闭。
  const handleRequestClose = useCallback(() => {
    if (submittingRef.current) return;
    if (isAnnotating) {
      exitAnnotationMode();
      return;
    }
    onCloseRef.current();
  }, [isAnnotating, exitAnnotationMode]);

  // iOS 沉浸式隐藏状态栏:经宿主屏的 screen option 走 VC-based 通道(iOS 27 起
  // RN StatusBar 全局 API 失效;transparent Modal 不接管状态栏,穿透到宿主屏)。
  // Android 继续用 Modal 内组件式 <StatusBar hidden>,不走 RNS 双轨。
  // 只触碰 statusBarHidden 一个键,泛型收窄到最小面。
  const navigation = useNavigation<{
    setOptions: (options: { statusBarHidden: boolean }) => void;
  }>();
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    navigation.setOptions({ statusBarHidden: true });
    return () => navigation.setOptions({ statusBarHidden: false });
  }, [navigation]);

  return (
    <Modal
      animationType="fade"
      onRequestClose={handleRequestClose}
      statusBarTranslucent
      supportedOrientations={['portrait', 'landscape']}
      transparent
      visible
    >
      {Platform.OS === 'android' ? <StatusBar hidden /> : null}
      <GestureHandlerRootView
        onAccessibilityEscape={handleRequestClose}
        style={styles.root}
        testID="message.imageLightbox"
      >
        <Animated.View pointerEvents="none" style={[styles.backdrop, backdropStyle]} />
        <FlatList
          data={images}
          decelerationRate="fast"
          getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
          horizontal
          initialScrollIndex={lightboxInitialIndex(urls, initialUrl)}
          keyExtractor={(image) => image.key}
          onMomentumScrollEnd={(event) => {
            const index = lightboxPageIndex(event.nativeEvent.contentOffset.x, width, images.length);
            setActiveIndex(index);
          }}
          pagingEnabled
          ref={listRef}
          renderItem={({ item, index }) => (
            <LightboxPage
              active={index === activeIndex}
              annotating={index === activeIndex && isAnnotating}
              // 活跃页显示编辑中的笔迹;预取的相邻页显示各自的既有笔迹(托盘
              // 多图再编辑时翻页不闪空)。
              annotationDraftStroke={index === activeIndex ? draftStroke : null}
              annotationStrokes={index === activeIndex
                ? strokes
                : annotation?.initialStrokesFor?.(item) ?? EMPTY_STROKES}
              chromeHidden={chromeHidden}
              dismissY={dismissY}
              height={height}
              image={item}
              interactionDisabled={annotationSubmitting || index !== activeIndex}
              naturalSize={naturalSizes[item.key] ?? null}
              onChromeBusy={handleChromeBusy}
              onDrawPoint={handleDrawPoint}
              onImageError={handleImageLoadError}
              onNaturalSize={handleNaturalSize}
              onRequestClose={handleRequestClose}
              onRetry={handleRetryPage}
              onZoomChange={setZoomed}
              previewUri={previewUriFor(item)}
              resolveState={item.payload.media.previewable ? null : resolveMap[item.url] ?? null}
              uri={displayUriFor(item)}
              width={width}
            />
          )}
          scrollEnabled={!zoomed && !isAnnotating && !annotationSubmitting && images.length > 1}
          showsHorizontalScrollIndicator={false}
          windowSize={3}
        />
        <Animated.View
          pointerEvents={chromeInteractive ? 'box-none' : 'none'}
          // 整个操作层避开横屏两侧切口,让关闭、文件标题和所有底栏共用安全边界。
          style={[styles.chrome, chromeStyle, {
            left: insets.left,
            right: insets.right,
            paddingBottom: insets.bottom + 16,
            paddingTop: insets.top + 8,
          }]}
          testID="message.imageLightboxChrome"
        >
          {!isAnnotating && !showFileHeader ? (
            <Pressable
              accessibilityLabel={t('message.lightbox.closeImage')}
              accessibilityRole="button"
              disabled={annotationSubmitting}
              onPress={handleRequestClose}
              style={[styles.closeButton, { top: insets.top + 8 }]}
              testID="message.imageLightboxCloseButton"
            >
              <X color="#ffffff" size={iconSize.action} strokeWidth={iconStroke.regular} />
            </Pressable>
          ) : null}
          {isAnnotating ? (
            // 标注模式 chrome(对齐桌面):底部工具栏切换为 取消 / 撤销 / 提交
            // 三项;翻页/下滑/单击关闭均已在手势层禁用,页码与分享隐藏。
            <View pointerEvents="box-none" style={[styles.actionBar, { bottom: insets.bottom + 12 }]}>
              <View style={styles.actionBarPill}>
                <Pressable
                  accessibilityLabel={t('message.lightbox.cancelAnnotation')}
                  disabled={annotationSubmitting}
                  hitSlop={8}
                  onPress={exitAnnotationMode}
                  style={styles.actionItem}
                  testID="message.imageLightboxAnnotationCancel"
                >
                  <X color="#ffffff" size={iconSize.action} strokeWidth={iconStroke.regular} />
                  <Text style={styles.actionLabel}>{t('message.lightbox.cancel')}</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={t('message.lightbox.undoLastStroke')}
                  disabled={strokes.length === 0 || annotationSubmitting}
                  hitSlop={8}
                  onPress={undoLastStroke}
                  style={styles.actionItem}
                  testID="message.imageLightboxAnnotationUndo"
                >
                  <Undo2
                    color={strokes.length > 0 ? '#ffffff' : 'rgba(255,255,255,0.35)'}
                    size={iconSize.action}
                    strokeWidth={iconStroke.regular}
                  />
                  <Text style={[styles.actionLabel, strokes.length === 0 && styles.actionLabelDisabled]}>{t('message.lightbox.undo')}</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={annotation?.submitLabel ?? t('message.lightbox.done')}
                  disabled={annotationSubmitting}
                  hitSlop={8}
                  onPress={handleSubmitAnnotation}
                  style={styles.actionItem}
                  testID="message.imageLightboxAnnotationSubmit"
                >
                  {annotationSubmitting ? (
                    <ActivityIndicator color="#ffffff" size="small" />
                  ) : (
                    <MessageSquarePlus color="#ffffff" size={iconSize.action} strokeWidth={iconStroke.regular} />
                  )}
                  <Text style={styles.actionLabel}>{annotation?.submitLabel ?? t('message.lightbox.done')}</Text>
                </Pressable>
              </View>
            </View>
          ) : showFileHeader ? (
            <View pointerEvents="box-none" style={styles.fileHeader}>
              <Pressable accessibilityLabel={t('message.lightbox.done')}
                accessibilityRole="button"
                disabled={annotationSubmitting}
                hitSlop={10} onPress={handleRequestClose} testID="message.imageLightboxDone">
                <Text style={styles.fileHeaderDone}>{t('message.lightbox.done')}</Text>
              </Pressable>
              <View pointerEvents="none" style={styles.fileHeaderTitleCol}>
                <Text numberOfLines={1} style={styles.fileHeaderTitle} testID="message.imageLightboxTitle">
                  {activeImage?.title ?? ''}
                </Text>
                <Text numberOfLines={1} style={styles.fileHeaderMeta}>
                  {[pageLabel, activeImage?.subtitle].filter(Boolean).join(' · ')}
                </Text>
              </View>
              {shareVisible ? (
                <Pressable
                  accessibilityLabel={t('message.lightbox.shareImage')}
                  accessibilityRole="button"
                  accessibilityState={{ busy: sharing }}
                  disabled={sharing || annotationSubmitting}
                  hitSlop={10}
                  onPress={handleShare}
                  testID="message.imageLightboxShareButton"
                >
                  {sharing ? (
                    <ActivityIndicator color="#ffffff" size="small" />
                  ) : <ShareIcon color="#ffffff" size={iconSize.action} strokeWidth={iconStroke.regular} />}
                </Pressable>
              ) : (
                <View style={styles.fileHeaderShareSpacer} />
              )}
            </View>
          ) : pageLabel ? (
            <Text style={styles.pageLabel} testID="message.imageLightboxPageLabel">{pageLabel}</Text>
          ) : null}
          {isAnnotating ? null : extraActions && extraActions.length > 0 ? (
            <View pointerEvents="box-none" style={[styles.actionBar, { bottom: insets.bottom + 12 }]}>
              <View style={styles.actionBarPill}>
                {annotateVisible ? (
                  <Pressable
                    accessibilityLabel={t('message.lightbox.annotateImage')}
                    disabled={annotationSubmitting || sharing}
                    hitSlop={8}
                    onPress={() => setIsAnnotating(true)}
                    style={styles.actionItem}
                    testID="message.imageLightboxAnnotateButton"
                  >
                    <Pen color="#ffffff" size={iconSize.action} strokeWidth={iconStroke.regular} />
                    <Text style={styles.actionLabel}>{t('message.lightbox.annotate')}</Text>
                  </Pressable>
                ) : null}
                {extraActions.map((action) => (
                  <Pressable
                    accessibilityLabel={action.label}
                    disabled={annotationSubmitting || sharing}
                    hitSlop={8}
                    key={action.key}
                    onPress={() => activeImage && action.onPress(activeImage)}
                    style={styles.actionItem}
                    testID={`message.imageLightboxAction.${action.key}`}
                  >
                    <action.icon color="#ffffff" size={iconSize.action} strokeWidth={iconStroke.regular} />
                    <Text style={styles.actionLabel}>{action.label}</Text>
                  </Pressable>
                ))}
                {shareVisible && !showFileHeader ? (
                  <Pressable
                    accessibilityLabel={t('message.lightbox.shareImage')}
                    accessibilityRole="button"
                    accessibilityState={{ busy: sharing }}
                    disabled={sharing || annotationSubmitting}
                    hitSlop={8}
                    onPress={handleShare}
                    style={styles.actionItem}
                    testID="message.imageLightboxShareButton"
                  >
                    {sharing ? (
                      <ActivityIndicator color="#ffffff" size="small" />
                    ) : (
                      <ShareIcon color="#ffffff" size={iconSize.action} strokeWidth={iconStroke.regular} />
                    )}
                    <Text style={styles.actionLabel}>
                      {t('message.lightbox.exportShare')}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : shareVisible || annotateVisible || directSubmitVisible ? (
            // 聊天 chrome(对齐桌面):底部工具栏 [标注][发送到对话] | [导出/分享]。
            // 分享覆盖桌面「复制/另存为/打开」的能力面(系统分享单),分隔线左侧
            // 是「进对话」组、右侧是「出 app」组。
            <View pointerEvents="box-none" style={[styles.actionBar, { bottom: insets.bottom + 12 }]}>
              <View style={styles.actionBarPill}>
                {annotateVisible ? (
                  <Pressable
                    accessibilityLabel={t('message.lightbox.annotateImage')}
                    disabled={annotationSubmitting || sharing}
                    hitSlop={8}
                    onPress={() => setIsAnnotating(true)}
                    style={styles.actionItem}
                    testID="message.imageLightboxAnnotateButton"
                  >
                    <Pen color="#ffffff" size={iconSize.action} strokeWidth={iconStroke.regular} />
                    <Text style={styles.actionLabel}>
                      {t('message.lightbox.annotate')}
                    </Text>
                  </Pressable>
                ) : null}
                {directSubmitVisible ? (
                  <Pressable
                    accessibilityLabel={annotation?.submitLabel ?? t('message.lightbox.sendToChat')}
                    disabled={annotationSubmitting || sharing}
                    hitSlop={8}
                    onPress={handleSubmitAnnotation}
                    style={styles.actionItem}
                    testID="message.imageLightboxSendToChatButton"
                  >
                    {annotationSubmitting ? (
                      <ActivityIndicator color="#ffffff" size="small" />
                    ) : (
                      <MessageSquarePlus color="#ffffff" size={iconSize.action} strokeWidth={iconStroke.regular} />
                    )}
                    <Text style={styles.actionLabel}>
                      {annotation?.submitLabel ?? t('message.lightbox.sendToChat')}
                    </Text>
                  </Pressable>
                ) : null}
                {shareVisible && (annotateVisible || directSubmitVisible) ? (
                  <View style={styles.actionDivider} />
                ) : null}
                {shareVisible ? (
                  <Pressable
                    accessibilityLabel={t('message.lightbox.shareImage')}
                    accessibilityRole="button"
                    accessibilityState={{ busy: sharing }}
                    disabled={sharing || annotationSubmitting}
                    hitSlop={8}
                    onPress={handleShare}
                    style={styles.actionItem}
                    testID="message.imageLightboxShareButton"
                  >
                    {sharing ? (
                      <ActivityIndicator color="#ffffff" size="small" />
                    ) : (
                      <ShareIcon color="#ffffff" size={iconSize.action} strokeWidth={iconStroke.regular} />
                    )}
                    <Text style={styles.actionLabel}>
                      {t('message.lightbox.exportShare')}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
});

/** 空笔迹常量:非活跃页无既有笔迹时复用同一引用,保住 LightboxPage 的 memo。 */
const EMPTY_STROKES: readonly AnnotationStroke[] = [];

/** 单页:图片手势(捏合/平移/双击/单击/下滑)+ 取件中/失败态 + 标注 overlay。 */
const LightboxPage = memo(function LightboxPage({
  active,
  annotating,
  annotationDraftStroke,
  annotationStrokes,
  chromeHidden,
  dismissY,
  height,
  image,
  interactionDisabled,
  naturalSize,
  onChromeBusy,
  onDrawPoint,
  onImageError,
  onNaturalSize,
  onRequestClose,
  onRetry,
  onZoomChange,
  previewUri,
  resolveState,
  uri,
  width,
}: {
  active: boolean;
  interactionDisabled: boolean;
  /** 标注模式(仅活跃页):单指作画、禁单击/下滑关闭与双击缩放,双指仍可缩放平移。 */
  annotating: boolean;
  /** 进行中的一笔(仅活跃页非空)。 */
  annotationDraftStroke: AnnotationStroke | null;
  /** 已落笔迹(活跃页=编辑态;其它页=各自的既有笔迹,只读叠加显示)。 */
  annotationStrokes: readonly AnnotationStroke[];
  chromeHidden: SharedValue<number>;
  dismissY: SharedValue<number>;
  height: number;
  image: MobileMessageGalleryImage;
  /** 图片自然尺寸(overlay 坐标基准;未知时 overlay 不渲染、画笔不采点)。 */
  naturalSize: { width: number; height: number } | null;
  /** 捏合/平移开始与结束时通知父层开关 chrome 触摸。 */
  onChromeBusy(busy: boolean): void;
  /** 画笔事件(容器坐标 + 当页 transform 快照),UI 线程经 runOnJS 上抛。 */
  onDrawPoint: (
    phase: 'start' | 'move' | 'end',
    pointX: number,
    pointY: number,
    translateX: number,
    translateY: number,
    scale: number,
  ) => void;
  /** 原生 Image 加载失败(悬空 key 404 等)→ 上抛做一次性 forceRefresh 自愈。
   *  带 image 参数的稳定引用;是否接线由本页按 retryable 判定。 */
  onImageError?: (image: MobileMessageGalleryImage) => void;
  onNaturalSize(imageKey: string, size: { width: number; height: number }): void;
  onRequestClose(): void;
  onRetry(image: MobileMessageGalleryImage): void;
  onZoomChange(zoomed: boolean): void;
  /** 列表缩略图(渐进出图的垫底层);无则退 spinner。见 lightboxImageLayers。 */
  previewUri: string | null;
  resolveState: PageResolveState | null;
  uri: string | null;
  width: number;
}) {
  const { t } = useTranslation();
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);
  const startFocalX = useSharedValue(0);
  const startFocalY = useSharedValue(0);
  const displayedW = useSharedValue(width);
  const displayedH = useSharedValue(height);
  const pinchBusy = useSharedValue(0);
  const panBusy = useSharedValue(0);
  const doubleTapBusy = useSharedValue(0);
  const dragY = useSharedValue(0);
  /**
   * 已 onLoad 成功的原图地址。存地址而不是 boolean:换图 / 强制重取换 url 后
   * 天然失效,不需要额外 effect 复位(漏复位就会让新图那段又回到纯黑)。
   */
  const [loadedUri, setLoadedUri] = useState<string | null>(null);
  /**
   * 已确认加载失败的垫底图地址(同样存地址,换图天然失效)。
   * 缩略图的磁盘文件可能被 150MB LRU 或系统清理掉,而取件队列的内存缓存仍持有那个
   * 永不过期的 file:// —— 光看 URI 存在会把"没有像素"当成"已经出图",于是 spinner
   * 被藏掉、垫底层又画不出东西,整段退回纯黑(PR #1125 review)。
   */
  const [failedPreviewUri, setFailedPreviewUri] = useState<string | null>(null);
  /**
   * 已确证 onError 的原图地址(同样存地址,换图 / 重取换 url 天然失效)。
   * 桌面取件图有 forceRefresh 自愈 + 重试按钮兜底,失败终态由父层的 resolveMap 接管;
   * 直连 http 图在本页落失败态,用户重试时清除此标记并重新挂载 Image。
   */
  const [failedFullUri, setFailedFullUri] = useState<string | null>(null);
  const media = image.payload.media;
  // 桌面取件图可 forceRefresh;直连图重试只重新挂载原 URI,不走桌面取件。
  const retryable = !media.previewable && isDesktopLocalMediaUrl(media.url);
  const layers = lightboxImageLayers({
    fullUri: uri,
    previewUri,
    fullLoaded: !!uri && loadedUri === uri,
    previewFailed: !!previewUri && failedPreviewUri === previewUri,
    fullFailedTerminally: !retryable && !!uri && failedFullUri === uri,
  });

  const reportZoomed = useCallback((value: boolean) => {
    onZoomChange(value);
  }, [onZoomChange]);

  useEffect(() => {
    const size = lightboxContainedSize(
      width,
      height,
      naturalSize?.width ?? 0,
      naturalSize?.height ?? 0,
    );
    displayedW.value = size.width;
    displayedH.value = size.height;
    // 捏合中 onChange 每帧按新 displayed 钳;不能改 savedTranslate,否则下一帧
    // 会用被改过的起点 + 焦点增量跳一下。
    if (pinchBusy.value) return;
    // 双击动画中只改 saved;live 仍归原 withTiming,结束回调再贴齐。
    // 中途另起 withTiming 会跟 scale 抢默认时长:缩放先到、点击点随后横漂。
    if (doubleTapBusy.value) {
      const next = reclampLightboxPan(
        savedTranslateX.value,
        savedTranslateY.value,
        width,
        height,
        savedScale.value,
        size.width,
        size.height,
      );
      savedTranslateX.value = next.x;
      savedTranslateY.value = next.y;
      return;
    }
    const next = reclampLightboxPan(
      translateX.value,
      translateY.value,
      width,
      height,
      scale.value,
      size.width,
      size.height,
    );
    translateX.value = next.x;
    translateY.value = next.y;
    savedTranslateX.value = next.x;
    savedTranslateY.value = next.y;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naturalSize, width, height]);

  // 翻走 / 换图时复位缩放与位移,避免回到本页时残留上次的缩放态。
  useEffect(() => {
    if (active) return;
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    originX.value = 0;
    originY.value = 0;
    pinchBusy.value = 0;
    panBusy.value = 0;
    doubleTapBusy.value = 0;
    dragY.value = 0;
    chromeHidden.value = 0;
    onChromeBusy(false);
    // 共享值的写入不需要依赖追踪,这里只关心 active 翻转时机
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const gesture = useMemo(() => {
    // 新手势接管当前帧,必须同时停掉缩放与两轴位移,避免旧动画继续推着图片走。
    const stopTransformAnimation = () => {
      'worklet';
      doubleTapBusy.value = 0;
      cancelAnimation(scale);
      cancelAnimation(translateX);
      cancelAnimation(translateY);
    };
    const hideChrome = () => {
      'worklet';
      chromeHidden.value = withTiming(1, { duration: motionDuration.instant });
      runOnJS(onChromeBusy)(true);
    };
    const maybeShowChrome = () => {
      'worklet';
      if (pinchBusy.value || panBusy.value) return;
      chromeHidden.value = withTiming(0, { duration: motionDuration.fast });
      runOnJS(onChromeBusy)(false);
    };
    const bakePinchOrigin = () => {
      'worklet';
      const bakedX = bakeLightboxOrigin(translateX.value, originX.value, scale.value);
      const bakedY = bakeLightboxOrigin(translateY.value, originY.value, scale.value);
      originX.value = 0;
      originY.value = 0;
      if (!isLightboxZoomed(scale.value)) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        runOnJS(reportZoomed)(false);
        return;
      }
      const cx = clampLightboxTranslation(bakedX, width, scale.value, displayedW.value);
      const cy = clampLightboxTranslation(bakedY, height, scale.value, displayedH.value);
      translateX.value = cx;
      translateY.value = cy;
      savedTranslateX.value = cx;
      savedTranslateY.value = cy;
      savedScale.value = scale.value;
      runOnJS(reportZoomed)(true);
    };

    // 焦点捏合:起点锁定 origin,缩放绕焦点;浏览态跟手质心,标注态只改 scale
    // (平移交给双指 pan,避免 Simultaneous 下位移被加两遍)。
    const pinch = Gesture.Pinch()
      .enabled(!interactionDisabled)
      .onStart((event) => {
        pinchBusy.value = 1;
        stopTransformAnimation();
        hideChrome();
        // 捏合一开始就锁死翻页,不等 JS zoomed 提交;否则松手后立刻左右拖
        // 会被 pagingEnabled 的 FlatList 抢走,当前页直接滑走。
        runOnJS(reportZoomed)(true);
        // 下滑半途改捏合:关掉正在进行的 dismiss 位移,不把图和背景留在半透明上。
        dragY.value = 0;
        dismissY.value = 0;
        savedScale.value = scale.value;
        originX.value = lightboxPinchOrigin(event.focalX, width);
        originY.value = lightboxPinchOrigin(event.focalY, height);
        // 已放大时 origin 会立刻贡献 origin*(1-scale);扣掉等量位移,二次捏合不跳。
        translateX.value = compensateLightboxOrigin(translateX.value, originX.value, scale.value);
        translateY.value = compensateLightboxOrigin(translateY.value, originY.value, scale.value);
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
        startFocalX.value = event.focalX;
        startFocalY.value = event.focalY;
      })
      .onChange((event) => {
        scale.value = clampLightboxScale(savedScale.value * event.scale);
        if (annotating) return;
        // 画面中心钳制,再补偿回 raw。origin≠0 时不能钳 raw。
        const next = clampLightboxVisualPan(
          savedTranslateX.value + (event.focalX - startFocalX.value),
          savedTranslateY.value + (event.focalY - startFocalY.value),
          originX.value,
          originY.value,
          width,
          height,
          scale.value,
          displayedW.value,
          displayedH.value,
        );
        translateX.value = next.x;
        translateY.value = next.y;
      })
      .onFinalize(() => {
        if (!pinchBusy.value) return;
        bakePinchOrigin();
        pinchBusy.value = 0;
        maybeShowChrome();
      });

    // 浏览:单指平移,未放大时 fail,避免与 pinch 抢 2 指。
    // 标注:恰好双指平移,1x 也可挪视野。
    const panZoomed = Gesture.Pan()
      .enabled(!interactionDisabled)
      .minPointers(annotating ? 2 : 1)
      .maxPointers(annotating ? 2 : 1)
      .onTouchesDown((_event, state) => {
        if (!annotating && !isLightboxZoomed(scale.value)) state.fail();
      })
      .onStart(() => {
        panBusy.value = 1;
        stopTransformAnimation();
        hideChrome();
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
      })
      .onChange((event) => {
        // 标注双指 pan 与 off-center pinch Simultaneous,origin 常非 0;
        // 浏览单指 pan 的 origin 已 bake 归零,helper 退化为钳 raw。
        const next = clampLightboxVisualPan(
          translateX.value + event.changeX,
          translateY.value + event.changeY,
          originX.value,
          originY.value,
          width,
          height,
          scale.value,
          displayedW.value,
          displayedH.value,
        );
        translateX.value = next.x;
        translateY.value = next.y;
      })
      .onFinalize(() => {
        // Tap 也会让未激活的 Pan 走 FAILED → finalize。它不拥有位移,
        // 不能把双击缩回的 saved=0 覆盖成动画中途的旧偏移。
        if (!panBusy.value) return;
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
        panBusy.value = 0;
        if (!pinchBusy.value)
          runOnJS(reportZoomed)(isLightboxZoomed(scale.value));
        maybeShowChrome();
      });

    const panDismiss = Gesture.Pan()
      .enabled(!annotating && !interactionDisabled)
      .maxPointers(1)
      .onTouchesDown((_event, state) => {
        if (isLightboxZoomed(scale.value)) state.fail();
      })
      .onTouchesMove((_event, state) => {
        // Simultaneous 下 onTouchesDown 的 fail 经常来不及:放大后竖直滑会被
        // activeOffsetY 认成下滑关闭。横图 contain 后即使 2.5x 也常无纵向溢出,
        // 图不动、手还在往下,手势就落到关闭上。
        if (isLightboxZoomed(scale.value)) state.fail();
      })
      .activeOffsetY([-16, 16])
      .failOffsetX([-12, 12])
      .onUpdate((event) => {
        if (isLightboxZoomed(scale.value)) {
          dragY.value = 0;
          dismissY.value = 0;
          return;
        }
        dragY.value = event.translationY;
        dismissY.value = event.translationY;
      })
      .onEnd((event) => {
        if (shouldDismissLightbox(event.translationY, event.velocityY, scale.value)) {
          runOnJS(onRequestClose)();
          return;
        }
        dragY.value = withSpring(0, { damping: 20, stiffness: 240 });
        dismissY.value = withSpring(0, { damping: 20, stiffness: 240 });
      })
      .onFinalize((_event, success) => {
        // fail/cancel 不走 onEnd:下滑半途被捏合抢走时,位移和背景渐隐必须立刻清掉。
        // success 路径由 onEnd 负责(关闭或回弹),这里不要抢。
        if (success) return;
        dragY.value = 0;
        dismissY.value = 0;
      });

    const doubleTap = Gesture.Tap()
      .enabled(!annotating && !interactionDisabled)
      .numberOfTaps(2)
      .maxDistance(LIGHTBOX_TAP_MAX_DISTANCE)
      .onEnd((event, success) => {
        if (!success || pinchBusy.value || panBusy.value) return;
        const next = nextDoubleTapScale(
          doubleTapBusy.value ? savedScale.value : scale.value,
        );
        stopTransformAnimation();
        originX.value = 0;
        originY.value = 0;
        dragY.value = 0;
        dismissY.value = 0;
        doubleTapBusy.value = 1;
        const clearDoubleTapBusy = (finished?: boolean) => {
          'worklet';
          if (!finished || !doubleTapBusy.value) return;
          doubleTapBusy.value = 0;
          // 尺寸变化只改过 saved:与 scale 同一拍结束时把 live 收到新 contain 边界。
          translateX.value = savedTranslateX.value;
          translateY.value = savedTranslateY.value;
          runOnJS(reportZoomed)(isLightboxZoomed(savedScale.value));
        };
        if (!isLightboxZoomed(next)) {
          savedScale.value = 1;
          savedTranslateX.value = 0;
          savedTranslateY.value = 0;
          // 动画完成前继续锁住翻页;减少动态效果下回调可同步执行,先写目标。
          scale.value = withTiming(1);
          translateX.value = withTiming(0);
          translateY.value = withTiming(0, undefined, clearDoubleTapBusy);
          return;
        }
        const tx = clampLightboxTranslation(
          lightboxDoubleTapTranslate(event.x, width, next),
          width,
          next,
          displayedW.value,
        );
        const ty = clampLightboxTranslation(
          lightboxDoubleTapTranslate(event.y, height, next),
          height,
          next,
          displayedH.value,
        );
        savedScale.value = next;
        savedTranslateX.value = tx;
        savedTranslateY.value = ty;
        runOnJS(reportZoomed)(true);
        scale.value = withTiming(next);
        translateX.value = withTiming(tx);
        translateY.value = withTiming(ty, undefined, clearDoubleTapBusy);
      });

    const singleTap = Gesture.Tap()
      .enabled(!annotating && !interactionDisabled)
      .numberOfTaps(1)
      .maxDistance(LIGHTBOX_TAP_MAX_DISTANCE)
      .onEnd((_event, success) => {
        if (success && shouldCloseLightboxOnTap(scale.value)) runOnJS(onRequestClose)();
      });

    // 画笔:单指跟手采点(worklet 只搬运坐标 + transform 快照,归一化在 JS 侧
    // 纯函数完成);第二根手指落下时本手势自然结束,已画的半笔照常落笔。
    const panDraw = Gesture.Pan()
      .enabled(annotating && !interactionDisabled)
      .maxPointers(1)
      .minDistance(0)
      .onStart((event) => {
        runOnJS(onDrawPoint)('start', event.x, event.y, translateX.value, translateY.value, scale.value);
      })
      .onUpdate((event) => {
        runOnJS(onDrawPoint)('move', event.x, event.y, translateX.value, translateY.value, scale.value);
      })
      .onFinalize(() => {
        runOnJS(onDrawPoint)('end', 0, 0, 0, 0, 1);
      });

    return Gesture.Simultaneous(
      Gesture.Exclusive(doubleTap, singleTap),
      pinch,
      panZoomed,
      panDismiss,
      panDraw,
    );
    // 共享值引用恒定,只有布尔开关与尺寸变化需要重建手势。不再把 zoomed
    // 放进 deps:捏合结束改 React 状态会整图重建手势图,正是卡顿来源。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    annotating,
    interactionDisabled,
    width,
    height,
    onRequestClose,
    reportZoomed,
    onDrawPoint,
    onChromeBusy,
  ]);

  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value + dragY.value },
      { translateX: originX.value },
      { translateY: originY.value },
      { scale: scale.value },
      { translateX: -originX.value },
      { translateY: -originY.value },
    ],
  }));

  // 取件成功但 mime 非图片(unsupported)时 displayUriFor 恒为 null,若只认
  // status==='error' 会永远停在 spinner —— 一并视为失败,给到重试按钮。
  const resolvedUnsupported = resolveState?.status === 'ready' && !resolveState.media.previewable;

  // 标注 overlay 的锚定矩形(contain 1x):其中心恒等于容器中心,与图片层共用
  // 同一 translate/scale transform 时缩放中心一致,视觉完全跟随(纯函数,可单测)。
  const annotationBase = useMemo(
    () => (naturalSize ? annotationBaseRect(width, height, naturalSize.width, naturalSize.height) : null),
    [naturalSize, width, height],
  );
  const overlayStrokes = useMemo<readonly AnnotationStroke[]>(
    () => (annotationDraftStroke ? [...annotationStrokes, annotationDraftStroke] : annotationStrokes),
    [annotationStrokes, annotationDraftStroke],
  );
  const overlayVisible = !!uri && !!annotationBase && !!naturalSize && overlayStrokes.length > 0;
  const overlayStrokeWidth = naturalSize
    ? annotationStrokeWidth(naturalSize.width, naturalSize.height)
    : 0;

  return (
    <View style={{ height, width }}>
      {uri && !layers.showFailure ? (
        <GestureDetector gesture={gesture}>
          <Animated.View collapsable={false} style={styles.pageFill}>
            {/*
              渐进出图的垫底层:原图字节还在下载时,先用列表已解码的缩略图占住
              整屏(此前这一段是裸黑屏——用户在列表已经看过这张图,点开反而先黑
              一段)。共用同一份 imageStyle transform + contain,与原图几何完全
              一致,原图 onLoad 后本层卸掉,视觉上无跳变。
              绝对定位而非参与 flex:与原图同为 flex 子节点会被 Yoga 各分一半高度。
            */}
            {layers.showPreview && previewUri ? (
              <Animated.Image
                // 垫底图画不出来时必须撤掉并让 spinner 回来,不能停在纯黑(见
                // failedPreviewUri)。乐观先渲染而不是等它 onLoad:本地文件解码只要
                // 一两帧,为它先挂一帧 spinner 反而每次打开都闪一下,与本次「让用户
                // 感知不到」的目标相反。
                onError={() => setFailedPreviewUri(previewUri)}
                resizeMode="contain"
                source={{ uri: previewUri }}
                style={[styles.pagePreviewLayer, imageStyle]}
                testID="message.imageLightboxPreviewLayer"
              />
            ) : null}
            <Animated.Image
              // 两条失败路径都要接:可重取的图交父层做一次 forceRefresh 自愈(再失败
              // 落父层 error 态给重试按钮);直连图在本页落失败态,提供原地重试。
              onError={() => {
                setFailedFullUri(uri);
                if (onImageError && retryable) onImageError(image);
              }}
              onLoad={(event) => {
                // 撤垫底的唯一依据:原图真的有像素了。早于此撤(例如取件一完成
                // 就撤)就会把下载窗口裸露成黑屏,正是本次修复的起因。
                setLoadedUri(uri);
                const source = event.nativeEvent?.source;
                if (source && source.width > 0 && source.height > 0) {
                  onNaturalSize(image.key, { width: source.width, height: source.height });
                }
              }}
              resizeMode="contain"
              source={{ uri }}
              style={[styles.pageFill, imageStyle]}
            />
            {/* 连缩略图都没有(直连 http 图 / 缓存未命中):至少给转圈,不留纯黑无反馈。 */}
            {layers.showSpinner ? (
              <View pointerEvents="none" style={styles.pageSpinnerLayer}>
                <ActivityIndicator color="#ffffff" testID="message.imageLightboxLoading" />
              </View>
            ) : null}
            {overlayVisible ? (
              // 两遍绘制(先全部白描边、再全部红线):交叉处不会出现白边压
              // 红线的断裂感,与桌面 / 烧录一致。
              <Animated.View
                pointerEvents="none"
                style={[
                  {
                    height: annotationBase.height,
                    left: annotationBase.left,
                    position: 'absolute',
                    top: annotationBase.top,
                    width: annotationBase.width,
                  },
                  imageStyle,
                ]}
              >
                <Svg
                  height="100%"
                  viewBox={`0 0 ${naturalSize.width} ${naturalSize.height}`}
                  width="100%"
                >
                  {overlayStrokes.map((stroke, index) => (
                    <Path
                      d={annotationStrokeToSvgPath(stroke, naturalSize.width, naturalSize.height)}
                      fill="none"
                      key={`outline-${index}`}
                      stroke={ANNOTATION_OUTLINE_COLOR}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={Math.round(overlayStrokeWidth * ANNOTATION_OUTLINE_WIDTH_RATIO)}
                    />
                  ))}
                  {overlayStrokes.map((stroke, index) => (
                    <Path
                      d={annotationStrokeToSvgPath(stroke, naturalSize.width, naturalSize.height)}
                      fill="none"
                      key={`stroke-${index}`}
                      stroke={ANNOTATION_STROKE_COLOR}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={overlayStrokeWidth}
                    />
                  ))}
                </Svg>
              </Animated.View>
            ) : null}
          </Animated.View>
        </GestureDetector>
      ) : (
        // 取件中 / 失败分支没有图片手势层,必须自带关闭途径(单击空白处关闭),
        // 否则 iOS 上打开离线图会困在全屏 Modal 里;重试按钮自己消费点击不受影响。
        <Pressable
          accessibilityLabel={t('message.lightbox.closeImage')}
          onPress={onRequestClose}
          style={[styles.pageFill, styles.pageCenter]}
        >
          {layers.showFailure ||
          resolveState?.status === 'error' ||
          resolvedUnsupported ||
          (!retryable && !media.previewable) ? (
            <>
              <Text style={styles.stateText}>
                {t('message.lightbox.loadFailed')}
              </Text>
              {retryable || layers.showFailure ? (
                <Pressable
                  accessibilityLabel={t('message.lightbox.retryLoadImage')}
                  accessibilityRole="button"
                  onPress={(event) => {
                    event.stopPropagation();
                    if (retryable) onRetry(image);
                    else {
                      // 清掉失败态后重新挂载 Image,原 URI 原地重试,不改签名 URL。
                      setFailedFullUri(null);
                      setLoadedUri(null);
                    }
                  }}
                  style={styles.retryButton}
                  testID="message.imageLightboxRetryButton"
                >
                  <Text style={styles.retryText}>
                    {t('message.lightbox.retry')}
                  </Text>
                </Pressable>
              ) : null}
            </>
          ) : (
            <>
              {layers.showPreview && previewUri ? (
                // 取件在途时垫列表缩略图(静态 contain,无缩放手势,点击仍由外层
                // Pressable 单击关闭接管):首开不黑屏,原图到达切上面手势分支时
                // 那边继续垫同一张图,两段之间不留空档。
                <Animated.Image
                  // 同上:垫底失败要退回 spinner,不能让取件在途这段变成纯黑。
                  onError={() => setFailedPreviewUri(previewUri)}
                  resizeMode="contain"
                  source={{ uri: previewUri }}
                  style={StyleSheet.absoluteFill}
                  testID="message.imageLightboxPreviewLayer"
                />
              ) : null}
              {layers.showSpinner ? (
                <ActivityIndicator color="#ffffff" testID="message.imageLightboxLoading" />
              ) : null}
            </>
          )}
        </Pressable>
      )}
    </View>
  );
});

const absoluteFill = { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 } as const;

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { backgroundColor: '#000000', ...absoluteFill },
  chrome: { ...absoluteFill, alignItems: 'center' },
  closeButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: radius.pill,
    height: 48,
    justifyContent: 'center',
    left: 16,
    position: 'absolute',
    width: 48,
  },
  pageFill: { flex: 1, height: '100%', width: '100%' },
  pageCenter: { alignItems: 'center', gap: 16, justifyContent: 'center' },
  // 垫底缩略图 / 转圈都脱离 flex 流:与原图同为 flex 子节点会被各分一半高度。
  pagePreviewLayer: { ...absoluteFill },
  pageSpinnerLayer: { ...absoluteFill, alignItems: 'center', justifyContent: 'center' },
  pageLabel: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: typeScale.footnote,
    fontVariant: ['tabular-nums'],
  },
  fileHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    width: '100%',
  },
  fileHeaderDone: { color: '#ffffff', fontSize: typeScale.bodyLarge, fontWeight: fontWeight.semibold },
  fileHeaderTitleCol: { alignItems: 'center', flex: 1, gap: 2, minWidth: 0 },
  fileHeaderTitle: { color: '#ffffff', fontSize: typeScale.body, fontWeight: fontWeight.semibold },
  fileHeaderMeta: { color: 'rgba(255,255,255,0.64)', fontSize: typeScale.caption },
  fileHeaderShareSpacer: { width: 20 },
  actionBar: {
    alignItems: 'center',
    paddingHorizontal: 16,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  // 胶囊底(对齐桌面 LightboxToolbar:黑色半透明 + 白描边 + backdrop 感):
  // 按钮不再裸浮在图片上,图片内容再花也不与工具栏图标混叠。
  actionBarPill: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderColor: 'rgba(255, 255, 255, 0.22)',
    borderRadius: radius.pill, // 胶囊语义用 pill(RN 截半)
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    maxWidth: '100%',
    gap: 16,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  actionItem: {
    alignItems: 'center',
    flexShrink: 1,
    gap: 4,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 48,
  },
  actionLabel: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: typeScale.micro,
    textAlign: 'center',
  },
  actionDivider: {
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    height: 22,
    width: StyleSheet.hairlineWidth,
  },
  actionLabelDisabled: { color: 'rgba(255,255,255,0.35)' },
  stateText: { color: 'rgba(255, 255, 255, 0.85)', fontSize: typeScale.code },
  retryButton: {
    borderColor: 'rgba(255, 255, 255, 0.5)',
    borderRadius: radius.pill, // 圆形按钮语义用 pill(胶囊,RN 截半)

    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  retryText: { color: '#ffffff', fontSize: typeScale.code },
});
