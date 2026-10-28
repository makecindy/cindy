/**
 * 截图标注: 数据模型、绘制与命中测试。
 *
 * 标注坐标一律是浮层 DIP (与选区同一坐标系), 屏幕显示与最终导出调用同一个
 * {@link drawAnnotations}, 只是画布变换不同 —— 所见即所得。马赛克 / 模糊直接取
 * 定格原图的像素, 不受先画的其它标注影响。
 */

import type { RegionPoint, RegionRect } from '../../../shared/regionScreenshot';
import { SCREENSHOT_INK, type ScreenshotInk } from './screenshotColors';

export type AnnotationTool =
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'pen'
  | 'marker'
  | 'text'
  | 'mosaic'
  | 'blur'
  | 'step';

export const ANNOTATION_TOOLS: readonly AnnotationTool[] = [
  'rect',
  'ellipse',
  'line',
  'arrow',
  'pen',
  'marker',
  'text',
  'mosaic',
  'blur',
  'step',
];

/** 粗细 / 字号 / 强度三档。 */
export type AnnotationSize = 0 | 1 | 2;

/** 标注墨水 (取值见 screenshotColors); 标注里只存墨水名, 绘制时再取色。 */
export const ANNOTATION_COLORS: readonly ScreenshotInk[] = [
  'red',
  'yellow',
  'green',
  'blue',
  'black',
  'white',
];
export const DEFAULT_ANNOTATION_COLOR: ScreenshotInk = 'red';
export const DEFAULT_MARKER_COLOR: ScreenshotInk = 'yellow';

const STROKE_WIDTH = [2, 4, 6];
const MARKER_WIDTH = [12, 18, 26];
export const TEXT_SIZE = [16, 22, 30];
const STEP_RADIUS = [11, 14, 18];
const MOSAIC_BLOCK = [6, 10, 16];
const BLUR_RADIUS = [4, 8, 14];

interface Base {
  id: string;
  color: ScreenshotInk;
  size: AnnotationSize;
}

export type ShapeAnnotation = Base & {
  kind: 'rect' | 'ellipse' | 'line' | 'arrow' | 'mosaic' | 'blur';
  from: RegionPoint;
  to: RegionPoint;
};
export type StrokeAnnotation = Base & { kind: 'pen' | 'marker'; points: RegionPoint[] };
export type TextAnnotation = Base & { kind: 'text'; at: RegionPoint; text: string };
export type StepAnnotation = Base & { kind: 'step'; at: RegionPoint; number: number };
export type Annotation = ShapeAnnotation | StrokeAnnotation | TextAnnotation | StepAnnotation;

/** 马赛克 / 模糊的取样来源: 定格原图及其相对 DIP 的缩放。 */
export interface AnnotationSource {
  frame: CanvasImageSource;
  /** 原图像素 / DIP。 */
  ratioX: number;
  ratioY: number;
  /** Optional placement of a completed long screenshot inside the same editor. */
  offsetX?: number;
  offsetY?: number;
}

export function textFont(size: AnnotationSize): string {
  return `500 ${TEXT_SIZE[size]}px Inter, "HarmonyOS Sans SC", system-ui, sans-serif`;
}

export const TEXT_LINE_HEIGHT = 1.25;

export function shapeRect(from: RegionPoint, to: RegionPoint): RegionRect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/** 序号圈上的数字在浅色墨水上用黑字, 其余用白字。 */
function stepTextColor(color: ScreenshotInk): string {
  return color === 'white' || color === 'yellow' ? SCREENSHOT_INK.black : SCREENSHOT_INK.white;
}

let scratch: HTMLCanvasElement | null = null;
function scratchCanvas(width: number, height: number): CanvasRenderingContext2D | null {
  scratch ??= document.createElement('canvas');
  scratch.width = Math.max(1, Math.ceil(width));
  scratch.height = Math.max(1, Math.ceil(height));
  return scratch.getContext('2d');
}

