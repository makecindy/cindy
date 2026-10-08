/**
 * AnnotationStrokesSvg — 矢量标注笔迹的 SVG 叠加层(lightbox / 托盘缩略图 /
 * hover 预览共用)。
 *
 * 分层顺序必须与 canvas 烧录(`drawAnnotationStrokes`)一致:**先全部白描边、
 * 再全部红线**。旧实现按笔迹逐条画「描边 + 红线」,后画笔迹的白描边会盖住
 * 先画笔迹的红线,预览与发出去的烧录图在笔迹交叉处不一致。
 *
 * 坐标系:viewBox = 图片自然尺寸,归一化点 × 自然尺寸 = path 坐标,线宽也按
 * 自然尺寸算,与烧录像素级一致。`preserveAspectRatio` 默认 `none`(容器与图片
 * 盒同尺寸);托盘缩略图是 object-cover,传 `xMidYMid slice` 即与其裁切一致。
 *
 * 性能:已提交笔迹的 path 串按 strokes 身份 memo,组件本身 memo——绘制中父组件
 * 的高频重渲染不会重算全部笔迹。进行中的笔迹不走 React:调用方传 `draftRefs`,
 * 本组件在两个图层末尾各挂一条空 path,由调用方直接写 `d`(rAF 合帧),与已提交
 * 笔迹处于同一图层,绘制中的交叉观感与松手后一致。
 */

import { memo, useMemo, type CSSProperties, type Ref } from 'react';
import {
  ANNOTATION_OUTLINE_COLOR,
  ANNOTATION_STROKE_COLOR,
  annotationOutlineWidth,
  annotationStrokeWidth,
  strokeToSvgPath,
  type AnnotationStroke,
} from './lightboxAnnotations';

export interface AnnotationDraftPathRefs {
  outline: Ref<SVGPathElement>;
  stroke: Ref<SVGPathElement>;
}

interface AnnotationStrokesSvgProps {
  strokes: readonly AnnotationStroke[];
  /** 图片自然尺寸(viewBox 与线宽基准)。 */
  naturalWidth: number;
  naturalHeight: number;
  preserveAspectRatio?: string;
  className?: string;
  style?: CSSProperties;
  /** 进行中笔迹的两条 path(描边层 / 红线层),`d` 由调用方直接写入。 */
  draftRefs?: AnnotationDraftPathRefs;
}

export const AnnotationStrokesSvg = memo(function AnnotationStrokesSvg({
  strokes,
  naturalWidth,
  naturalHeight,
  preserveAspectRatio = 'none',
  className,
  style,
  draftRefs,
}: AnnotationStrokesSvgProps) {
  const paths = useMemo(
    () =>
      strokes
        .map((stroke) => strokeToSvgPath(stroke, naturalWidth, naturalHeight))
        .filter((d) => d.length > 0),
    [strokes, naturalWidth, naturalHeight],
  );
  const strokeWidth = annotationStrokeWidth(naturalWidth, naturalHeight);
  const outlineWidth = annotationOutlineWidth(strokeWidth);
  return (
    <svg
      viewBox={`0 0 ${naturalWidth} ${naturalHeight}`}
      preserveAspectRatio={preserveAspectRatio}
      className={className}
      style={style}
      aria-hidden
    >
      <g
        data-annotation-layer="outline"
        fill="none"
        stroke={ANNOTATION_OUTLINE_COLOR}
        strokeWidth={outlineWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {paths.map((d, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 笔迹列表只增/尾删,index 稳定。
          <path key={i} d={d} />
        ))}
        {draftRefs ? <path ref={draftRefs.outline} data-annotation-draft="" /> : null}
      </g>
      <g
        data-annotation-layer="stroke"
        fill="none"
        stroke={ANNOTATION_STROKE_COLOR}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {paths.map((d, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 同上。
          <path key={i} d={d} />
        ))}
        {draftRefs ? <path ref={draftRefs.stroke} data-annotation-draft="" /> : null}
      </g>
    </svg>
  );
});
