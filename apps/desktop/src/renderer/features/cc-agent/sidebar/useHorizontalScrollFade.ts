import { useCallback, useEffect, useState } from 'react';

/**
 * 横向滑动的一行(侧栏顶部标签、电脑行):放不下时可滑动，被遮住的一侧做边缘渐隐，
 * 竖向滚轮在这一行上改为横向滑动。口径同右栏 TabBar:只在真有溢出的一侧开 mask,
 * 透出宿主自己的背景，深浅色与任意主题都成立。
 * 用回调 ref:这一行会随标签切换出现 / 消失，元素换了要重新挂监听。
 * `selectedKey` 变化时把行内匹配 `selectedSelector` 的元素滑进可见区。
 */
export function useHorizontalScrollFade(
  selectedKey: unknown,
  selectedSelector: string,
): [(element: HTMLElement | null) => void, { WebkitMaskImage?: string; maskImage?: string }] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  const update = useCallback(() => {
    if (!element) return;
    const left = element.scrollLeft > 1;
    const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setEdge((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, [element]);
  useEffect(() => {
    if (!element) return undefined;
    update();
    element.addEventListener('scroll', update, { passive: true });
    const onWheel = (event: WheelEvent) => {
      if (element.scrollWidth <= element.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      element.scrollLeft += event.deltaY;
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      element.removeEventListener('wheel', onWheel);
      observer?.disconnect();
    };
  }, [element, update]);
  useEffect(() => {
    element?.querySelector<HTMLElement>(selectedSelector)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    update();
  }, [element, selectedKey, selectedSelector, update]);
  const mask =
    edge.left || edge.right
      ? `linear-gradient(to right, ${edge.left ? 'transparent 0, black 24px' : 'black 0'}, ${
          edge.right ? 'black calc(100% - 24px), transparent 100%' : 'black 100%'
        })`
      : undefined;
  return [setElement, mask ? { WebkitMaskImage: mask, maskImage: mask } : {}];
}
