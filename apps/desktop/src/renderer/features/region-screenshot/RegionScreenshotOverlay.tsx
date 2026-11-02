import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';

import i18n from '@/i18n';
import { getInitialThemeVariant } from '@/hooks/useTheme';
import { themeService } from '@/themes/theme-service';
import {
  clampIntoArea,
  isRegionArrowKey,
  moveRegion,
  normalizeRegionSelection,
  nudgeRegion,
  rectContains,
  rectFromDrag,
  regionHandleAt,
  regionSelectionToImageCrop,
  resizeRegion,
  sameRegion,
  snapCandidates,
  topWindowAt,
  type RegionHandle,
  type RegionPoint,
  type RegionRect,
  type RegionScreenshotAction,
  type RegionScreenshotBegin,
  type RegionScreenshotBitmap,
  type RegionScreenshotWindow,
  type RegionScreenshotHit,
  intersectRegion,
  type RegionSize,
} from '../../../shared/regionScreenshot';
import {
  annotationAt,
  annotationBounds,
  constrainShape,
  DEFAULT_ANNOTATION_COLOR,
  DEFAULT_MARKER_COLOR,
  drawAnnotations,
  isMeaningfulAnnotation,
  moveAnnotation,
  nextStepNumber,
  TEXT_LINE_HEIGHT,
  TEXT_SIZE,
  textBounds,
  textFont,
  type Annotation,
  type AnnotationSize,
  type AnnotationSource,
  type AnnotationTool,
  type ShapeAnnotation,
  type TextAnnotation,
} from './annotations';
import { bitmapToImageData, cropOpaqueImageDataToBitmap, imageDataToBitmap, type RegionScreenshotOverlayBridge } from './bridge';
import { colorHex, colorRgb, Magnifier, type PixelColor } from './Magnifier';
import { ScreenshotModeBar, ScreenshotStyleBar, ScreenshotToolbar, TOOL_SHORTCUTS, type ScreenshotMode } from './ScreenshotToolbar';
import { SCREENSHOT_INK, SCREENSHOT_OVERLAY, type ScreenshotInk } from './screenshotColors';
import { LiveCapturePanel } from './LiveCapturePanel';
import { ScrollCaptureOverlay } from './ScrollCaptureOverlay';
import { ScreenshotEditorViewport } from './ScreenshotEditorViewport';
import { isPreciseWheel, WHEEL_GESTURE_GAP_MS } from './trackpad';
import type { RegionCaptureBegin, RegionCaptureMode } from '../../../shared/regionCapture';

/** 小于这个尺寸的拖动视为误点, 不形成选区。 */
const MIN_SELECTION = 4;
/** 按下后移动超过这个距离才算拖动 (否则是单击选中吸附区域)。 */
const DRAG_THRESHOLD = 3;
const HANDLE_TOLERANCE = 6;
const GAP = 8;
/** 触控板一次滑动会产生很多滚轮事件, 累计到这个量才切换一级。 */
const WHEEL_STEP = 60;

interface ActiveSession {
  token: string;
  scaleFactor: number;
  viewport: RegionSize;
  windows: RegionScreenshotWindow[];
  lastRegion: RegionRect | null;
  frameSize: RegionSize;
  frameData: ImageData;
  /** 界面元素可用区域: 避开菜单栏、刘海与 Dock / 任务栏。 */
  safeArea: RegionRect;
}

type Drag =
  | { kind: 'select'; anchor: RegionPoint; moved: boolean }
  | { kind: 'move'; start: RegionRect; origin: RegionPoint }
  | { kind: 'resize'; start: RegionRect; handle: RegionHandle }
  | { kind: 'draw'; origin: RegionPoint }
  | { kind: 'move-annotation'; original: Annotation; origin: RegionPoint; moved: boolean };

interface ToolStyle {
  color: ScreenshotInk;
  size: AnnotationSize;
}

interface Editing {
  /** 正在改的已有文字标注; 新建时为 null。 */
  id: string | null;
  at: RegionPoint;
  color: ScreenshotInk;
  size: AnnotationSize;
  text: string;
}

const defaultStyles = (): Record<AnnotationTool, ToolStyle> => ({
  rect: { color: DEFAULT_ANNOTATION_COLOR, size: 1 },
  ellipse: { color: DEFAULT_ANNOTATION_COLOR, size: 1 },
  line: { color: DEFAULT_ANNOTATION_COLOR, size: 1 },
  arrow: { color: DEFAULT_ANNOTATION_COLOR, size: 1 },
  pen: { color: DEFAULT_ANNOTATION_COLOR, size: 1 },
  marker: { color: DEFAULT_MARKER_COLOR, size: 1 },
  text: { color: DEFAULT_ANNOTATION_COLOR, size: 1 },
  mosaic: { color: DEFAULT_ANNOTATION_COLOR, size: 1 },
  blur: { color: DEFAULT_ANNOTATION_COLOR, size: 1 },
  step: { color: DEFAULT_ANNOTATION_COLOR, size: 1 },
});

const HANDLE_CURSORS: Record<RegionHandle, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

const HANDLES: RegionHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const TOOL_BY_KEY = Object.fromEntries(
  Object.entries(TOOL_SHORTCUTS).map(([tool, key]) => [key.toLowerCase(), tool as AnnotationTool]),
);

let idSeed = 0;
const nextId = () => `a${++idSeed}`;

function handlePosition(rect: RegionRect, handle: RegionHandle): RegionPoint {
  const x = handle.includes('w') ? rect.x : handle.includes('e') ? rect.x + rect.width : rect.x + rect.width / 2;
  const y = handle.includes('n') ? rect.y : handle.includes('s') ? rect.y + rect.height : rect.y + rect.height / 2;
  return { x, y };
}

/**
 * 框选浮层。每块显示器一个, 预热后隐藏复用: BEGIN 时绘制定格画面并清空交互态,
 * END 时清空画面与全部状态。
 *
 * 选区描边、暗化遮罩、手柄与选中标注的虚线框是覆盖在任意屏幕内容上的功能像素,
 * 两种模式取同一值 (白描边 + 暗色外圈); 工具条、放大镜、尺寸标签等界面 chrome
 * 一律走主题 token, 跟随 Cindy 的浅色 / 深色模式。
 */
