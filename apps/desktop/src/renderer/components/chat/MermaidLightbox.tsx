/**
 * MermaidLightbox
 * ---------------------------------------------------------------------------
 * Full-screen mermaid SVG viewer with pan + zoom.
 *
 * Mirrors ImageLightbox's conventions (Portal, overlay click closes, Esc closes,
 * 200ms fade, scroll lock) and adds:
 *   - trackpad/mouse wheel pan, with ctrl/cmd+wheel zoom at cursor
 *   - drag to pan (when zoomed in)
 *   - double-click to reset
 *   - bottom toolbar: zoom out / level / zoom in / annotate (host-provided) /
 *     copy (PNG + source) / close
 *
 * SVG (vector) stays sharp at any zoom level — no rasterization step.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Minus, Pen, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { resolveExportBackground, svgToPngBlob } from '@/lib/rasterizeToImage';
import { useCopyAsImage } from './useCopyAsImage';
import {
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  LIGHTBOX_WHEEL_IDLE_MS,
  LIGHTBOX_ZOOM_STEP,
  clampScale,
  type LightboxViewport,
  normalizeWheelDelta,
  wheelZoomFactor,
  zoomAtPoint,
} from './lightboxGestures';

interface MermaidLightboxProps {
  svg: string;
  /** mermaid 原始源码(可选):随「复制图片」附带 text/plain 表示。 */
  source?: string;
  /**
   * 「标注」入口(可选):由宿主提供——先关本 lightbox 再打开 ImageLightbox
   * 标注层(两层全屏叠加会打架:Esc/关闭链、滚轮手势都会互抢)。不传则不
   * 显示按钮(文件浏览器等无聊天会话的宿主没有标注出口)。
   */
  onAnnotate?: () => void;
  onClose: () => void;
}