function drawMosaic(
  ctx: CanvasRenderingContext2D,
  rect: RegionRect,
  size: AnnotationSize,
  source: AnnotationSource,
): void {
  const block = MOSAIC_BLOCK[size];
  const cols = Math.max(1, Math.round(rect.width / block));
  const rows = Math.max(1, Math.round(rect.height / block));
  const tiny = scratchCanvas(cols, rows);
  if (!tiny) return;
  tiny.imageSmoothingEnabled = true;
  tiny.imageSmoothingQuality = 'high';
  tiny.drawImage(
    source.frame,
    (rect.x - (source.offsetX ?? 0)) * source.ratioX,
    (rect.y - (source.offsetY ?? 0)) * source.ratioY,
    rect.width * source.ratioX,
    rect.height * source.ratioY,
    0,
    0,
    cols,
    rows,
  );
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny.canvas, 0, 0, cols, rows, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function drawBlur(
  ctx: CanvasRenderingContext2D,
  rect: RegionRect,
  size: AnnotationSize,
  source: AnnotationSource,
): void {
  // 模糊在原图像素上做, 四周多取一圈, 边缘才不会被透明像素拉淡。
  const radius = BLUR_RADIUS[size];
  const margin = radius * 2;
  const sx = (rect.x - margin - (source.offsetX ?? 0)) * source.ratioX;
  const sy = (rect.y - margin - (source.offsetY ?? 0)) * source.ratioY;
  const sw = (rect.width + margin * 2) * source.ratioX;
  const sh = (rect.height + margin * 2) * source.ratioY;
  const blurred = scratchCanvas(sw, sh);
  if (!blurred) return;
  blurred.filter = `blur(${radius * source.ratioX}px)`;
  blurred.drawImage(source.frame, sx, sy, sw, sh, 0, 0, sw, sh);
  blurred.filter = 'none';
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.drawImage(
    blurred.canvas,
    0,
    0,
    sw,
    sh,
    rect.x - margin,
    rect.y - margin,
    rect.width + margin * 2,
    rect.height + margin * 2,
  );
  ctx.restore();
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  from: RegionPoint,
  to: RegionPoint,
  width: number,
): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const head = Math.min(length, width * 3 + 10);
  const spread = Math.PI / 7;
  const base = { x: to.x - Math.cos(angle) * head * 0.8, y: to.y - Math.sin(angle) * head * 0.8 };
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(base.x, base.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(angle - spread) * head, to.y - Math.sin(angle - spread) * head);
  ctx.lineTo(to.x - Math.cos(angle + spread) * head, to.y - Math.sin(angle + spread) * head);
  ctx.closePath();
  ctx.fill();
}

function drawStroke(ctx: CanvasRenderingContext2D, points: readonly RegionPoint[]): void {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 1) ctx.lineTo(points[0].x + 0.01, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
    ctx.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
  }
  if (points.length > 1) {
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
}

