/**
 * imageAnnotation — 图片圈点标注的跨端纯函数核心(desktop + mobile 共用)。
 * ---------------------------------------------------------------------------
 * 笔迹一律存**归一化坐标**(0..1,相对图片自然尺寸)。显示(SVG overlay)与
 * 烧录(canvas)共用同一映射与同一线宽,所见即所得。各端只保留自己的事件采集
 * 与布局推导(desktop 用 getBoundingClientRect,mobile 从容器尺寸 + transform
 * 推导),视觉参数与绘制算法以本文件为唯一真相源。
 *
 * mobile 的烧录跑在 WebView 里(RN 无 DOM canvas),Hermes 不保留函数源码,
 * 不能 `fn.toString()` 注入,因此 WebView 侧脚本以 ES5 字符串
 * `ANNOTATION_CANVAS_SCRIPT` 维护;单测把它在 node 里求值,与本文件的
 * TS 实现逐调用对比,保证两份实现不漂移。
 */

export interface AnnotationPoint {
  x: number;
  y: number;
}

/** 一条手绘笔迹:归一化坐标点序列(0..1,相对图片自然尺寸)。 */
export interface AnnotationStroke {
  points: AnnotationPoint[];
}

/** 标注笔迹主色(红,语义豁免色;白描边保证深色 / 红色背景上仍醒目)。 */
export const ANNOTATION_STROKE_COLOR = '#FF3B30';
export const ANNOTATION_OUTLINE_COLOR = 'rgba(255,255,255,0.9)';

/** 白描边相对红线的宽度倍率。 */
export const ANNOTATION_OUTLINE_WIDTH_RATIO = 1.8;
/** 采集时的最小点距(归一化):小于该距离的 move 点丢弃,抑制点数爆炸。 */
export const MIN_POINT_DISTANCE_RATIO = 0.002;

/**
 * 模型侧图片预处理的长边目标(maker-core image-resizer 的 MAX_LONG_EDGE)。
 * 线宽下限按"缩到该长边后仍至少 {@link MODEL_VISIBLE_MIN_LINE_PX} px"推导,
 * 避免超长截图上的笔迹在送模前被缩没。
 */
const MODEL_IMAGE_LONG_EDGE = 1568;
const MODEL_VISIBLE_MIN_LINE_PX = 3;
/** 长边兜底项相对短边的上限,防止极端长宽比下线条糊满整张图。 */
const LONG_EDGE_TERM_MAX_SHORT_RATIO = 0.02;

/** 归一化坐标保留的小数位:1e-4 在 10000px 边长上也只有 1px,肉眼无差。 */
const COORDINATE_DECIMALS = 4;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * 屏幕 / 容器坐标 → 归一化图片坐标。`rect` 为图片当前的实际显示矩形。
 * 越界点钳制到边缘(画到图外时贴边),坐标量化到 4 位小数以缩小持久化体积。
 */
export function normalizeAnnotationPoint(
  pointX: number,
  pointY: number,
  rect: { left: number; top: number; width: number; height: number },
): AnnotationPoint | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    x: quantizeAnnotationCoordinate(clamp01((pointX - rect.left) / rect.width)),
    y: quantizeAnnotationCoordinate(clamp01((pointY - rect.top) / rect.height)),
  };
}

export function quantizeAnnotationCoordinate(v: number): number {
  const factor = 10 ** COORDINATE_DECIMALS;
  return Math.round(v * factor) / factor;
}

/**
 * 是否应把新点追加进笔迹:与上一点距离(归一化)超过阈值才收,
 * 抑制高频 move 事件造成的点数爆炸。首点恒收。
 */
export function shouldAppendAnnotationPoint(
  stroke: AnnotationStroke,
  point: AnnotationPoint,
  minDistance = MIN_POINT_DISTANCE_RATIO,
): boolean {
  const last = stroke.points[stroke.points.length - 1];
  if (!last) return true;
  return Math.hypot(point.x - last.x, point.y - last.y) >= minDistance;
}

/**
 * 烧录 / 显示用线宽(像素,相对图片自然尺寸)。
 *
 * - 主项:0.5% 短边,4px 下限、24px 上限(常规比例图片的一贯观感)。
 * - 长边兜底:超长截图(如 1000×8000)按短边算只有 5px,送模前缩到长边 1568
 *   后不足 1px、基本被压没;因此再保证"缩到 1568 长边后仍 ≥3px",该项以
 *   2% 短边封顶。兜底项只在超过未封顶的短边项(长宽比大于约 2.6:1)时生效,
 *   其余图片(含短边项被 24px 封顶的超大图)线宽与旧公式完全一致。
 */
