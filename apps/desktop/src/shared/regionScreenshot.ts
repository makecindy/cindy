/**
 * 全局框选截图: main、框选浮层、贴图窗口与主窗口共用的通道名、payload 形状与纯几何。
 *
 * 浮层与贴图窗口加载主窗口同源页面 (各自的轻量入口 + 专用 preload), 只能走下面的
 * 固定通道。main 按 sender 反查所属显示器 / 贴图, 不信任页面传来的任何显示器、
 * 窗口或贴图身份; 页面导出的像素也按显示器尺寸重新校验。
 *
 * 坐标约定: 浮层内一律是该显示器的 DIP (= 窗口 CSS 像素), 定格原图与导出图是物理像素。
 */

export const REGION_SCREENSHOT_CHANNEL = {
  /** send: 浮层页面已挂载, 可以接收截图会话 (窗口隐藏预热时发一次)。 */
  SHELL_READY: 'region-screenshot:shell-ready',
  /** main → 浮层: 开始一次截图会话 ({@link RegionScreenshotBegin})。 */
  BEGIN: 'region-screenshot:begin',
  /** send(token): 定格画面已绘制, 可以显示窗口 (避免先闪一帧底色)。 */
  PAINTED: 'region-screenshot:painted',
  /** send(token): 浮层已拿到键盘焦点；全局 Esc 仍保留到截图结束。 */
  FOCUSED: 'region-screenshot:focused',
  /** send(token): 用户在本显示器开始框选, main 通知其它显示器清除选区。 */
  SELECTION_START: 'region-screenshot:selection-start',
  /** main → 浮层: 清除本显示器的选区。 */
  CLEAR: 'region-screenshot:clear',
  /** main → 浮层: 会话结束, 清空画面与全部交互态后隐藏。 */
  END: 'region-screenshot:end',
  /** invoke(token, windowId, x, y): 实际命中窗口与由内到外的元素 (DIP)。 */
  ELEMENTS_AT: 'region-screenshot:elements-at',
  /** send(token, text): 复制取到的颜色值。 */
  COPY_TEXT: 'region-screenshot:copy-text',
  /** invoke(token, {@link RegionScreenshotExport}): 用最终图执行动作并结束会话。 */
  EXPORT: 'region-screenshot:export',
  /** send(token): 取消本次截图。 */
  CANCEL: 'region-screenshot:cancel',
  /**
   * send: 页面已丢失会话 (重新加载 / 重新挂载) 却仍可能显示着, 请 main 结束本浮层所在的
   * 会话。不带 token —— 页面此时已没有 token; main 只按 sender 判断它是否属于当前会话。
   */
  ABANDON: 'region-screenshot:abandon',
} as const;

/** Local-only image editor. Every incoming signal is bound to its top-level renderer. */
export const REGION_SCREENSHOT_EDITOR_CHANNEL = {
  READY: 'region-screenshot-editor:ready',
  BEGIN: 'region-screenshot-editor:begin',
  END: 'region-screenshot-editor:end',
  PAINTED: 'region-screenshot-editor:painted',
  CANCEL: 'region-screenshot-editor:cancel',
  MINIMIZE: 'region-screenshot-editor:minimize',
  EXPORT: 'region-screenshot-editor:export',
  ACTIVITY: 'region-screenshot-editor:activity',
  FAILED: 'region-screenshot-editor:failed',
} as const;

export const REGION_SCREENSHOT_PIN_CHANNEL = {
  /** send: 贴图页面已挂载。 */
  SHELL_READY: 'region-screenshot-pin:shell-ready',
  /** main → 贴图: 要显示的图 ({@link RegionScreenshotPinInit})。 */
  INIT: 'region-screenshot-pin:init',
  /** send: 图已绘制, 可以显示窗口。 */
  PAINTED: 'region-screenshot-pin:painted',
  /** send: 开始一次拖动 (main 记下当前位置与指针)。 */
  DRAG_START: 'region-screenshot-pin:drag-start',
  /** send: 拖动中 (main 按指针的屏幕位移移动窗口)。 */
  DRAG_MOVE: 'region-screenshot-pin:drag-move',
  /** send(steps, x, y): 滚轮缩放, 以窗口内 (x, y) 为锚点。 */
  ZOOM: 'region-screenshot-pin:zoom',
  /** send(steps): Ctrl / ⌘ + 滚轮调整不透明度。 */
  OPACITY: 'region-screenshot-pin:opacity',
  /** send: 弹出贴图菜单。 */
  MENU: 'region-screenshot-pin:menu',
  /** send(command): 键盘快捷操作 ({@link RegionScreenshotPinCommand})。 */
  COMMAND: 'region-screenshot-pin:command',
  /** send(hovering): 穿透模式下指针是否停在「恢复」按钮上 (停留时暂时接收点击)。 */
  UNLOCK_HOVER: 'region-screenshot-pin:unlock-hover',
  /** main → 贴图: 状态变化 ({@link RegionScreenshotPinState})。 */
  STATE: 'region-screenshot-pin:state',
} as const;

