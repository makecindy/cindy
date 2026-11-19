export function isManagedImageUrl(url: string): boolean {
  return url.startsWith('xdt-image://') || url.startsWith('cindy-media://');
}

export function readImageAnnotations(image: Record<string, unknown>) {
  if (typeof image.annotationSourceUrl !== 'string' || !isManagedImageUrl(image.annotationSourceUrl)) return {};
  const strokes = coerceAnnotationStrokes(image.annotationStrokes);
  return strokes ? { annotationSourceUrl: image.annotationSourceUrl, annotationStrokes: strokes } : {};
}

/** 校验并复制持久化笔迹数组;任何一处形状不合法返回 null(整体丢弃)。 */
function coerceAnnotationStrokes(
  x: unknown,
): Array<{ points: Array<{ x: number; y: number }> }> | null {
  if (!Array.isArray(x) || x.length === 0) return null;
  const strokes: Array<{ points: Array<{ x: number; y: number }> }> = [];
  for (const raw of x) {
    if (!raw || typeof raw !== 'object') return null;
    const points = (raw as { points?: unknown }).points;
    if (!Array.isArray(points) || points.length === 0) return null;
    const copied: Array<{ x: number; y: number }> = [];
    for (const p of points) {
      // p 可能是 null / 原始值:先判对象再取值,否则解引用直接 throw,
      // 一条坏笔迹记录会炸掉整个会话的消息加载(review P2)。
      if (!p || typeof p !== 'object') return null;
      const px = (p as { x?: unknown }).x;
      const py = (p as { y?: unknown }).y;
      if (
        typeof px !== 'number' ||
        typeof py !== 'number' ||
        !Number.isFinite(px) ||
        !Number.isFinite(py)
      ) {
        return null;
      }
      copied.push({ x: px, y: py });
    }
    strokes.push({ points: copied });
  }
  return strokes;
}
