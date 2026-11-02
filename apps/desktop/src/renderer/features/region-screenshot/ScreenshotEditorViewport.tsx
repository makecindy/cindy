import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Minus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RegionSize } from '../../../shared/regionScreenshot';
import { isPreciseWheel, pinchZoomFactor } from './trackpad';

/** Image coordinates stay unchanged: zoom/scroll only transform the editing viewport. */
export function ScreenshotEditorViewport({ image, tools, children, onAction, onMinimize, onClose }: {
  image: RegionSize | null; tools: ReactNode; children: ReactNode;
  onAction: (action: 'ask' | 'translate' | 'explain' | 'extract') => void;
  onMinimize: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** 同一帧内连续的捏合事件按最新倍率叠乘, 不读渲染前的旧值。 */
  const scaleRef = useRef(1);
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [zoom, setZoom] = useState<number | 'width' | 'fit'>('width');
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setSize({ width: node.clientWidth, height: node.clientHeight }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const scale = !image ? 1 : typeof zoom === 'number' ? zoom : Math.max(0.01, Math.min(
    1, (size.width - 32) / image.width, zoom === 'fit' ? (size.height - 32) / image.height : Infinity,
  ));
  scaleRef.current = scale;
  /** `anchor` 是视口内的客户端坐标; 缩放后它下面仍是同一个图像像素 (缺省为视口中心)。 */
  const changeZoom = (next: number, anchor?: { x: number; y: number }) => {
    const node = scrollRef.current;
    const content = contentRef.current;
    const ratio = Math.max(0.01, Math.min(4, next));
    const before = scaleRef.current;
    scaleRef.current = ratio;
    setZoom(ratio);
    if (!node || !content) return;
    const viewport = node.getBoundingClientRect();
    const point = anchor ?? { x: viewport.left + node.clientWidth / 2, y: viewport.top + node.clientHeight / 2 };
    const rect = content.getBoundingClientRect();
    const imageX = (point.x - rect.left) / before, imageY = (point.y - rect.top) / before;
    requestAnimationFrame(() => {
      const moved = content.getBoundingClientRect();
      node.scrollLeft += moved.left + imageX * ratio - point.x;
      node.scrollTop += moved.top + imageY * ratio - point.y;
    });
  };
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      // 触控板捏合 (ctrlKey) 与 ⌘ + 双指滑动连续缩放; 鼠标滚轮每格一级。以指针为中心。
      const factor = isPreciseWheel(event) ? pinchZoomFactor(event.deltaY) : event.deltaY < 0 ? 1.1 : 1 / 1.1;
      changeZoom(scaleRef.current * factor, { x: event.clientX, y: event.clientY });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  });
  return <div className="flex h-screen flex-col bg-[var(--surface)] text-[var(--text-primary)]">
    <div className="z-10 shrink-0 border-b border-[var(--border-default)] p-2">
      <div className="flex flex-wrap items-center gap-1 pb-2 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]">
        <Button size="xs" variant="secondary" aria-label={t('remoteDesktop.zoomOut')} onClick={() => changeZoom(scale / 1.2)}>−</Button>
        <span className="w-12 text-center text-12 tabular-nums" aria-live="polite">{Math.round(scale * 100)}%</span>
        <Button size="xs" variant="secondary" aria-label={t('remoteDesktop.zoomIn')} onClick={() => changeZoom(scale * 1.2)}>+</Button>
        <Button size="xs" variant="secondary" tone="quiet" onClick={() => setZoom('width')}>{t('regionScreenshot.editor.fitWidth')}</Button>
        <Button size="xs" variant="secondary" tone="quiet" onClick={() => setZoom('fit')}>{t('remoteDesktop.fit')}</Button>
        <Button size="xs" variant="secondary" tone="quiet" onClick={() => changeZoom(1)}>{t('remoteDesktop.actualSize')}</Button>
        <span className="min-w-8 flex-1" />
        <span className="text-12 tabular-nums text-[var(--text-secondary)]">{image && `${image.width} × ${image.height}`}</span>
        <details className="relative text-12 [-webkit-app-region:no-drag]">
          <summary className="cursor-pointer rounded-full px-3 py-1.5">Cindy</summary>
          <div className="absolute right-0 top-full z-20 flex min-w-40 flex-col rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1">
            {(['ask', 'translate', 'explain', 'extract'] as const).map((action) => <Button key={action} size="xs" variant="secondary" tone="quiet" onClick={() => onAction(action)}>{t('regionScreenshot.ai.' + action)}</Button>)}
          </div>
        </details>
        <Button size="xs" variant="secondary" tone="quiet" className="w-7 px-0" aria-label={t('titleBar.minimize')} onClick={onMinimize}><Minus size={14} /></Button>
        <Button size="xs" variant="secondary" tone="quiet" className="w-7 px-0" aria-label={t('titleBar.close')} onClick={onClose}><X size={14} /></Button>
      </div>
      {image && tools}
    </div>
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-4" tabIndex={0} aria-label={t('regionScreenshot.live.edit')}>
      {image ? <div ref={contentRef} className="relative mx-auto" style={{ width: image.width * scale, height: image.height * scale }}>
        <div className="absolute left-0 top-0 origin-top-left" style={{ width: image.width, height: image.height, transform: `scale(${scale})` }}>{children}</div>
      </div> : <p role="status" className="text-13 text-[var(--text-secondary)]">{t('regionScreenshot.editor.loading')}</p>}
    </div>
  </div>;
}
