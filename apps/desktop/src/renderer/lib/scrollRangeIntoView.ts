/** Reveal a text match inside nested scrollers. A scroll owner can exclude its
 * own container so its coordinator retains control of pagination and anchoring. */
function getRangeRect(range: Range): DOMRect | null {
  const rects = typeof range.getClientRects === 'function' ? range.getClientRects() : [];
  const rect =
    rects[0] ??
    (typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null);
  if (!rect) return null;
  if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.bottom === 0) return null;
  return rect;
}

export function scrollRangeIntoView(range: Range, stopBefore?: HTMLElement) {
  const element = range.startContainer.parentElement;
  if (!element) return;

  let ancestor: HTMLElement | null = element;
  while (ancestor && ancestor !== stopBefore) {
    const style = window.getComputedStyle(ancestor);
    const canScrollY =
      /(auto|scroll|overlay|hidden)/.test(style.overflowY) &&
      ancestor.scrollHeight > ancestor.clientHeight;
    const canScrollX =
      /(auto|scroll|overlay|hidden)/.test(style.overflowX) &&
      ancestor.scrollWidth > ancestor.clientWidth;
    if (!canScrollY && !canScrollX) {
      ancestor = ancestor.parentElement;
      continue;
    }

    const rect = getRangeRect(range);
    const containerRect = ancestor.getBoundingClientRect();
    if (!rect) return;
    if (canScrollY) {
      if (rect.top < containerRect.top) ancestor.scrollTop -= containerRect.top - rect.top;
      else if (rect.bottom > containerRect.bottom)
        ancestor.scrollTop += rect.bottom - containerRect.bottom;
    }
    if (canScrollX) {
      // Wrapped matches have differently sized fragments. Reveal their full
      // horizontal extent, while vertical navigation still starts at line one.
      const horizontalRect = typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect() : rect;
      const left = containerRect.left + ancestor.clientLeft;
      const right = left + ancestor.clientWidth;
      if (horizontalRect.left < left) ancestor.scrollLeft -= left - horizontalRect.left;
      else if (horizontalRect.right > right)
        ancestor.scrollLeft += horizontalRect.right - right;
    }
    ancestor = ancestor.parentElement;
  }

  if (stopBefore) return;
  const rect = getRangeRect(range);
  if (!rect || typeof window.scrollBy !== 'function') return;
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  if (rect.top < 0 || rect.bottom > viewportHeight) {
    window.scrollBy({
      top: rect.top < 0 ? rect.top : rect.bottom - viewportHeight,
      behavior: 'auto',
    });
  }
  if (rect.left < 0 || rect.right > viewportWidth) {
    window.scrollBy({
      left: rect.left < 0 ? rect.left : rect.right - viewportWidth,
      behavior: 'auto',
    });
  }
}