export function RegionScreenshotOverlay({ bridge, imageEditor = false }: { bridge: RegionScreenshotOverlayBridge; imageEditor?: boolean }) {
  const { t } = useTranslation();
  const isMac = window.electronAPI?.platform === 'darwin';
  const modLabel = isMac ? '⌘' : 'Ctrl+';
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLCanvasElement>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  const [session, setSession] = useState<ActiveSession | null>(null);
  const [activeDisplay, setActiveDisplay] = useState(false);
  const [modeBarCenter, setModeBarCenter] = useState<number | null>(null);
  const [live, setLive] = useState<RegionCaptureBegin | null>(null);
  const [liveError, setLiveError] = useState(false);
  const [captureMode, setCaptureMode] = useState<ScreenshotMode>('image');
  const [recordingFormat, setRecordingFormat] = useState<'video' | 'gif'>('video');
  const liveRef = useRef(false);
  const [longResult, setLongResult] = useState<{ image: RegionScreenshotBitmap; selection: RegionRect } | null>(null);
  const longResultRef = useRef(longResult);
  longResultRef.current = longResult;
  const [selection, setSelection] = useState<RegionRect | null>(null);
  const [hover, setHover] = useState<{ candidates: RegionRect[]; level: number; defaultRect: RegionRect } | null>(null);
  const [pointer, setPointer] = useState<RegionPoint | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [tool, setTool] = useState<AnnotationTool | null>(null);
  const [styles, setStyles] = useState(defaultStyles);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [undoStack, setUndoStack] = useState<Annotation[][]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[][]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [toolbarSize, setToolbarSize] = useState<RegionSize>({ width: 640, height: 38 });
  const [overToolbar, setOverToolbar] = useState(false);

  // 事件处理里读最新值, 避免每次渲染重新绑定全局监听。
  const state = useRef({
    session,
    selection,
    hover,
    pointer,
    drag,
    tool,
    styles,
    annotations,
    undoStack,
    redoStack,
    draft,
    selectedId,
    editing,
    aiMenuOpen,
    captureMode,
  });
  state.current = {
    session,
    selection,
    hover,
    pointer,
    drag,
    tool,
    styles,
    annotations,
    undoStack,
    redoStack,
    draft,
    selectedId,
    editing,
    aiMenuOpen,
    captureMode,
  };
  const busyRef = useRef(false);
  /** BEGIN 带来的鼠标位置, 会话状态生效后立即据此吸附 (见下方 effect)。 */
  const initialCursorRef = useRef<RegionPoint | null>(null);
  const wheelRef = useRef(0);
  /** 触控板一次滑动 (含惯性) 只切换一级吸附层级。 */
  const wheelGestureRef = useRef({ last: 0, stepped: false });
  const elementsRef = useRef<{
    inFlight: boolean;
    pending: RegionPoint | null;
    cache: { point: RegionPoint; hit: RegionScreenshotHit } | null;
    defaults: Map<number, RegionRect[]>;
  }>({ inFlight: false, pending: null, cache: null, defaults: new Map() });

  const viewport = session?.viewport ?? { width: window.innerWidth, height: window.innerHeight };
  const safe = session?.safeArea ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const isSelected = selection !== null && (drag === null || drag.kind !== 'select');

  // ── 会话生命周期 ─────────────────────────────────────────────────────────

  const resetInteraction = useCallback(() => {
    setLive(null);
    setCaptureMode('image');
    setRecordingFormat('video');
    setModeBarCenter(null);
    setLongResult(null);
    longResultRef.current = null;
    liveRef.current = false;
    setLiveError(false);
    setSelection(null);
    setHover(null);
    setPointer(null);
    setDrag(null);
    setTool(null);
    setAnnotations([]);
    setUndoStack([]);
    setRedoStack([]);
    setDraft(null);
    setSelectedId(null);
    setEditing(null);
    setAiMenuOpen(false);
    setOverToolbar(false);
    busyRef.current = false;
    wheelRef.current = 0;
    elementsRef.current = { inFlight: false, pending: null, cache: null, defaults: new Map() };
  }, []);

  useEffect(() => {
    const offBegin = bridge.onBegin((payload: RegionScreenshotBegin) => {
      if (payload.locale && i18n.language !== payload.locale) void i18n.changeLanguage(payload.locale);
      // 隐藏期间用户可能改了主题; 每次截图按当前设置重新套用。
      themeService.applyTheme(getInitialThemeVariant().theme);
      resetInteraction();
      setActiveDisplay(imageEditor || payload.cursor !== null);
      if (imageEditor) {
        setLongResult({ image: payload.frame, selection: payload.lastRegion! });
        setSelection({ x: 0, y: 0, width: payload.frame.width, height: payload.frame.height });
      }
      initialCursorRef.current = payload.cursor ?? null;
      // 各工具上次用的颜色 / 粗细跨截图保留 (浮层复用, 本次运行内有效)。
      const frameData = bitmapToImageData(payload.frame);
      // The layout effect writes the frozen frame once after React has mounted
      // its canvas (including the independent editor's first image).
      setSession({
        token: payload.token,
        scaleFactor: payload.scaleFactor,
        viewport: payload.viewport,
        windows: payload.windows,
        lastRegion: payload.lastRegion,
        frameSize: { width: payload.frame.width, height: payload.frame.height },
        frameData,
        safeArea: payload.safeArea ?? { x: 0, y: 0, width: payload.viewport.width, height: payload.viewport.height },
      });
      // 窗口显示后才会合成新帧: 等两帧再报告已绘制, main 随即淡入。
      if (!imageEditor) requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          bridge.painted(payload.token);
          if (document.hasFocus()) bridge.focused(payload.token);
        }),
      );
    });
    const offEnd = bridge.onEnd(() => {
      resetInteraction();
      setActiveDisplay(false);
      setSession(null);
      const canvas = frameRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    const offClear = bridge.onClear(() => {
      setSelection(null);
      setTool(null);
      setAnnotations([]);
      setUndoStack([]);
      setRedoStack([]);
      setDraft(null);
      setSelectedId(null);
      setEditing(null);
      setAiMenuOpen(false);
    });
    const onFocus = () => {
      const current = state.current.session;
      if (current) bridge.focused(current.token);
    };
    const onBlur = () => setAiMenuOpen(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    // 重新挂载 (热更新 / 错误边界重建) 时可能正处在一次截图中: 本页已没有会话状态,
    // 请 main 结束它, 避免留下一块无法退出的黑屏。首次挂载时没有会话, main 忽略。
    bridge.abandon();
    bridge.shellReady();
    return () => {
      offBegin();
      offEnd();
      offClear();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, [bridge, resetInteraction, imageEditor]);

  useLayoutEffect(() => {
    const canvas = frameRef.current;
    if (!canvas || !session || live) return;
    canvas.width = session.frameData.width;
    canvas.height = session.frameData.height;
    canvas.getContext('2d')?.putImageData(session.frameData, 0, 0);
    if (imageEditor) bridge.painted(session.token);
  }, [session, live, longResult, bridge, imageEditor]);

  // ── 标注图层 ───────────────────────────────────────────────────────────

  const annotationSource = useCallback((): AnnotationSource | null => {
    const frame = frameRef.current;
    const current = state.current.session;
    if (!frame || !current) return null;
    const rect = state.current.selection;
    if (longResultRef.current && rect) return {
      frame, ratioX: frame.width / rect.width, ratioY: frame.height / rect.height,
      offsetX: rect.x, offsetY: rect.y,
    };
    return {
      frame,
      ratioX: current.frameSize.width / current.viewport.width,
      ratioY: current.frameSize.height / current.viewport.height,
    };
  }, []);

  useEffect(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas) return;
    const dpr = imageEditor ? 1 : window.devicePixelRatio || 1;
    const width = Math.round(viewport.width * dpr);
    const height = Math.round(viewport.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const source = annotationSource();
    if (!source) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const visible = annotations.filter((a) => !(editing?.id && a.id === editing.id));
    drawAnnotations(ctx, draft ? [...visible, draft] : visible, source);
  }, [annotations, draft, editing?.id, viewport.width, viewport.height, annotationSource, session, imageEditor]);

  // ── 撤销 / 重做 ────────────────────────────────────────────────────────

  const commitAnnotations = useCallback((next: Annotation[]) => {
    const { annotations: previous, undoStack: stack } = state.current;
    const nextStack = [...stack, previous];
    setUndoStack(nextStack);
    setRedoStack([]);
    setAnnotations(next);
    state.current.annotations = next;
    state.current.undoStack = nextStack;
    state.current.redoStack = [];
  }, []);

  const undo = useCallback(() => {
    const { undoStack: stack, redoStack: redoList, annotations: list } = state.current;
    if (stack.length === 0) return;
    setUndoStack(stack.slice(0, -1));
    setRedoStack([...redoList, list]);
    setAnnotations(stack[stack.length - 1]);
    setSelectedId(null);
  }, []);

  const redo = useCallback(() => {
    const { undoStack: stack, redoStack: redoList, annotations: list } = state.current;
    if (redoList.length === 0) return;
    setRedoStack(redoList.slice(0, -1));
    setUndoStack([...stack, list]);
    setAnnotations(redoList[redoList.length - 1]);
    setSelectedId(null);
  }, []);

  /** 结束文字编辑, 返回提交后的标注列表 (导出时同步拿到最新结果)。 */
  const commitEditing = useCallback((): Annotation[] => {
    const current = state.current.editing;
    const list = state.current.annotations;
    if (!current) return list;
    setEditing(null);
    state.current.editing = null;
    const text = current.text.replace(/\s+$/, '');
    const existing = current.id ? list.find((a) => a.id === current.id) : undefined;
    let next: Annotation[] | null = null;
    if (existing && existing.kind === 'text') {
      if (!text) next = list.filter((a) => a.id !== existing.id);
      else if (text !== existing.text || current.color !== existing.color || current.size !== existing.size)
        next = list.map((a) =>
          a.id === existing.id ? { ...existing, text, color: current.color, size: current.size } : a,
        );
    } else if (text) {
      const created: TextAnnotation = {
        id: nextId(),
        kind: 'text',
        at: current.at,
        text,
        color: current.color,
        size: current.size,
      };
      next = [...list, created];
    }
    if (next) commitAnnotations(next);
    return next ?? list;
  }, [commitAnnotations]);

  // ── 吸附候选 ───────────────────────────────────────────────────────────

  const refreshHover = useCallback((point: RegionPoint) => {
    const current = state.current.session;
    if (!current) return;
    const cache = elementsRef.current.cache;
    // A parent rectangle containing a new point does not prove that its old
    // element chain (or the window under a transparent pixel) is still valid.
    const hit = cache && cache.point.x === point.x && cache.point.y === point.y ? cache.hit : null;
    const rectangularWindow = topWindowAt(current.windows, point);
    // Keep a corrected target (including an explicit null for an unknown
    // occluder) while this point is pending under the same captured front window.
    // This is only a display fallback: requestElements still queries the new
    // point, and its reply is authoritative. Leaving a known corrected target's
    // bounds or entering a different front window ends retention immediately.
    const pendingHit = !hit && cache && rectangularWindow
      && cache.hit.window?.id !== rectangularWindow.id
      && topWindowAt(current.windows, cache.point)?.id === rectangularWindow.id
      && (!cache.hit.window || rectContains(cache.hit.window.rect, point)) ? cache.hit : null;
    const window = hit ? hit.window : pendingHit ? pendingHit.window : rectangularWindow;
    const snapshot = current.windows.find((candidate) => candidate.id === window?.id);
    // Default regions belong to the frozen capture, not a point query. UIA may
    // finish later or fail without making the outline bounce back to the window.
    // Older helpers/macOS can retain a known content region while a new query is
    // pending, but never reuse its fine element chain at a different point.
    const remembered = window && elementsRef.current.defaults.get(window.id)?.find((rect) => rectContains(rect, point));
    const native = snapshot?.snapRects?.find((rect) => rectContains(rect, point));
    const preferred = native && window && !sameRegion(native, window.rect) ? native
      : remembered ?? hit?.preferredRect
        ?? (snapshot?.snapRects ? window?.rect : undefined);
    const elements = [...(hit?.rects ?? []), ...(snapshot?.snapRects ?? []), ...(preferred ? [preferred] : [])]
      .sort((a, b) => a.width * a.height - b.width * b.height);
    const candidates = snapCandidates(point, window, elements, current.viewport);
    const clipped = preferred && intersectRegion(preferred, current.viewport);
    const defaultLevel = clipped ? Math.max(0, candidates.findIndex((rect) => sameRegion(rect, clipped))) : 0;
    const defaultRect = candidates[defaultLevel];
    setHover((previous) => {
      const selected = previous && sameRegion(previous.defaultRect, defaultRect)
        ? candidates.findIndex((rect) => sameRegion(rect, previous.candidates[previous.level])) : -1;
      const level = selected >= 0 ? selected : defaultLevel;
      const keep = previous && previous.level === level && previous.candidates.length === candidates.length
        && previous.candidates.every((rect, index) => sameRegion(rect, candidates[index]));
      return keep && sameRegion(previous.defaultRect, defaultRect) ? previous : { candidates, level, defaultRect };
    });
  }, []);

  const requestElements = useCallback(
    (point: RegionPoint) => {
      const current = state.current.session;
      if (!current) return;
      const window = topWindowAt(current.windows, point);
      if (!window) return;
      const tracker = elementsRef.current;
      if (tracker.inFlight) {
        tracker.pending = point;
        return;
      }
      tracker.inFlight = true;
      void bridge
        .elementsAt(current.token, window.id, point.x, point.y)
        .then((hit) => {
          if (state.current.session?.token !== current.token || elementsRef.current !== tracker || !hit) return;
          const latest = state.current.pointer;
          if (latest && latest.x === point.x && latest.y === point.y && !state.current.selection && !state.current.drag) {
            // Some browsers have no content HWND. Learn their document regions
            // once per capture; an empty/partial UIA reply must not erase them.
            if (hit.window && hit.preferredRect && !sameRegion(hit.preferredRect, hit.window.rect)) {
              const regions = tracker.defaults.get(hit.window.id) ?? [];
              if (regions.length < 256 && !regions.some((rect) => sameRegion(rect, hit.preferredRect!))) {
                tracker.defaults.set(hit.window.id, [...regions, hit.preferredRect]
                  .sort((a, b) => a.width * a.height - b.width * b.height));
              }
            }
            tracker.cache = { point, hit };
            refreshHover(latest);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          tracker.inFlight = false;
          const pending = tracker.pending;
          tracker.pending = null;
          if (pending && elementsRef.current === tracker && state.current.session?.token === current.token && !state.current.selection) {
            requestElements(pending);
          }
        });
    },
    [bridge, refreshHover],
  );

  // 鼠标不动也要立刻高亮指针下的窗口 / 元素: 不等第一次 pointermove。
  useEffect(() => {
    const cursor = initialCursorRef.current;
    if (!session || !cursor) return;
    initialCursorRef.current = null;
    setPointer(cursor);
    state.current.pointer = cursor;
    refreshHover(cursor);
    requestElements(cursor);
  }, [session, refreshHover, requestElements]);

  // ── 导出 ───────────────────────────────────────────────────────────────

  const runAction = useCallback(
    async (action: RegionScreenshotAction) => {
      const current = state.current.session;
      const rect = state.current.selection;
      const frame = frameRef.current;
      if (!current || !rect || !frame || busyRef.current) return;
      const list = commitEditing();
      const long = longResultRef.current;
      const selected = long?.selection ?? normalizeRegionSelection(rect, current.viewport, current.scaleFactor);
      if (!selected) return;
      const mapped = long ? { crop: { x: 0, y: 0, width: long.image.width, height: long.image.height }, output: { width: long.image.width, height: long.image.height } } : regionSelectionToImageCrop(
        selected,
        current.viewport,
        current.frameSize,
        current.scaleFactor,
      );
      const source = annotationSource();
      if (!mapped || !source) return;
      const { crop, output } = mapped;
      // Unedited, pixel-aligned captures already have their pixels in memory.
      // Avoid an extra canvas backing store and GPU readback. Resizing,
      // annotations and alpha compositing retain the existing canvas path.
      let image = list.length === 0 && crop.width === output.width && crop.height === output.height
        ? cropOpaqueImageDataToBitmap(current.frameData, crop)
        : null;
      if (!image) {
        const canvas = document.createElement('canvas');
        canvas.width = output.width;
        canvas.height = output.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(frame, crop.x, crop.y, crop.width, crop.height, 0, 0, output.width, output.height);
        const sx = output.width / rect.width;
        const sy = output.height / rect.height;
        ctx.setTransform(sx, 0, 0, sy, -rect.x * sx, -rect.y * sy);
        drawAnnotations(ctx, list, source);
        image = imageDataToBitmap(ctx.getImageData(0, 0, output.width, output.height));
      }
      busyRef.current = true;
      setAiMenuOpen(false);
      const ok = await bridge
        .exportImage(current.token, { action, selection: selected, image })
        .catch(() => false);
      if (!ok) busyRef.current = false;
    },
    [annotationSource, bridge, commitEditing],
  );

  const cancel = useCallback(() => {
    const current = state.current.session;
    if (current) bridge.cancel(current.token);
  }, [bridge]);

  const selectRegion = useCallback(
    (rect: RegionRect) => {
      const current = state.current.session;
      if (!current) return;
      const normalized = normalizeRegionSelection(rect, current.viewport, current.scaleFactor);
      if (!normalized) return;
      bridge.selectionStarted(current.token);
      setSelection(normalized);
      setHover(null);
    },
    [bridge],
  );

  const colorAt = useCallback((point: RegionPoint | null): PixelColor | null => {
    const current = state.current.session;
    if (!current || !point) return null;
    const { frameData, frameSize, viewport: size } = current;
    const rect = longResultRef.current ? state.current.selection : null;
    if (rect && !rectContains(rect, point)) return null;
    const x = Math.min(frameSize.width - 1, Math.max(0, Math.floor(((point.x - (rect?.x ?? 0)) * frameSize.width) / (rect?.width ?? size.width))));
    const y = Math.min(frameSize.height - 1, Math.max(0, Math.floor(((point.y - (rect?.y ?? 0)) * frameSize.height) / (rect?.height ?? size.height))));
    const index = (y * frameSize.width + x) * 4;
    return { r: frameData.data[index], g: frameData.data[index + 1], b: frameData.data[index + 2] };
  }, []);

  // ── 指针 ───────────────────────────────────────────────────────────────

  const localPoint = (event: { clientX: number; clientY: number }): RegionPoint => {
    const bounds = imageEditor ? rootRef.current?.getBoundingClientRect() : null;
    return {
      x: Math.min(viewport.width, Math.max(0, bounds ? (event.clientX - bounds.left) * viewport.width / bounds.width : event.clientX)),
      y: Math.min(viewport.height, Math.max(0, bounds ? (event.clientY - bounds.top) * viewport.height / bounds.height : event.clientY)),
    };
  };

  const startEditing = (at: RegionPoint, existing: TextAnnotation | null) => {
    const style = state.current.styles.text;
    setSelectedId(null);
    setEditing(
      existing
        ? { id: existing.id, at: existing.at, color: existing.color, size: existing.size, text: existing.text }
        : { id: null, at, color: style.color, size: style.size, text: '' },
    );
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = state.current;
    if (!s.session || busyRef.current) return;
    if (event.button !== 0) return;
    const point = localPoint(event);
    if (s.aiMenuOpen) {
      setAiMenuOpen(false);
      return;
    }
    if (s.editing) {
      commitEditing();
      return;
    }
    rootRef.current?.setPointerCapture(event.pointerId);
    const rect = s.selection;
    if (!rect) {
      setDrag({ kind: 'select', anchor: point, moved: false });
      return;
    }
    const handle = regionHandleAt(rect, point, HANDLE_TOLERANCE);
    if (handle && !longResultRef.current) {
      setDrag({ kind: 'resize', start: rect, handle });
      return;
    }
    const insideSelection = rectContains(rect, point);
    if (!insideSelection) return;
    const hit = annotationAt(s.annotations, point);
    if (s.tool === 'text') {
      startEditing(point, hit && hit.kind === 'text' ? hit : null);
      return;
    }
    // 画笔 / 荧光笔可以直接画在已有标注上; 其它工具点中已有标注时改为选中它。
    if (hit && s.tool !== 'pen' && s.tool !== 'marker') {
      setSelectedId(hit.id);
      setDrag({ kind: 'move-annotation', original: hit, origin: point, moved: false });
      return;
    }
    setSelectedId(null);
    if (s.tool === 'step') {
      const style = s.styles.step;
      commitAnnotations([
        ...s.annotations,
        { id: nextId(), kind: 'step', at: point, number: nextStepNumber(s.annotations), ...style },
      ]);
      return;
    }
    if (s.tool) {
      const style = s.styles[s.tool];
      const created: Annotation =
        s.tool === 'pen' || s.tool === 'marker'
          ? { id: nextId(), kind: s.tool, points: [point], ...style }
          : { id: nextId(), kind: s.tool as ShapeAnnotation['kind'], from: point, to: point, ...style };
      setDraft(created);
      setDrag({ kind: 'draw', origin: point });
      return;
    }
    if (!longResultRef.current) setDrag({ kind: 'move', start: rect, origin: point });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = state.current;
    if (!s.session) return;
    const point = localPoint(event);
    setPointer(point);
    state.current.pointer = point;
    const current = s.drag;
    if (!current) {
      if (!s.selection) {
        refreshHover(point);
        requestElements(point);
      }
      return;
    }
    switch (current.kind) {
      case 'select': {
        const moved =
          current.moved ||
          Math.hypot(point.x - current.anchor.x, point.y - current.anchor.y) > DRAG_THRESHOLD;
        if (!moved) return;
        if (!current.moved) {
          bridge.selectionStarted(s.session.token);
          setDrag({ ...current, moved: true });
        }
        setSelection(rectFromDrag(current.anchor, point, s.session.viewport, event.shiftKey));
        return;
      }
      case 'move':
        setSelection(
          moveRegion(current.start, point.x - current.origin.x, point.y - current.origin.y, s.session.viewport),
        );
        return;
      case 'resize':
        setSelection(resizeRegion(current.start, current.handle, point, s.session.viewport, event.shiftKey));
        return;
      case 'draw': {
        const active = s.draft;
        if (!active) return;
        if ('points' in active) {
          const last = active.points[active.points.length - 1];
          if (Math.hypot(point.x - last.x, point.y - last.y) < 1.5) return;
          setDraft({ ...active, points: [...active.points, point] });
        } else if ('from' in active) {
          const to = event.shiftKey ? constrainShape(active.kind, active.from, point) : point;
          setDraft({ ...active, to });
        }
        return;
      }
      case 'move-annotation': {
        const dx = point.x - current.origin.x;
        const dy = point.y - current.origin.y;
        if (!current.moved && Math.hypot(dx, dy) < 2) return;
        if (!current.moved) setDrag({ ...current, moved: true });
        const moved = moveAnnotation(current.original, dx, dy);
        setAnnotations((list) => list.map((a) => (a.id === moved.id ? moved : a)));
        return;
      }
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = state.current;
    const current = s.drag;
    if (rootRef.current?.hasPointerCapture(event.pointerId)) {
      rootRef.current.releasePointerCapture(event.pointerId);
    }
    if (!current || !s.session) return;
    setDrag(null);
    switch (current.kind) {
      case 'select': {
        if (!current.moved) {
          // 单击: 选中当前吸附的窗口 / 元素。
          const target = s.hover?.candidates[s.hover.level];
          if (target) selectRegion(target);
          return;
        }
        const rect = s.selection;
        if (!rect || rect.width < MIN_SELECTION || rect.height < MIN_SELECTION) {
          setSelection(null);
          refreshHover(localPoint(event));
          return;
        }
        setSelection(normalizeRegionSelection(rect, s.session.viewport, s.session.scaleFactor));
        return;
      }
      case 'move':
      case 'resize': {
        const rect = s.selection;
        const normalized =
          rect && normalizeRegionSelection(rect, s.session.viewport, s.session.scaleFactor);
        if (normalized && normalized.width >= 1 && normalized.height >= 1) setSelection(normalized);
        else setSelection(current.start);
        return;
      }
      case 'draw': {
        const active = s.draft;
        setDraft(null);
        if (active && isMeaningfulAnnotation(active)) commitAnnotations([...s.annotations, active]);
        return;
      }
      case 'move-annotation': {
        if (!current.moved) return;
        // 拖动过程中已经改了列表; 撤销点记在拖动前。
        const before = s.annotations.map((a) => (a.id === current.original.id ? current.original : a));
        setUndoStack([...s.undoStack, before]);
        setRedoStack([]);
        return;
      }
    }
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const s = state.current;
    if (!s.session || s.selection || s.drag) return;
    const gesture = wheelGestureRef.current;
    const precise = isPreciseWheel(event.nativeEvent);
    if (precise) {
      if (event.timeStamp - gesture.last > WHEEL_GESTURE_GAP_MS) {
        gesture.stepped = false;
        wheelRef.current = 0;
      }
      gesture.last = event.timeStamp;
      if (gesture.stepped) return;
    }
    wheelRef.current += event.deltaY;
    if (Math.abs(wheelRef.current) < WHEEL_STEP) return;
    const step = wheelRef.current < 0 ? 1 : -1;
    wheelRef.current = 0;
    if (precise) gesture.stepped = true;
    // 向上滚 = 扩大到外层 (父元素 / 窗口 / 整屏), 向下滚 = 回到内层。
    setHover((previous) =>
      previous
        ? {
            ...previous,
            level: Math.max(0, Math.min(previous.candidates.length - 1, previous.level + step)),
          }
        : previous,
    );
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const s = state.current;
    if (!s.selection || s.editing || s.captureMode !== 'image') return;
    const point = localPoint(event);
    const hit = annotationAt(s.annotations, point);
    if (hit?.kind === 'text') {
      startEditing(point, hit);
      return;
    }
    if (!s.tool && rectContains(s.selection, point)) void runAction('copy');
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const s = state.current;
    if (!s.session) {
      bridge.abandon();
      return;
    }
    if (s.editing) {
      setEditing(null);
      return;
    }
    if (s.aiMenuOpen) {
      setAiMenuOpen(false);
      return;
    }
    if (s.selection && !longResultRef.current) {
      // 右键: 先退回框选 (丢弃选区与标注), 没有选区时退出截图。
      setSelection(null);
      setTool(null);
      setAnnotations([]);
      setUndoStack([]);
      setRedoStack([]);
      setSelectedId(null);
      refreshHover(localPoint(event));
      return;
    }
    if (!imageEditor) cancel();
  };

  // ── 键盘 ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (liveRef.current) {
        if (event.key === 'Escape' && !event.isComposing) {
          event.preventDefault();
          const token = state.current.session?.token;
          if (token) bridge.cancel(token);
        }
        return;
      }
      const s = state.current;
      // 页面没有会话却被看见 (异常状态): Esc 仍然要能退出。
      if (!s.session && event.key === 'Escape') {
        bridge.abandon();
        return;
      }
      if (!s.session || busyRef.current) return;
      const mod = isMac ? event.metaKey : event.ctrlKey;
      const key = event.key;
      if (s.editing) {
        if (key === 'Escape' || (key === 'Enter' && mod)) {
          event.preventDefault();
          commitEditing();
        }
        return;
      }
      if (key === 'Escape') {
        event.preventDefault();
        if (s.aiMenuOpen) setAiMenuOpen(false);
        else cancel();
        return;
      }
      const rect = s.selection;
      if (!rect) {
        if (key === ' ') {
          event.preventDefault();
          selectRegion({ x: 0, y: 0, ...s.session.viewport });
        } else if (key.toLowerCase() === 'r' && !mod && s.session.lastRegion) {
          event.preventDefault();
          selectRegion(s.session.lastRegion);
        } else if (key.toLowerCase() === 'c' && !mod) {
          const color = colorAt(s.pointer);
          if (color) bridge.copyText(s.session.token, event.shiftKey ? colorRgb(color) : colorHex(color));
        } else if (key === 'Enter') {
          const target = s.hover?.candidates[s.hover.level];
          if (target) selectRegion(target);
        }
        return;
      }
      if (mod && key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (s.captureMode !== 'image' && !isRegionArrowKey(key)) return;
      if (key === 'Enter' || (mod && key.toLowerCase() === 'c')) {
        event.preventDefault();
        void runAction('copy');
        return;
      }
      if (mod && key.toLowerCase() === 's') {
        event.preventDefault();
        void runAction('save');
        return;
      }
      if (mod && key.toLowerCase() === 't') {
        event.preventDefault();
        void runAction('pin');
        return;
      }
      if ((key === 'Delete' || key === 'Backspace') && s.selectedId) {
        event.preventDefault();
        commitAnnotations(s.annotations.filter((a) => a.id !== s.selectedId));
        setSelectedId(null);
        return;
      }
      if (isRegionArrowKey(key)) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1 / s.session.scaleFactor;
        const selectedAnnotation = s.selectedId
          ? s.annotations.find((a) => a.id === s.selectedId)
          : undefined;
        if (selectedAnnotation) {
          const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
          const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
          const moved = moveAnnotation(selectedAnnotation, dx, dy);
          commitAnnotations(s.annotations.map((a) => (a.id === moved.id ? moved : a)));
          return;
        }
        if (!longResultRef.current) setSelection(nudgeRegion(rect, key, step, s.session.viewport, event.altKey));
        return;
      }
      if (!mod && !event.altKey && key.length === 1) {
        const next = TOOL_BY_KEY[key.toLowerCase()];
        if (next) {
          event.preventDefault();
          setTool((currentTool) => (currentTool === next ? null : next));
          setSelectedId(null);
          return;
        }
        if (key.toLowerCase() === 'c') {
          const color = colorAt(s.pointer);
          if (color) bridge.copyText(s.session.token, event.shiftKey ? colorRgb(color) : colorHex(color));
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bridge, cancel, colorAt, commitAnnotations, commitEditing, isMac, redo, runAction, selectRegion, undo]);

  // 编辑文字时把焦点交给输入框。
  useEffect(() => {
    if (editing) textAreaRef.current?.focus();
  }, [editing?.id, editing?.at.x, editing?.at.y]);

  // 工具条按实际尺寸摆放。
  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element) return;
    const { offsetWidth: width, offsetHeight: height } = element;
    if (width !== toolbarSize.width || height !== toolbarSize.height) setToolbarSize({ width, height });
  });

  // ── 样式 ───────────────────────────────────────────────────────────────

  const selectedAnnotation = selectedId ? annotations.find((a) => a.id === selectedId) ?? null : null;
  const styleTool: AnnotationTool | null = editing
    ? 'text'
    : selectedAnnotation
      ? selectedAnnotation.kind
      : tool;
  const activeStyle: ToolStyle | null = editing
    ? { color: editing.color, size: editing.size }
    : selectedAnnotation
      ? { color: selectedAnnotation.color, size: selectedAnnotation.size }
      : tool
        ? styles[tool]
        : null;

  const applyStyle = (patch: Partial<ToolStyle>) => {
    if (!styleTool) return;
    setStyles((previous) => ({ ...previous, [styleTool]: { ...previous[styleTool], ...patch } }));
    if (editing) {
      setEditing({ ...editing, ...patch });
      return;
    }
    if (selectedAnnotation) {
      commitAnnotations(
        annotations.map((a) => (a.id === selectedAnnotation.id ? ({ ...a, ...patch } as Annotation) : a)),
      );
    }
  };

  // ── 渲染 ───────────────────────────────────────────────────────────────

  const highlight = selection ?? (hover ? hover.candidates[hover.level] ?? null : null);
  const scale = session?.scaleFactor ?? 1;
  const dragging = drag !== null && drag.kind !== 'move-annotation' && drag.kind !== 'draw';

  let cursor = 'crosshair';
  if (pointer && selection && !drag) {
    const handle = longResult ? null : regionHandleAt(selection, pointer, HANDLE_TOLERANCE);
    if (handle) cursor = HANDLE_CURSORS[handle];
    else if (rectContains(selection, pointer)) {
      if (tool === 'text') cursor = 'text';
      else if (annotationAt(annotations, pointer)) cursor = 'move';
      else cursor = tool ? 'crosshair' : longResult ? 'default' : 'move';
    } else cursor = 'default';
  } else if (drag?.kind === 'resize') cursor = HANDLE_CURSORS[drag.handle];
  else if (drag?.kind === 'move' || drag?.kind === 'move-annotation') cursor = 'move';

  const showMagnifier =
    !!session && !longResult && !!pointer && !overToolbar && !editing && (!selection || dragging) && drag?.kind !== 'move';

  let toolbarStyle: CSSProperties | null = null;

  if (isSelected && selection && !dragging) {
    // 工具条只放在安全区内: 不被刘海遮住, 也不压在 Dock / 任务栏上; 选区本身可以覆盖它们。
    const bottom = selection.y + selection.height;
    const safeBottom = safe.y + safe.height;
    const extra = styleTool ? toolbarSize.height + GAP : 0;
    const below = bottom + GAP + toolbarSize.height + extra <= safeBottom;
    const above = selection.y - GAP - toolbarSize.height - extra >= safe.y;
    const top = below
      ? bottom + GAP
      : above
        ? selection.y - GAP - toolbarSize.height
        : Math.min(bottom, safeBottom) - GAP - toolbarSize.height;
    const position = clampIntoArea({ x: selection.x + selection.width - toolbarSize.width, y: top }, toolbarSize, safe);
    toolbarStyle = { left: position.x, top: position.y };
  }

  const sizeLabel = longResult ? `${longResult.image.width} × ${longResult.image.height}` : highlight
    ? `${Math.round(highlight.width * scale)} × ${Math.round(highlight.height * scale)}`
    : null;
  const sizeLabelTop = highlight
    ? highlight.y - 28 >= safe.y ? highlight.y - 28 : Math.max(highlight.y, safe.y) + 6
    : 0;

  const editingBounds = editing
    ? textBounds({ id: '', kind: 'text', at: editing.at, text: editing.text || ' ', color: editing.color, size: editing.size })
    : null;

  async function startLive(mode: RegionCaptureMode) {
    if (!session || !selection || busyRef.current) return;
    busyRef.current = true;
    setLiveError(false);
    try {
      const begin = await bridge.startLive(session.token, mode, selection);
      if (state.current.session?.token !== session.token) return;
      if (begin) { liveRef.current = true; setLive(begin); }
      else setLiveError(true);
    } catch { setLiveError(true); }
    finally { busyRef.current = false; }
  }

  async function finishScroll(image: RegionScreenshotBitmap) {
    if (!session || !live) return;
    if (!await bridge.restoreEditor(session.token, image)) throw new Error('Screenshot editor unavailable');
  }

  if (live && session) return live.mode === 'scroll'
    ? <ScrollCaptureOverlay begin={live} token={session.token} bridge={bridge} onEdit={finishScroll} />
    : <LiveCapturePanel begin={live} token={session.token} bridge={bridge} />;

  const toolbar = (imageEditor || toolbarStyle) && (imageEditor || activeDisplay) && (
        <div
          className={imageEditor ? "flex flex-col items-start gap-2" : "absolute flex flex-col items-end gap-2"}
          style={imageEditor ? undefined : toolbarStyle ?? undefined}
          onPointerEnter={() => setOverToolbar(true)}
          onPointerLeave={() => setOverToolbar(false)}
        >
          {captureMode === 'image' ? <ScreenshotToolbar
            ref={toolbarRef}
            tool={tool}
            canUndo={undoStack.length > 0}
            canRedo={redoStack.length > 0}
            shortcutMod={modLabel}
            onTool={(next) => {
              commitEditing();
              setSelectedId(null);
              setTool((current) => (current === next ? null : next));
            }}
            onUndo={undo}
            onRedo={redo}
            onAction={(action) => void runAction(action)}
            onCancel={cancel}
          /> : captureMode === 'video' ? <div ref={toolbarRef} className="pointer-events-auto flex w-[360px] max-w-screen flex-col gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3 text-12 text-[var(--text-primary)]" onPointerDown={(event) => event.stopPropagation()}>
            <div role="group" aria-label={t('regionScreenshot.live.format')} className="flex items-center gap-1">
              <span className="mr-auto text-[var(--text-secondary)]">{t('regionScreenshot.live.format')}</span>
              {(['video', 'gif'] as const).map((format) => <Button key={format} size="xs" variant="secondary" tone={recordingFormat === format ? 'default' : 'quiet'} aria-pressed={recordingFormat === format} onClick={() => setRecordingFormat(format)}>{format === 'gif' ? 'GIF' : t('regionScreenshot.live.videoFormat')}</Button>)}
            </div>
            <p className="text-[var(--text-secondary)]">{t('regionScreenshot.live.prepareHint')}</p>
            <div className="flex justify-end gap-2">
              <Button size="xs" variant="secondary" tone="quiet" onClick={cancel}>{t('regionScreenshot.cancel')}</Button>
              <Button size="xs" variant="cta" onClick={() => void startLive(recordingFormat)}>{t('regionScreenshot.live.start')}</Button>
            </div>
          </div> : <div ref={toolbarRef} className="pointer-events-auto flex items-center gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1" onPointerDown={(event) => event.stopPropagation()}>
            <Button size="xs" variant="cta" onClick={() => void startLive(captureMode)}>{t(captureMode === 'scroll' ? 'regionScreenshot.live.startScroll' : 'regionScreenshot.live.start')}</Button>
            <Button size="xs" variant="secondary" tone="quiet" onClick={cancel}>{t('regionScreenshot.cancel')}</Button>
          </div>}
          {liveError && <p role="alert" className="mt-1 rounded-xl bg-[var(--surface-elevated)] p-2 text-12 text-[var(--text-primary)]">{t('regionScreenshot.live.noRoom')}</p>}
          {captureMode === 'image' && styleTool && activeStyle && (
            <ScreenshotStyleBar
              tool={styleTool}
              color={activeStyle.color}
              size={activeStyle.size}
              onColor={(color) => applyStyle({ color })}
              onSize={(size) => applyStyle({ size })}
            />
          )}
        </div>
      );

  const canvasContent = (
    <div
      ref={rootRef}
      className={imageEditor ? "relative h-full w-full select-none overflow-hidden" : "fixed inset-0 select-none overflow-hidden"}
      style={{ cursor, background: imageEditor ? undefined : SCREENSHOT_OVERLAY.backdrop }}
      onPointerEnter={() => {
        if (!state.current.session) return;
        setActiveDisplay(true);
        if (!imageEditor) window.focus();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        // 指针移到另一块屏: 这块屏不再显示放大镜和吸附高亮。
        if (!imageEditor) setActiveDisplay(false);
        setAiMenuOpen(false);
        setPointer(null);
        if (!state.current.selection && !state.current.drag) setHover(null);
      }}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <canvas ref={frameRef} className={longResult ? 'absolute block' : 'absolute inset-0 block h-full w-full'} style={longResult && selection ? { left: selection.x, top: selection.y, width: selection.width, height: selection.height } : undefined} />
      <canvas ref={annotationCanvasRef} className="pointer-events-none absolute inset-0 block h-full w-full" />
      {session && !imageEditor &&
        (highlight ? (
          <div
            className="pointer-events-none absolute"
            style={{
              left: highlight.x,
              top: highlight.y,
              width: highlight.width,
              height: highlight.height,
              outline: `${selection ? 1 : 2}px solid ${SCREENSHOT_OVERLAY.edge}`,
              boxShadow: `0 0 0 1px ${SCREENSHOT_OVERLAY.edgeOuter}, 0 0 0 100000px ${SCREENSHOT_OVERLAY.shade}`,
            }}
          />
        ) : (
          <div className="pointer-events-none absolute inset-0" style={{ background: SCREENSHOT_OVERLAY.shade }} />
        ))}
      {session && !longResult && isSelected && selection && !dragging &&
        HANDLES.map((handle) => {
          const p = handlePosition(selection, handle);
          return (
            <span
              key={handle}
              className="pointer-events-none absolute h-2 w-2 rounded-full"
              style={{
                left: p.x - 4,
                top: p.y - 4,
                background: SCREENSHOT_OVERLAY.edge,
                boxShadow: `0 0 0 1px ${SCREENSHOT_OVERLAY.edgeOuter}`,
              }}
            />
          );
        })}
      {selectedAnnotation && (() => {
        const b = annotationBounds(selectedAnnotation);
        return (
          <div
            className="pointer-events-none absolute"
            style={{
              left: b.x - 4,
              top: b.y - 4,
              width: b.width + 8,
              height: b.height + 8,
              outline: `1px dashed ${SCREENSHOT_OVERLAY.edge}`,
              boxShadow: `0 0 0 1px ${SCREENSHOT_OVERLAY.edgeOuter}`,
            }}
          />
        );
      })()}
      {session && !imageEditor && sizeLabel && highlight && (
        <div
          className="pointer-events-none absolute rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 py-0.5 text-12 tabular-nums text-[var(--text-primary)]"
          style={{ left: Math.max(safe.x, Math.min(highlight.x, safe.x + safe.width - 120)), top: sizeLabelTop }}
        >
          {sizeLabel}
        </div>
      )}
      {session && activeDisplay && !selection && !drag && (
        <div style={{ left: safe.x + safe.width / 2, top: safe.y + 64 }} className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3.5 py-1.5 text-12 text-[var(--text-secondary)]">
          {session.lastRegion ? t('regionScreenshot.hintWithLast') : t('regionScreenshot.hint')}
        </div>
      )}
      {editing && editingBounds && (
        <textarea
          ref={textAreaRef}
          value={editing.text}
          spellCheck={false}
          onChange={(event) => setEditing({ ...editing, text: event.target.value })}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          className="absolute resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
          style={{
            left: editing.at.x,
            top: editing.at.y,
            width: Math.max(24, editingBounds.width + TEXT_SIZE[editing.size]),
            height: editingBounds.height,
            font: textFont(editing.size),
            lineHeight: TEXT_LINE_HEIGHT,
            color: SCREENSHOT_INK[editing.color],
            caretColor: SCREENSHOT_INK[editing.color],
            outline: `1px dashed ${SCREENSHOT_OVERLAY.edge}`,
            outlineOffset: 3,
          }}
        />
      )}
      {session && !imageEditor && activeDisplay && <div className="absolute z-20 w-max -translate-x-1/2" style={{ left: modeBarCenter ?? safe.x + safe.width / 2, top: safe.y + 12, maxWidth: safe.width - 24 }} onPointerEnter={() => setOverToolbar(true)} onPointerLeave={() => setOverToolbar(false)}>
        <ScreenshotModeBar mode={captureMode} finished={!!longResult} canAsk={isSelected && !dragging} aiMenuOpen={aiMenuOpen}
          area={safe} onPositionChange={setModeBarCenter}
          onMode={(mode) => { commitEditing(); setCaptureMode(mode); setTool(null); setSelectedId(null); setAiMenuOpen(false); setLiveError(false); }}
          onToggleAiMenu={() => setAiMenuOpen((open) => !open)} onAction={(action) => void runAction(action)} />
      </div>}
      {!imageEditor && toolbar}

      {showMagnifier && pointer && session && (
        <Magnifier
          frame={frameRef.current}
          frameSize={session.frameSize}
          point={pointer}
          viewport={viewport}
          bounds={safe}
          color={colorAt(pointer)}
          scaleFactor={session.scaleFactor}
        />
      )}
    </div>
  );
  return imageEditor ? <ScreenshotEditorViewport key={session?.token ?? 'empty'} image={session?.frameSize ?? null} tools={toolbar} onAction={(action) => void runAction(action)}
    onMinimize={() => { if (session) window.regionScreenshotEditor?.minimize(session.token); }}
    onClose={() => { if (session) bridge.cancel(session.token); }}
  >{canvasContent}</ScreenshotEditorViewport> : canvasContent;
}