/** 截图交给主窗口的任务入口: main 只负责入仓与唤醒, 草稿由主窗口写入。 */
export const REGION_SCREENSHOT_COMPOSE_CHANNEL = {
  /** main → 主窗口: 有待处理的截图 (只是唤醒, 内容用 TAKE 取)。 */
  WAKE: 'region-screenshot:compose-wake',
  /** invoke: 主窗口取走待处理的截图请求 (只认主窗口)。 */
  TAKE: 'region-screenshot:compose-take',
} as const;

export const REGION_SCREENSHOT_AI_ACTIONS = ['ask', 'translate', 'explain', 'extract'] as const;
export type RegionScreenshotAiAction = (typeof REGION_SCREENSHOT_AI_ACTIONS)[number];
export type RegionScreenshotAction = 'copy' | 'save' | 'pin' | RegionScreenshotAiAction;

const ACTIONS: readonly string[] = ['copy', 'save', 'pin', ...REGION_SCREENSHOT_AI_ACTIONS];

export function isRegionScreenshotAction(value: unknown): value is RegionScreenshotAction {
  return typeof value === 'string' && ACTIONS.includes(value);
}

export function isRegionScreenshotAiAction(value: unknown): value is RegionScreenshotAiAction {
  return (
    typeof value === 'string' && (REGION_SCREENSHOT_AI_ACTIONS as readonly string[]).includes(value)
  );
}

export const REGION_SCREENSHOT_PIN_COMMANDS = [
  'copy',
  'save',
  'close',
  'ask',
  'unlock',
  'zoom-reset',
] as const;
export type RegionScreenshotPinCommand = (typeof REGION_SCREENSHOT_PIN_COMMANDS)[number];

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RegionSize {
  width: number;
  height: number;
}

export interface RegionPoint {
  x: number;
  y: number;
}

/** 原始像素, BGRA 字节序 (与 NativeImage.toBitmap / createFromBitmap 一致)。 */
export interface RegionScreenshotBitmap {
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer>;
}

/** 定格时可见的窗口 (本显示器 DIP, 已裁到显示器内), 按 z 序从上到下。 */
export interface RegionScreenshotWindow {
  id: number;
  rect: RegionRect;
  /** Captured native regions in hit order; absent on older helpers/platforms. */
  snapRects?: RegionRect[];
}

/** A point query can correct the rectangular window guess through transparent overlays. */
export interface RegionScreenshotHit {
  window: RegionScreenshotWindow | null;
  rects: RegionRect[];
  /** Default document/content region; finer elements remain available via wheel. */
  preferredRect?: RegionRect;
}

export interface RegionScreenshotBegin {
  /** 本次会话标识; 迟到的回调凭它与新会话区分。 */
  token: string;
  locale: string;
  /** 显示器尺寸 (DIP) = 浮层视口; 不依赖页面此刻读到的窗口尺寸。 */
  viewport: RegionSize;
  /** 显示器缩放比例: 选区按物理像素网格对齐, 尺寸按物理像素标注。 */
  scaleFactor: number;
  /** 定格原图 (无损), 取色、放大镜、马赛克与最终导出都用它。 */
  frame: RegionScreenshotBitmap;
  windows: RegionScreenshotWindow[];
  /** 本显示器上一次截图的选区, 供「重复上次区域」。 */
  lastRegion: RegionRect | null;
  /** 截图时鼠标在本显示器上的位置 (DIP); 不在本屏为 null。浮层据此立即吸附高亮, 不必等鼠标移动。 */
  cursor: RegionPoint | null;
  /**
   * 工具条、放大镜、提示等界面元素可用的区域 (本显示器 DIP): 避开菜单栏、刘海、
   * Dock / 任务栏。选区本身仍可覆盖整块显示器。见 {@link regionChromeArea}。
   */
  safeArea: RegionRect;
}