export function MermaidLightbox({ svg, source, onAnnotate, onClose }: MermaidLightboxProps) {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isWheeling, setIsWheeling] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const isClosingRef = useRef(false);
  const isWheelingRef = useRef(false);
  const wheelIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<LightboxViewport>({ scale: 1, tx: 0, ty: 0 });

  // 复制为图片:光栅化用 props 的 SVG 字符串(固有尺寸,与当前缩放无关),
  // 实底色取 SVG 所在卡片的主题底色(overlay 是半透明遮罩,不可取);plainText
  // 附带 mermaid 源码(有传才带)。
  // 标注入口不在此处——聊天块工具栏已提供,双层 lightbox 会打架(Esc/关闭链)。
  const { copiedImage, copyAsImage } = useCopyAsImage(async () => ({
    blob: await svgToPngBlob(svg, {
      background: resolveExportBackground(cardRef.current),
    }),
    plainText: source,
  }));

  useEffect(() => {
    const raf = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Single writer for scale/translate: keeps the synchronous `viewportRef`
  // (read by the once-bound native wheel listener + drag handlers) in lockstep
  // with React state, so gesture handlers never observe a stale closure.
  const applyViewport = useCallback((next: LightboxViewport) => {
    viewportRef.current = next;
    setScale(next.scale);
    setTranslate({ x: next.tx, y: next.ty });
  }, []);

  const markWheeling = useCallback(() => {
    if (!isWheelingRef.current) {
      isWheelingRef.current = true;
      setIsWheeling(true);
    }
    if (wheelIdleTimerRef.current) clearTimeout(wheelIdleTimerRef.current);
    wheelIdleTimerRef.current = setTimeout(() => {
      isWheelingRef.current = false;
      setIsWheeling(false);
      wheelIdleTimerRef.current = null;
    }, LIGHTBOX_WHEEL_IDLE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (wheelIdleTimerRef.current) clearTimeout(wheelIdleTimerRef.current);
    };
  }, []);

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsVisible(false);
    setTimeout(() => onClose(), 200);
  }, [onClose]);

  // Esc closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose]);

  // Scroll lock
  useEffect(() => {
    const container = document.querySelector('[data-scroll-container]') as HTMLElement | null;
    if (container) container.style.overflowY = 'hidden';
    return () => {
      if (container) container.style.overflowY = '';
    };
  }, []);

  // Native wheel listener (passive: false) is required so the full-screen viewer
  // can own trackpad pinch/scroll gestures without browser-page scrolling.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();
      const current = viewportRef.current;

      // macOS/Chromium deliver a trackpad pinch as a wheel event with ctrlKey
      // set (metaKey also covers ⌘+wheel); a plain two-finger scroll has
      // neither. So pinch / ctrl / ⌘ + wheel = zoom, everything else = pan.
      const isZoomGesture = e.ctrlKey || e.metaKey;
      if (isZoomGesture) {
        markWheeling();
        const rect = stage.getBoundingClientRect();
        const point = {
          // Cursor position relative to stage center (the transform origin).
          cx: e.clientX - rect.left - rect.width / 2,
          cy: e.clientY - rect.top - rect.height / 2,
        };
        const next = zoomAtPoint(
          current,
          point,
          wheelZoomFactor(e.deltaY, e.deltaMode),
          LIGHTBOX_MIN_SCALE,
          LIGHTBOX_MAX_SCALE,
        );
        if (next !== current) applyViewport(next);
        return;
      }

      // Pan only when zoomed in — at fit scale the diagram already fills the
      // stage and there is nothing to pan to (also ignore no-op deltas).
      if (current.scale <= 1 || (e.deltaX === 0 && e.deltaY === 0)) return;
      markWheeling();
      applyViewport({
        ...current,
        tx: current.tx - normalizeWheelDelta(e.deltaX, e.deltaMode),
        ty: current.ty - normalizeWheelDelta(e.deltaY, e.deltaMode),
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [applyViewport, markWheeling]);

  function handleMouseDown(e: React.MouseEvent) {
    // Only left button initiates drag.
    if (e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
    const current = viewportRef.current;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      tx: current.tx,
      ty: current.ty,
    };
  }

  // Mouse move + up bound to window so dragging continues even if cursor leaves
  // the SVG. Only attached while isDragging — keeps idle listener count at zero.
  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: globalThis.MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      applyViewport({
        scale: viewportRef.current.scale,
        tx: start.tx + (e.clientX - start.x),
        ty: start.ty + (e.clientY - start.y),
      });
    };
    const onUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [applyViewport, isDragging]);

  function reset() {
    applyViewport({ scale: 1, tx: 0, ty: 0 });
  }

  function zoomBy(factor: number) {
    const current = viewportRef.current;
    const nextScale = clampScale(
      current.scale * factor,
      LIGHTBOX_MIN_SCALE,
      LIGHTBOX_MAX_SCALE,
    );
    if (nextScale === current.scale) return;
    applyViewport({ ...current, scale: nextScale });
  }

  // Overlay click closes — but only on the bare overlay, not on the SVG/toolbar.
  // Drag-end on the overlay would otherwise close after a long pan gesture.
  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) handleClose();
  }

  const overlay = (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'var(--overlay-lightbox)',
        transition: 'opacity 200ms ease',
        opacity: isVisible ? 1 : 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
      onClick={handleOverlayClick}
    >
      <div
        ref={stageRef}
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: isDragging ? 'grabbing' : 'grab',
          // Wheel handled via native listener above.
        }}
        onMouseDown={handleMouseDown}
        onDoubleClick={reset}
      >
        <div
          ref={cardRef}
          className={cn(
            'rounded-[12px] border border-[var(--msg-code-block-border)]',
            'bg-[var(--msg-code-block-bg)]',
            'p-6',
            // Force the inner mermaid <svg> (which comes with intrinsic
            // width/height) to fill this card; preserveAspectRatio keeps it
            // from distorting.
            '[&>svg]:!w-full [&>svg]:!h-full [&>svg]:!max-w-none [&>svg]:!max-h-none',
          )}
          style={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            transformOrigin: 'center center',
            transition: isDragging || isWheeling ? 'none' : 'transform 80ms ease-out',
            // Fixed stage box so scale=1 means "SVG fits the viewport". Without
            // this the SVG renders at its mermaid-emitted intrinsic size and
            // looks tiny on a 2K screen.
            width: 'min(calc(100vw - 80px), 1800px)',
            height: 'calc(100vh - 140px)',
            userSelect: 'none',
            pointerEvents: 'none',
            boxShadow: 'var(--shadow-menu)',
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      {/* Toolbar */}
      <div
        className={cn(
          'absolute bottom-6 left-1/2 -translate-x-1/2',
          'flex items-center gap-1 rounded-full',
          'border border-[var(--lightbox-toolbar-border)] bg-[var(--lightbox-toolbar-bg)] px-2 py-1',
          'backdrop-blur',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <ToolbarButton
          onClick={() => zoomBy(1 / LIGHTBOX_ZOOM_STEP)}
          label={t('chat.mermaidLightbox.zoomOut')}
        >
          <Minus className="h-4 w-4" />
        </ToolbarButton>
        <span className="px-2 text-12 tabular-nums text-[var(--lightbox-toolbar-fg)] select-none">
          {Math.round(scale * 100)}%
        </span>
        <ToolbarButton
          onClick={() => zoomBy(LIGHTBOX_ZOOM_STEP)}
          label={t('chat.mermaidLightbox.zoomIn')}
        >
          <Plus className="h-4 w-4" />
        </ToolbarButton>
        <div className="mx-1 h-5 w-px bg-[var(--lightbox-toolbar-border)]" />
        {/* 复位缩放不占按钮位:双击空白处即可复位(handleMouseDown 链上的
            onDoubleClick={reset}),位置让给更高频的「标注」。 */}
        {onAnnotate ? (
          <ToolbarButton onClick={onAnnotate} label={t('chat.mermaid.annotate')}>
            <Pen className="h-4 w-4" />
          </ToolbarButton>
        ) : null}
        <ToolbarButton
          onClick={copyAsImage}
          label={copiedImage ? t('chat.mermaid.copied') : t('chat.mermaid.copy')}
        >
          {copiedImage ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </ToolbarButton>
        <ToolbarButton onClick={handleClose} label={t('chat.mermaidLightbox.close')}>
          <X className="h-4 w-4" />
        </ToolbarButton>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

function ToolbarButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center',
        'rounded-full text-[var(--lightbox-toolbar-fg)]',
        'hover:bg-[var(--lightbox-toolbar-hover-bg)] hover:text-[var(--lightbox-toolbar-fg-hover)]',
      )}
    >
      {children}
    </button>
  );
}
