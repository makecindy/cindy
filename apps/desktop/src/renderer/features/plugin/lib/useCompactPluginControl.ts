import { useLayoutEffect, useRef, useState } from 'react';

export function useCompactPluginControl(maxWidth: number, containerSelector: string) {
  const ref = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const container = ref.current?.closest(containerSelector);
    if (!container) return;
    const update = () => {
      const width = container.getBoundingClientRect().width;
      setCompact(width > 0 && width <= maxWidth);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [maxWidth, containerSelector]);
  return [ref, compact] as const;
}