export interface RegionScreenshotExport {
  action: RegionScreenshotAction;
  /** 最终选区 (DIP), main 记为「上次区域」并据此放置贴图。 */
  selection: RegionRect;
  /** 已合成标注的最终图 (物理像素)。 */
  image: RegionScreenshotBitmap;
}

export interface RegionScreenshotPinInit {
  locale: string;
  image: RegionScreenshotBitmap;
}

export interface RegionScreenshotPinState {
  opacity: number;
  passThrough: boolean;
  /** 当前缩放 (1 = 原始大小)。 */
  zoom: number;
}

/** 截图交给新任务: 已入仓的图片与用户点的动作。 */
export interface RegionScreenshotComposeRequest {
  id: string;
  ownerStamp: import('./dataOwnerPush').DataOwnerPushStamp;
  action: RegionScreenshotAiAction;
  url: string;
  filename: string;
  bytes: number;
  width: number;
  height: number;
}

export type RegionHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** 导出图的边长上限 (物理像素); 超出视为异常 payload。 */
export const REGION_SCREENSHOT_MAX_SIDE = 32_768;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const validScale = (scale: number) => (scale > 0 && Number.isFinite(scale) ? scale : 1);

/** 对齐到物理像素网格 (DIP × scale 为整数)。 */
export function snapToPixelGrid(value: number, scale: number): number {
  const s = validScale(scale);
  return Math.round(value * s) / s;
}

/**
 * 校验浮层传来的选区 (窗口内 DIP), 裁到视口内并对齐物理像素网格。
 * 结构非法或裁剪后不足一个物理像素返回 null。
 */
export function normalizeRegionSelection(
  raw: unknown,
  viewport: RegionSize,
  scale = 1,
): RegionRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const values = [candidate.x, candidate.y, candidate.width, candidate.height];
  if (!values.every(isFiniteNumber)) return null;
  const [x, y, width, height] = values as number[];
  const s = validScale(scale);
  const left = Math.max(0, snapToPixelGrid(Math.min(x, x + width), s));
  const top = Math.max(0, snapToPixelGrid(Math.min(y, y + height), s));
  const right = Math.min(viewport.width, snapToPixelGrid(Math.max(x, x + width), s));
  const bottom = Math.min(viewport.height, snapToPixelGrid(Math.max(y, y + height), s));
  if ((right - left) * s < 1 - 1e-6 || (bottom - top) * s < 1 - 1e-6) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 把 DIP 选区映射到定格原图的像素裁剪区域。
 *
 * 原图来自 desktopCapturer 缩略图, 所有显示器共用一个 thumbnailSize 上限, 实际
 * 尺寸 = 按比例缩放后的显示器画面, 不一定等于 bounds × scaleFactor (混合 DPI 时
 * 较小的屏可能被放大)。因此按「原图宽 / 显示器 DIP 宽」换算, 并给出该选区的
 * 物理像素尺寸; 裁出的图比物理尺寸大时由调用方缩回, 避免出现被放大的模糊截图。
 */
export function regionSelectionToImageCrop(
  selection: RegionRect,
  displaySize: RegionSize,
  imageSize: RegionSize,
  scaleFactor: number,
): { crop: RegionRect; output: RegionSize } | null {
  if (displaySize.width <= 0 || displaySize.height <= 0) return null;
  if (imageSize.width <= 0 || imageSize.height <= 0) return null;
  const sx = imageSize.width / displaySize.width;
  const sy = imageSize.height / displaySize.height;
  const left = Math.max(0, Math.round(selection.x * sx));
  const top = Math.max(0, Math.round(selection.y * sy));
  const right = Math.min(imageSize.width, Math.round((selection.x + selection.width) * sx));
  const bottom = Math.min(imageSize.height, Math.round((selection.y + selection.height) * sy));
  if (right - left < 1 || bottom - top < 1) return null;
  const crop = { x: left, y: top, width: right - left, height: bottom - top };
  const scale = validScale(scaleFactor);
  const physical = {
    width: Math.max(1, Math.round(selection.width * scale)),
    height: Math.max(1, Math.round(selection.height * scale)),
  };
  const output =
    crop.width > physical.width || crop.height > physical.height
      ? physical
      : { width: crop.width, height: crop.height };
  return { crop, output };
}