export function annotationStrokeWidth(naturalWidth: number, naturalHeight: number): number {
  const shortEdge = Math.min(naturalWidth, naturalHeight);
  const longEdge = Math.max(naturalWidth, naturalHeight);
  const primary = Math.min(24, Math.max(4, shortEdge * 0.005));
  const longEdgeFloor = Math.min(
    (longEdge / MODEL_IMAGE_LONG_EDGE) * MODEL_VISIBLE_MIN_LINE_PX,
    shortEdge * LONG_EDGE_TERM_MAX_SHORT_RATIO,
  );
  // 只在兜底项超过未封顶的短边项时生效(即长宽比大于约 2.6:1),常规比例图片
  // (包括短边项被 24px 封顶的超大图)线宽与旧公式逐像素一致。
  const floor = longEdgeFloor > shortEdge * 0.005 ? longEdgeFloor : 0;
  return Math.round(Math.max(primary, floor));
}

/**
 * 被系统 / 第二根手指打断(非正常抬笔)的笔迹,屏幕路径短于该值时视为误触丢弃;
 * 更长的笔迹照常保留,避免丢掉用户真正画了的内容。桌面 pointercancel 与手机
 * 多指打断共用同一阈值。
 */
export const INTERRUPTED_STROKE_DISCARD_SCREEN_PX = 12;

/** 笔迹在 width×height 显示尺寸下的屏幕路径长度(像素)。 */
export function annotationStrokeScreenLength(
  points: readonly AnnotationPoint[],
  width: number,
  height: number,
): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot((points[i].x - points[i - 1].x) * width, (points[i].y - points[i - 1].y) * height);
  }
  return length;
}

/** 白描边线宽(与 {@link annotationStrokeWidth} 配套)。 */
export function annotationOutlineWidth(strokeWidth: number): number {
  return Math.round(strokeWidth * ANNOTATION_OUTLINE_WIDTH_RATIO);
}

/**
 * 归一化笔迹 → SVG path `d`(映射到 width×height 像素空间)。
 * 单点笔迹(点按)画一个极短线段,配合 round linecap 呈现为圆点。
 */
export function annotationStrokeToSvgPath(
  stroke: AnnotationStroke,
  width: number,
  height: number,
): string {
  const pts = stroke.points;
  if (pts.length === 0) return '';
  const fmt = (p: AnnotationPoint) => `${(p.x * width).toFixed(1)} ${(p.y * height).toFixed(1)}`;
  if (pts.length === 1) {
    const x = pts[0].x * width;
    const y = pts[0].y * height;
    return `M ${x.toFixed(1)} ${y.toFixed(1)} L ${(x + 0.1).toFixed(1)} ${y.toFixed(1)}`;
  }
  return `M ${fmt(pts[0])} ${pts.slice(1).map((p) => `L ${fmt(p)}`).join(' ')}`;
}

/** canvas 2D context 中烧录所需的最小接口(便于单测注入 fake)。 */
export interface AnnotationCanvasContext {
  lineCap: string;
  lineJoin: string;
  strokeStyle: unknown;
  lineWidth: number;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

/**
 * 把笔迹重放到 canvas context(width×height 为绘制目标尺寸)。
 * 两遍绘制:先全部白描边、再全部红线——笔迹交叉处不会出现白边压红线的断裂。
 * SVG 预览必须保持同一分层顺序(先全部描边层、后全部红线层)。
 */
export function drawAnnotationStrokes(
  ctx: AnnotationCanvasContext,
  strokes: readonly AnnotationStroke[],
  width: number,
  height: number,
): void {
  const strokeWidth = annotationStrokeWidth(width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const drawPass = (color: string, lineWidth: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    for (const stroke of strokes) {
      const pts = stroke.points;
      if (!pts || pts.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0].x * width, pts[0].y * height);
      if (pts.length === 1) {
        ctx.lineTo(pts[0].x * width + 0.1, pts[0].y * height);
      } else {
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x * width, pts[i].y * height);
        }
      }
      ctx.stroke();
    }
  };
  drawPass(ANNOTATION_OUTLINE_COLOR, annotationOutlineWidth(strokeWidth));
  drawPass(ANNOTATION_STROKE_COLOR, strokeWidth);
}

/**
 * {@link annotationStrokeWidth} 与 {@link drawAnnotationStrokes} 的 ES5 字符串版,
 * 供 mobile 烧录 WebView 内联。定义两个全局函数:
 * `cindyAnnotationStrokeWidth(width, height)` 与
 * `cindyDrawAnnotationStrokes(ctx, strokes, width, height)`。
 * 修改任一实现必须同步另一份;`imageAnnotation.test.ts` 会逐调用比对。
 */
