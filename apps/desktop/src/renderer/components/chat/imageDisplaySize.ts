export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * 按 contain 语义把图片收进边界，且不放大超过自然尺寸。
 *
 * 不能只依赖 CSS max-width / max-height：只有 viewBox、没有 width / height
 * 的 SVG 在 shrink-to-fit 容器里会形成循环尺寸计算，资源已加载却渲染成 0×0。
 */
export function containImageSize(
  natural: ImageDimensions,
  maxWidth: number,
  maxHeight: number,
): ImageDimensions | null {
  if (
    !Number.isFinite(natural.width) ||
    !Number.isFinite(natural.height) ||
    !Number.isFinite(maxWidth) ||
    !Number.isFinite(maxHeight) ||
    natural.width <= 0 ||
    natural.height <= 0 ||
    maxWidth <= 0 ||
    maxHeight <= 0
  ) {
    return null;
  }

  const scale = Math.min(1, maxWidth / natural.width, maxHeight / natural.height);
  return {
    width: natural.width * scale,
    height: natural.height * scale,
  };
}
