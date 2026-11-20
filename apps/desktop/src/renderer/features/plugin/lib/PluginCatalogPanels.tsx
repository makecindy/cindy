import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';

/** Short tabs must not clamp the scroller above the sticky tab bar. */
export function PluginCatalogPanels({ scrollRef, query, children }: {
  scrollRef: RefObject<HTMLElement | null>; query: string; children: ReactNode;
}) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const root = scrollRef.current, element = panel;
    if (!root || !element) return;
    const tabs = root.querySelector<HTMLElement>('.sticky');
    const measure = () => {
      element.style.minHeight = `${Math.max(0, root.clientHeight - (tabs?.offsetHeight ?? 0))}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (tabs) observer.observe(tabs);
    return () => observer.disconnect();
  }, [panel, scrollRef, query]);
  return <div ref={setPanel} className="min-w-0">{children}</div>;
}