export const ANNOTATION_CANVAS_SCRIPT = `
function cindyAnnotationStrokeWidth(width, height) {
  var shortEdge = Math.min(width, height);
  var longEdge = Math.max(width, height);
  var primary = Math.min(24, Math.max(4, shortEdge * 0.005));
  var longEdgeFloor = Math.min(
    (longEdge / ${MODEL_IMAGE_LONG_EDGE}) * ${MODEL_VISIBLE_MIN_LINE_PX},
    shortEdge * ${LONG_EDGE_TERM_MAX_SHORT_RATIO}
  );
  var floor = longEdgeFloor > shortEdge * 0.005 ? longEdgeFloor : 0;
  return Math.round(Math.max(primary, floor));
}
function cindyDrawAnnotationStrokes(ctx, strokes, width, height) {
  var strokeWidth = cindyAnnotationStrokeWidth(width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  function drawPass(color, lineWidth) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    for (var s = 0; s < strokes.length; s++) {
      var pts = strokes[s].points;
      if (!pts || pts.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0].x * width, pts[0].y * height);
      if (pts.length === 1) {
        ctx.lineTo(pts[0].x * width + 0.1, pts[0].y * height);
      } else {
        for (var i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x * width, pts[i].y * height);
        }
      }
      ctx.stroke();
    }
  }
  drawPass(${JSON.stringify(ANNOTATION_OUTLINE_COLOR)}, Math.round(strokeWidth * ${ANNOTATION_OUTLINE_WIDTH_RATIO}));
  drawPass(${JSON.stringify(ANNOTATION_STROKE_COLOR)}, strokeWidth);
}
`;

/** 归一化矩形区域(0..1)。 */
export interface AnnotationRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 区域合并时的邻近容差(归一化):相距小于它的笔迹视为同一处标注。 */
const REGION_MERGE_GAP = 0.02;
/** 单张图最多描述的区域数;超出时只保留面积最大的若干处。 */
export const MAX_ANNOTATION_REGIONS = 6;

function regionsTouch(a: AnnotationRegion, b: AnnotationRegion, gap: number): boolean {
  return a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1;
}

function roundRegionCoordinate(v: number): number {
  return Math.round(clamp01(v) * 100) / 100;
}

/**
 * 把笔迹归纳为若干标注区域(每处标注的外接框,归一化坐标,保留两位小数)。
 * 相交或相距很近的笔迹合并为一处(一次圈选常由多笔组成);结果按从上到下、
 * 从左到右排序,最多 {@link MAX_ANNOTATION_REGIONS} 处(超出时保留面积最大的)。
 * 用于给模型的隐藏说明,帮助它在多处标注 / 多张图时定位用户所指。
 */
export function summarizeAnnotationRegions(
  strokes: readonly AnnotationStroke[] | undefined,
): AnnotationRegion[] {
  if (!strokes) return [];
  let regions: AnnotationRegion[] = [];
  for (const stroke of strokes) {
    const pts = stroke?.points;
    if (!Array.isArray(pts) || pts.length === 0) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    if (!Number.isFinite(x0)) continue;
    regions.push({ x0: clamp01(x0), y0: clamp01(y0), x1: clamp01(x1), y1: clamp01(y1) });
  }
  // 反复合并直到稳定:合并后的框可能又与其它框相邻。
  let merged = true;
  while (merged) {
    merged = false;
    const next: AnnotationRegion[] = [];
    for (const region of regions) {
      const target = next.find((candidate) => regionsTouch(candidate, region, REGION_MERGE_GAP));
      if (target) {
        target.x0 = Math.min(target.x0, region.x0);
        target.y0 = Math.min(target.y0, region.y0);
        target.x1 = Math.max(target.x1, region.x1);
        target.y1 = Math.max(target.y1, region.y1);
        merged = true;
      } else {
        next.push({ ...region });
      }
    }
    regions = next;
  }
  if (regions.length > MAX_ANNOTATION_REGIONS) {
    const area = (r: AnnotationRegion) => (r.x1 - r.x0) * (r.y1 - r.y0);
    regions = [...regions].sort((a, b) => area(b) - area(a)).slice(0, MAX_ANNOTATION_REGIONS);
  }
  return regions
    .map((r) => ({
      x0: roundRegionCoordinate(r.x0),
      y0: roundRegionCoordinate(r.y0),
      x1: roundRegionCoordinate(r.x1),
      y1: roundRegionCoordinate(r.y1),
    }))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/** 校验并规范化外部传入的区域列表(跨端 / 持久化数据不可信)。 */
export function sanitizeAnnotationRegions(value: unknown): AnnotationRegion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: AnnotationRegion[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const coords = [r.x0, r.y0, r.x1, r.y1];
    if (!coords.every((c) => typeof c === 'number' && Number.isFinite(c))) continue;
    const [x0, y0, x1, y1] = (coords as number[]).map(roundRegionCoordinate);
    if (x1 < x0 || y1 < y0) continue;
    out.push({ x0, y0, x1, y1 });
    if (out.length >= MAX_ANNOTATION_REGIONS) break;
  }
  return out.length > 0 ? out : undefined;
}

/** 区域 → 模型可读的短文本,如 `x 0.31–0.46, y 0.12–0.20`。 */
export function formatAnnotationRegion(region: AnnotationRegion): string {
  const f = (v: number) => v.toFixed(2);
  return `x ${f(region.x0)}–${f(region.x1)}, y ${f(region.y0)}–${f(region.y1)}`;
}