/**
 * 校验页面传来的位图: 尺寸为正整数且不超过 `max`, 字节数正好是 BGRA 四通道。
 * 只接受真正的 Uint8Array (structured clone 之后仍是), 不接受普通数组。
 */
export function validateRegionBitmap(
  raw: unknown,
  max: RegionSize,
): RegionScreenshotBitmap | null {
  if (!raw || typeof raw !== 'object') return null;
  const { width, height, data } = raw as Record<string, unknown>;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  const w = width as number;
  const h = height as number;
  if (w < 1 || h < 1 || w > max.width || h > max.height) return null;
  if (w > REGION_SCREENSHOT_MAX_SIDE || h > REGION_SCREENSHOT_MAX_SIDE) return null;
  if (!(data instanceof Uint8Array) || data.byteLength !== w * h * 4) return null;
  return { width: w, height: h, data: data as Uint8Array<ArrayBuffer> };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 两点张成的矩形; `square` 时以 anchor 为固定角取较长边的正方形 (不越出视口)。 */
export function rectFromDrag(
  anchor: RegionPoint,
  point: RegionPoint,
  viewport: RegionSize,
  square = false,
): RegionRect {
  let x = clamp(point.x, 0, viewport.width);
  let y = clamp(point.y, 0, viewport.height);
  if (square) {
    const dirX = x >= anchor.x ? 1 : -1;
    const dirY = y >= anchor.y ? 1 : -1;
    const room = Math.min(
      dirX > 0 ? viewport.width - anchor.x : anchor.x,
      dirY > 0 ? viewport.height - anchor.y : anchor.y,
    );
    const side = Math.min(Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y)), room);
    x = anchor.x + dirX * side;
    y = anchor.y + dirY * side;
  }
  return {
    x: Math.min(anchor.x, x),
    y: Math.min(anchor.y, y),
    width: Math.abs(x - anchor.x),
    height: Math.abs(y - anchor.y),
  };
}

/**
 * 拖动手柄调整选区。`start` 是按下手柄时的选区; 越过对边时翻转, 不会出现负尺寸。
 * `square` 时角手柄保持正方形, 边手柄不受影响。
 */
export function resizeRegion(
  start: RegionRect,
  handle: RegionHandle,
  point: RegionPoint,
  viewport: RegionSize,
  square = false,
): RegionRect {
  const px = clamp(point.x, 0, viewport.width);
  const py = clamp(point.y, 0, viewport.height);
  if (square && handle.length === 2) {
    const anchor = {
      x: handle.includes('w') ? start.x + start.width : start.x,
      y: handle.includes('n') ? start.y + start.height : start.y,
    };
    return rectFromDrag(anchor, { x: px, y: py }, viewport, true);
  }
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (handle.includes('w')) left = px;
  if (handle.includes('e')) right = px;
  if (handle.includes('n')) top = py;
  if (handle.includes('s')) bottom = py;
  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    width: Math.abs(right - left),
    height: Math.abs(bottom - top),
  };
}

/** 整体平移选区, 不越出视口。 */
export function moveRegion(
  rect: RegionRect,
  dx: number,
  dy: number,
  viewport: RegionSize,
): RegionRect {
  return {
    ...rect,
    x: clamp(rect.x + dx, 0, Math.max(0, viewport.width - rect.width)),
    y: clamp(rect.y + dy, 0, Math.max(0, viewport.height - rect.height)),
  };
}

export type RegionArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export function isRegionArrowKey(key: string): key is RegionArrowKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
}

/**
 * 方向键微调: 默认平移; `resize` 时移动右 / 下边 (→ ↓ 放大, ← ↑ 缩小), 至少保留 `step`。
 */
export function nudgeRegion(
  rect: RegionRect,
  key: RegionArrowKey,
  step: number,
  viewport: RegionSize,
  resize = false,
): RegionRect {
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
  if (!resize) return moveRegion(rect, dx, dy, viewport);
  return {
    ...rect,
    width: clamp(rect.width + dx, step, viewport.width - rect.x),
    height: clamp(rect.height + dy, step, viewport.height - rect.y),
  };
}