export function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  annotation: Annotation,
  source: AnnotationSource,
): void {
  ctx.save();
  ctx.strokeStyle = SCREENSHOT_INK[annotation.color];
  ctx.fillStyle = SCREENSHOT_INK[annotation.color];
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const width = STROKE_WIDTH[annotation.size];
  ctx.lineWidth = width;
  switch (annotation.kind) {
    case 'rect': {
      const r = shapeRect(annotation.from, annotation.to);
      ctx.strokeRect(r.x, r.y, r.width, r.height);
      break;
    }
    case 'ellipse': {
      const r = shapeRect(annotation.from, annotation.to);
      ctx.beginPath();
      ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'line':
      ctx.beginPath();
      ctx.moveTo(annotation.from.x, annotation.from.y);
      ctx.lineTo(annotation.to.x, annotation.to.y);
      ctx.stroke();
      break;
    case 'arrow':
      drawArrow(ctx, annotation.from, annotation.to, width);
      break;
    case 'pen':
      drawStroke(ctx, annotation.points);
      break;
    case 'marker':
      // 荧光笔: 半透明宽笔, 叠在文字上仍能看清底下的内容。
      ctx.globalAlpha = 0.4;
      ctx.lineCap = 'square';
      ctx.lineWidth = MARKER_WIDTH[annotation.size];
      drawStroke(ctx, annotation.points);
      break;
    case 'mosaic': {
      const r = shapeRect(annotation.from, annotation.to);
      if (r.width >= 1 && r.height >= 1) drawMosaic(ctx, r, annotation.size, source);
      break;
    }
    case 'blur': {
      const r = shapeRect(annotation.from, annotation.to);
      if (r.width >= 1 && r.height >= 1) drawBlur(ctx, r, annotation.size, source);
      break;
    }
    case 'text': {
      ctx.font = textFont(annotation.size);
      ctx.textBaseline = 'top';
      const lineHeight = TEXT_SIZE[annotation.size] * TEXT_LINE_HEIGHT;
      annotation.text.split('\n').forEach((line, index) => {
        ctx.fillText(line, annotation.at.x, annotation.at.y + index * lineHeight);
      });
      break;
    }
    case 'step': {
      const radius = STEP_RADIUS[annotation.size];
      ctx.beginPath();
      ctx.arc(annotation.at.x, annotation.at.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = stepTextColor(annotation.color);
      ctx.font = `600 ${Math.round(radius * 1.15)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(annotation.number), annotation.at.x, annotation.at.y + radius * 0.05);
      break;
    }
  }
  ctx.restore();
}

export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  annotations: readonly Annotation[],
  source: AnnotationSource,
): void {
  for (const annotation of annotations) drawAnnotation(ctx, annotation, source);
}

let measureContext: CanvasRenderingContext2D | null = null;

/** 文字标注的外框 (DIP)。 */
export function textBounds(annotation: TextAnnotation): RegionRect {
  measureContext ??= document.createElement('canvas').getContext('2d');
  const lines = annotation.text.split('\n');
  const lineHeight = TEXT_SIZE[annotation.size] * TEXT_LINE_HEIGHT;
  let width = 0;
  if (measureContext) {
    measureContext.font = textFont(annotation.size);
    for (const line of lines) width = Math.max(width, measureContext.measureText(line).width);
  }
  return { x: annotation.at.x, y: annotation.at.y, width, height: lines.length * lineHeight };
}

/** 标注外框 (DIP), 用于选中框。 */
export function annotationBounds(annotation: Annotation): RegionRect {
  switch (annotation.kind) {
    case 'text':
      return textBounds(annotation);
    case 'step': {
      const r = STEP_RADIUS[annotation.size];
      return { x: annotation.at.x - r, y: annotation.at.y - r, width: r * 2, height: r * 2 };
    }
    case 'pen':
    case 'marker': {
      const xs = annotation.points.map((p) => p.x);
      const ys = annotation.points.map((p) => p.y);
      const pad = (annotation.kind === 'marker' ? MARKER_WIDTH : STROKE_WIDTH)[annotation.size] / 2;
      const x = Math.min(...xs) - pad;
      const y = Math.min(...ys) - pad;
      return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
    }
    default:
      return shapeRect(annotation.from, annotation.to);
  }
}

function distanceToSegment(p: RegionPoint, a: RegionPoint, b: RegionPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const inside = (r: RegionRect, p: RegionPoint, pad = 0) =>
  p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad;

/**
 * 指针是否点中标注。矩形 / 椭圆只认轮廓 (框内还能继续画新标注), 马赛克、模糊、
 * 文字、序号认整个区域, 线条认笔迹附近。
 */
export function hitAnnotation(annotation: Annotation, point: RegionPoint): boolean {
  const tolerance = 6;
  switch (annotation.kind) {
    case 'rect': {
      const r = shapeRect(annotation.from, annotation.to);
      return inside(r, point, tolerance) && !inside(
        { x: r.x + tolerance, y: r.y + tolerance, width: r.width - tolerance * 2, height: r.height - tolerance * 2 },
        point,
      );
    }
    case 'ellipse': {
      const r = shapeRect(annotation.from, annotation.to);
      const rx = r.width / 2;
      const ry = r.height / 2;
      if (rx < 1 || ry < 1) return inside(r, point, tolerance);
      const nx = (point.x - (r.x + rx)) / rx;
      const ny = (point.y - (r.y + ry)) / ry;
      const distance = Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry);
      return distance <= tolerance;
    }
    case 'line':
    case 'arrow':
      return distanceToSegment(point, annotation.from, annotation.to) <= tolerance + STROKE_WIDTH[annotation.size];
    case 'pen':
    case 'marker': {
      const width = (annotation.kind === 'marker' ? MARKER_WIDTH : STROKE_WIDTH)[annotation.size];
      const pts = annotation.points;
      if (pts.length === 1) return Math.hypot(point.x - pts[0].x, point.y - pts[0].y) <= tolerance + width;
      for (let i = 1; i < pts.length; i++) {
        if (distanceToSegment(point, pts[i - 1], pts[i]) <= tolerance + width / 2) return true;
      }
      return false;
    }
    default:
      return inside(annotationBounds(annotation), point, 2);
  }
}

/** 最上层被点中的标注。 */
export function annotationAt(
  annotations: readonly Annotation[],
  point: RegionPoint,
): Annotation | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (hitAnnotation(annotations[i], point)) return annotations[i];
  }
  return null;
}

const shift = (p: RegionPoint, dx: number, dy: number) => ({ x: p.x + dx, y: p.y + dy });

export function moveAnnotation(annotation: Annotation, dx: number, dy: number): Annotation {
  switch (annotation.kind) {
    case 'pen':
    case 'marker':
      return { ...annotation, points: annotation.points.map((p) => shift(p, dx, dy)) };
    case 'text':
    case 'step':
      return { ...annotation, at: shift(annotation.at, dx, dy) };
    default:
      return { ...annotation, from: shift(annotation.from, dx, dy), to: shift(annotation.to, dx, dy) };
  }
}

/** 画到一半就松手的标注 (点一下、几乎没拖) 不保留。 */
export function isMeaningfulAnnotation(annotation: Annotation): boolean {
  switch (annotation.kind) {
    case 'pen':
    case 'marker':
      return annotation.points.length > 0;
    case 'text':
      return annotation.text.trim().length > 0;
    case 'step':
      return true;
    default:
      return Math.hypot(annotation.to.x - annotation.from.x, annotation.to.y - annotation.from.y) >= 3;
  }
}

/** 按住 Shift: 直线 / 箭头吸附到 45° 的倍数, 矩形 / 椭圆取正方形 / 正圆。 */
export function constrainShape(
  kind: ShapeAnnotation['kind'],
  from: RegionPoint,
  to: RegionPoint,
): RegionPoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (kind === 'line' || kind === 'arrow') {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const length = Math.hypot(dx, dy);
    return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: from.x + Math.sign(dx || 1) * side, y: from.y + Math.sign(dy || 1) * side };
}

export function nextStepNumber(annotations: readonly Annotation[]): number {
  let max = 0;
  for (const annotation of annotations) {
    if (annotation.kind === 'step') max = Math.max(max, annotation.number);
  }
  return max + 1;
}
