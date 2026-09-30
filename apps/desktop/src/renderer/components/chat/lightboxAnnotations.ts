/**
 * lightboxAnnotations — 图片 lightbox 标注模式的纯函数层(desktop 侧薄封装)。
 *
 * 笔迹坐标归一化、SVG path 构造、线宽计算与 canvas 两遍烧录的**唯一实现**在
 * 跨端共享模块 `@cindy/maker-shared/image-annotation`(desktop + mobile 共用,
 * 保证两端所见即所得且不漂移)。本文件只保留 desktop 既有导出名,让调用点
 * (ImageLightbox / annotationBurnIn / 测试)不必随共享模块改名而改动。
 *
 * 坐标系约定:笔迹点一律存**归一化坐标**(0..1,相对图片自然尺寸)。
 * - 采集:屏幕坐标 ÷ 图片元素的 getBoundingClientRect(rect 已含 CSS transform,
 *   因此缩放/平移状态下画的笔迹无需手动逆变换);共享实现会钳制到边缘并量化
 *   到 4 位小数(1e-4 在万像素边长上也只有 1px)。
 * - 显示:SVG overlay 的 viewBox 即图片自然尺寸,归一化点 × 自然尺寸 = path 坐标,
 *   与烧录坐标完全一致(所见即所得,线宽也一致)。显示必须与烧录同一分层顺序:
 *   先全部白描边、再全部红线(见 AnnotationStrokesSvg)。
 * - 烧录:canvas 以自然尺寸绘制原图后按同一映射重放笔迹。
 */

import { annotationStrokeToSvgPath as strokeToSvgPathImpl } from '@cindy/maker-shared/image-annotation';
import type { ImageAnnotationStroke } from '@/lib/fileTypes';

export {
  ANNOTATION_OUTLINE_COLOR,
  ANNOTATION_STROKE_COLOR,
  MIN_POINT_DISTANCE_RATIO,
  annotationOutlineWidth,
  annotationStrokeWidth,
  drawAnnotationStrokes as drawStrokesOnCanvas,
  normalizeAnnotationPoint as normalizePoint,
  shouldAppendAnnotationPoint as shouldAppendPoint,
  annotationStrokeToSvgPath as strokeToSvgPath,
  type AnnotationCanvasContext as StrokeCanvasContext,
} from '@cindy/maker-shared/image-annotation';

/** 一条手绘笔迹:归一化坐标点序列(0..1,相对图片自然尺寸)。 */
export type AnnotationStroke = ImageAnnotationStroke;

/** 进行中笔迹 path 的增量构建缓存(见 {@link extendDraftSvgPath})。 */
export interface DraftSvgPathCache {
  /** 已格式化进 `d` 的点数。 */
  count: number;
  width: number;
  height: number;
  d: string;
}

/**
 * 进行中笔迹的 path `d` 增量构建:绘制时每帧只格式化新增的点,避免长笔迹
 * 每帧全量重算(O(n²))。输出与 `strokeToSvgPath` 逐字相同——前两点及尺寸
 * 变化时回退全量计算(单点笔迹的"圆点"形态与多点形态不同)。
 */
export function extendDraftSvgPath(
  points: readonly AnnotationStroke['points'][number][],
  width: number,
  height: number,
  cache: DraftSvgPathCache | null,
): DraftSvgPathCache {
  const reusable =
    cache !== null &&
    cache.width === width &&
    cache.height === height &&
    cache.count >= 2 &&
    cache.count <= points.length;
  if (!reusable) {
    return {
      count: points.length,
      width,
      height,
      d: strokeToSvgPathImpl({ points: [...points] }, width, height),
    };
  }
  let d = cache.d;
  for (let i = cache.count; i < points.length; i++) {
    const p = points[i];
    d += ` L ${(p.x * width).toFixed(1)} ${(p.y * height).toFixed(1)}`;
  }
  return { count: points.length, width, height, d };
}