/** 指针所在的选区手柄 (边线附近 `tolerance` 范围内); 不在手柄上返回 null。 */
export function regionHandleAt(
  rect: RegionRect,
  point: RegionPoint,
  tolerance: number,
): RegionHandle | null {
  const { x, y } = point;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (x < rect.x - tolerance || x > right + tolerance) return null;
  if (y < rect.y - tolerance || y > bottom + tolerance) return null;
  const near = (value: number, edge: number) => Math.abs(value - edge) <= tolerance;
  const vertical = near(y, rect.y) ? 'n' : near(y, bottom) ? 's' : '';
  const horizontal = near(x, rect.x) ? 'w' : near(x, right) ? 'e' : '';
  const handle = `${vertical}${horizontal}`;
  return handle ? (handle as RegionHandle) : null;
}

export function rectContains(rect: RegionRect, point: RegionPoint): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

/** 界面元素区域小于这个尺寸时视为异常 (如工作区读数错误), 改用整块显示器。 */
const MIN_CHROME_AREA = 320;

/**
 * 截图界面元素可用的区域 (显示器内 DIP): 系统工作区 (已除去菜单栏、Dock / 任务栏),
 * 顶部再让出摄像头刘海 `topInset` (菜单栏自动隐藏时工作区仍包含刘海那一条)。
 * 全局坐标的 `bounds` / `workArea` 来自 Electron Display; 结果异常时返回整块显示器。
 */
export function regionChromeArea(bounds: RegionRect, workArea: RegionRect, topInset = 0): RegionRect {
  const whole = { x: 0, y: 0, width: bounds.width, height: bounds.height };
  const values = [bounds.x, bounds.y, bounds.width, bounds.height, workArea.x, workArea.y, workArea.width, workArea.height, topInset];
  if (!values.every(isFiniteNumber)) return whole;
  const left = clamp(workArea.x - bounds.x, 0, bounds.width);
  const right = clamp(workArea.x + workArea.width - bounds.x, 0, bounds.width);
  const top = clamp(Math.max(workArea.y - bounds.y, topInset), 0, bounds.height);
  const bottom = clamp(workArea.y + workArea.height - bounds.y, 0, bounds.height);
  if (right - left < MIN_CHROME_AREA || bottom - top < MIN_CHROME_AREA) return whole;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 把 `size` 大小的界面元素移进 `area`; 放不下时贴住左上角。 */
export function clampIntoArea(point: RegionPoint, size: RegionSize, area: RegionRect): RegionPoint {
  return {
    x: Math.max(area.x, Math.min(point.x, area.x + area.width - size.width)),
    y: Math.max(area.y, Math.min(point.y, area.y + area.height - size.height)),
  };
}

/** 与视口求交; 无交集返回 null。 */
export function intersectRegion(rect: RegionRect, viewport: RegionSize): RegionRect | null {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.width);
  const bottom = Math.min(viewport.height, rect.y + rect.height);
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function sameRegion(a: RegionRect, b: RegionRect): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/** 指针下最上层的窗口 (windows 已按 z 序从上到下)。 */
export function topWindowAt(
  windows: readonly RegionScreenshotWindow[],
  point: RegionPoint,
): RegionScreenshotWindow | null {
  return windows.find((window) => rectContains(window.rect, point)) ?? null;
}

/**
 * 悬停吸附的候选选区, 由内到外: 指针下的界面元素 → 所在窗口 → 整块显示器。
 * 只保留包含指针、与视口相交的区域, 相同区域只留一个, 比内层更小的外层视为
 * 异常并跳过; 滚轮在这串候选里切换层级。
 */
export function snapCandidates(
  point: RegionPoint,
  window: RegionScreenshotWindow | null,
  elements: readonly RegionRect[],
  viewport: RegionSize,
): RegionRect[] {
  const result: RegionRect[] = [];
  const push = (rect: RegionRect) => {
    const clipped = intersectRegion(rect, viewport);
    if (!clipped || !rectContains(clipped, point)) return;
    if (result.some((existing) => sameRegion(existing, clipped))) return;
    const last = result[result.length - 1];
    if (last && clipped.width * clipped.height < last.width * last.height) return;
    result.push(clipped);
  };
  for (const rect of elements) push(rect);
  if (window) push(window.rect);
  push({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  return result;
}
