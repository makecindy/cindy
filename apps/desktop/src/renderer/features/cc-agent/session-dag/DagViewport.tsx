import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { LayoutGrid, Map as MapIcon, PanelRightOpen, Scan } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cardSize, contentBounds } from './layout';
import type { DagNode, DagPoint, DagSizes } from './types';
import { copy } from './copy';

type Bounds = ReturnType<typeof contentBounds>;
type View = DagPoint & { k: number };
const initialView = { x: 0, y: 0, k: 1 };

export function DagViewport({
  nodes,
  positions,
  sizes,
  bounds,
  surface,
  children,
  tidy,
  navigatorRef,
  onOpenChat,
}: {
  onOpenChat?: () => void;
  nodes: Pick<DagNode, 'id'>[];
  positions: Record<string, DagPoint>;
  sizes?: DagSizes;
  bounds: Bounds;
  navigatorRef: RefObject<((p: DagPoint) => void) | null>;
  surface: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  tidy: () => Bounds;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(initialView);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [map, setMap] = useState(false);
  useImperativeHandle(
    navigatorRef,
    () => (p) =>
      setView((v) => {
        const k = Math.max(v.k, 0.9);
        return {
          k,
          x: size.width / 2 - p.x * k,
          y: size.height / 2 - p.y * k,
        };
      }),
    [size],
  );
  const pan = useRef<{ id: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const el = viewport.current!;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setSize({ width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const zoom = useCallback(
    (factor: number, anchor: DagPoint) =>
      setView((v) => {
        const k = Math.min(2, Math.max(0.05, v.k * factor));
        return {
          k,
          x: anchor.x - ((anchor.x - v.x) * k) / v.k,
          y: anchor.y - ((anchor.y - v.y) * k) / v.k,
        };
      }),
    [],
  );
  useEffect(() => {
    const el = viewport.current!;
    const wheel = (e: WheelEvent) => {
      const reading =
        e.target instanceof Element ? e.target.closest<HTMLElement>('[data-dag-reading]') : null;
      // Scroll long turns locally. Leave modified wheel/pinch gestures to the canvas.
      if (!e.ctrlKey && !e.metaKey && reading && reading.scrollHeight > reading.clientHeight)
        return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      zoom(
        Math.exp(-Math.max(-300, Math.min(300, e.deltaY * (e.deltaMode === 1 ? 16 : 1))) * 0.002),
        { x: e.clientX - box.left, y: e.clientY - box.top },
      );
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoom]);
  const fit = (b: Bounds) => {
    const el = viewport.current!;
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height) return;
    const w = b.width - b.left,
      h = b.height - b.top;
    const k = Math.min(1, width / w, height / h);
    setView({ k, x: (width - w * k) / 2 - b.left * k, y: (height - h * k) / 2 - b.top * k });
  };
  const frame = {
    x: -view.x / view.k,
    y: -view.y / view.k,
    w: size.width / view.k,
    h: size.height / view.k,
  };
  const left = Math.min(bounds.left, frame.x),
    top = Math.min(bounds.top, frame.y);
  const mapBox = [
    left,
    top,
    Math.max(bounds.width, frame.x + frame.w) - left,
    Math.max(bounds.height, frame.y + frame.h) - top,
  ];
  return (
    <div
      ref={viewport}
      role="region"
      aria-label={copy.canvasTitle}
      aria-description={copy.toolbar.addReference}
      tabIndex={0}
      className="relative h-full min-h-0 min-w-0 flex-1 touch-none overflow-hidden bg-background focus-visible:outline-offset-[-2px]"
      onFocus={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-dag-aside],[data-dag-resize]')) return;
        const card = target.closest('[data-dag-reference-editor]') ?? target.closest('[data-session-dag-card],[data-session-dag-draft]');
        if (!card) return;
        const box = card.getBoundingClientRect(),
          area = e.currentTarget.getBoundingClientRect();
        if (!area.width || !area.height) return;
        if (card.matches('[data-session-dag-draft],[data-dag-reference-editor]')) {
          // Keep the editor usable even after a drop at the viewport's lower-right corner.
          // Move the camera, not the draft's graph position, and preserve the user's zoom.
          const dx = Math.max(0, area.left - box.left) - Math.max(0, box.right - area.right);
          const dy = Math.max(0, area.top - box.top) - Math.max(0, box.bottom - area.bottom);
          if (dx || dy) setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
          return;
        }
        if (!target.matches(':focus-visible')) return;
        if (
          box.left < area.left ||
          box.right > area.right ||
          box.top < area.top ||
          box.bottom > area.bottom
        ) {
          const dx = (area.left + area.right - box.left - box.right) / 2,
            dy = (area.top + area.bottom - box.top - box.bottom) / 2;
          setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
        }
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        const center = { x: size.width / 2, y: size.height / 2 };
        if (['+', '=', '-', '0', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key))
          e.preventDefault();
        if (e.key === '0') fit(bounds);
        else if (['+', '=', '-'].includes(e.key)) zoom(e.key === '-' ? 0.8 : 1.25, center);
        else if (e.key.startsWith('Arrow'))
          setView((v) => ({
            ...v,
            x: v.x + (e.key === 'ArrowRight' ? -48 : e.key === 'ArrowLeft' ? 48 : 0),
            y: v.y + (e.key === 'ArrowDown' ? -48 : e.key === 'ArrowUp' ? 48 : 0),
          }));
      }}
      onPointerDown={(e) => {
        if (
          e.button !== 0 ||
          (e.target as Element).closest(
            'button,[data-session-dag-card],[data-session-dag-draft],svg[role="img"],[role="menu"]',
          ) ||
          !e.currentTarget.contains(e.target as Node)
        )
          return;
        pan.current = { id: e.pointerId, x: e.clientX - view.x, y: e.clientY - view.y };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const p = pan.current;
        if (p?.id === e.pointerId && p)
          setView((v) => ({ ...v, x: e.clientX - p.x, y: e.clientY - p.y }));
      }}
      onLostPointerCapture={() => {
        pan.current = null;
      }}
      onPointerCancel={() => {
        pan.current = null;
      }}
      onPointerUp={() => {
        pan.current = null;
      }}
    >
      <div
        ref={surface}
        data-dag-scale={view.k}
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: bounds.width,
          height: bounds.height,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
        }}
      >
        {children}
      </div>
      {!nodes.length && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-13 text-[var(--text-secondary)]">
          {copy.emptyHint}
        </div>
      )}
      {(nodes.length > 0 || onOpenChat) && (
        <>
          <div role="group" aria-label="画布视图工具" className="absolute bottom-3 left-3 flex gap-0.5 rounded-xl border border-border bg-popover p-1">
            {onOpenChat && (
              <Button size="sm" variant="secondary" tone="quiet" compact className="size-7 px-0 [&>svg]:shrink-0" title="打开对话" aria-label="打开对话" onClick={onOpenChat}>
                <PanelRightOpen size={15} />
              </Button>
            )}
            {nodes.length > 0 && (
              [
                [Scan, copy.toolbar.fit, () => fit(bounds)],
                [LayoutGrid, copy.toolbar.rearrange, () => fit(tidy())],
                [MapIcon, copy.toolbar.map, () => setMap(!map)],
              ] as const
            ).map(([Icon, label, action]) => (
              <Button
                key={label}
                size="sm"
                variant="secondary"
                tone="quiet"
                compact
                className="size-7 px-0 [&>svg]:shrink-0"
                title={label}
                aria-label={label}
                aria-pressed={Icon === MapIcon ? map : undefined}
                onClick={action}
              >
                <Icon size={15} />
              </Button>
            ))}
          </div>
          {map && (
            <svg
              role="img"
              aria-label={copy.toolbar.map}
              viewBox={mapBox.join(' ')}
              className="absolute bottom-3 right-3 h-20 w-[min(34%,9rem)] cursor-crosshair rounded-lg border border-border bg-popover"
              onClick={(e) => {
                const svg = e.currentTarget;
                const ctm = svg.getScreenCTM();
                if (!ctm) return;
                const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
                setView((v) => ({
                  ...v,
                  x: size.width / 2 - p.x * v.k,
                  y: size.height / 2 - p.y * v.k,
                }));
              }}
            >
              {nodes.map(
                (n) =>
                  positions[n.id] && (
                    <rect
                      key={n.id}
                      {...positions[n.id]}
                      {...cardSize(sizes, n.id)}
                      className="fill-[var(--text-secondary)]"
                    />
                  ),
              )}
              <rect
                x={frame.x}
                y={frame.y}
                width={frame.w}
                height={frame.h}
                fill="none"
                className="stroke-[var(--text-primary)]"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
        </>
      )}
    </div>
  );
}
