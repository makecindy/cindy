import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { containImageSize, type ImageDimensions } from './imageDisplaySize';

const PREVIEW_MAX_WIDTH = 224;
const PREVIEW_MAX_HEIGHT = 168;
const PREVIEW_GAP = 12;
const VIEWPORT_PADDING = 12;

interface PreviewPosition {
  top: number;
  left: number;
  side: 'above' | 'below';
  maxWidth: number;
  maxHeight: number;
}

interface ImageHoverPreviewProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  src: string;
  alt: string;
}

/**
 * 输入附件与消息图片文件 chip 共用的小图预览。
 *
 * portal 到 body，避免被消息流 / composer 的 overflow 裁掉；默认位于锚点上方
 * 12px，空间不足时翻到下方，并始终收在视口内。最大 224×168。
 */
export function ImageHoverPreview({ open, anchorRef, src, alt }: ImageHoverPreviewProps) {
  const [position, setPosition] = useState<PreviewPosition | null>(null);
  const [naturalSize, setNaturalSize] = useState<ImageDimensions | null>(null);

  useEffect(() => {
    setNaturalSize(null);
  }, [src]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const availableAbove = rect.top - PREVIEW_GAP - VIEWPORT_PADDING;
      const availableBelow = window.innerHeight - rect.bottom - PREVIEW_GAP - VIEWPORT_PADDING;
      const side =
        availableAbove >= PREVIEW_MAX_HEIGHT || availableAbove >= availableBelow
          ? 'above'
          : 'below';
      const availableHeight = side === 'above' ? availableAbove : availableBelow;
      const viewportPreviewWidth = Math.min(
        PREVIEW_MAX_WIDTH,
        Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2),
      );
      const halfPreviewWidth = viewportPreviewWidth / 2;
      const minLeft = VIEWPORT_PADDING + halfPreviewWidth;
      const maxLeft = window.innerWidth - VIEWPORT_PADDING - halfPreviewWidth;
      const anchorCenter = rect.left + rect.width / 2;

      setPosition({
        top: side === 'above' ? rect.top - PREVIEW_GAP : rect.bottom + PREVIEW_GAP,
        left:
          minLeft <= maxLeft
            ? Math.min(Math.max(anchorCenter, minLeft), maxLeft)
            : window.innerWidth / 2,
        side,
        maxWidth: viewportPreviewWidth,
        maxHeight: Math.max(0, Math.min(PREVIEW_MAX_HEIGHT, availableHeight)),
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    const scrollListenerOptions = { capture: true, passive: true } as const;
    window.addEventListener('scroll', updatePosition, scrollListenerOptions);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, scrollListenerOptions);
    };
  }, [anchorRef, open]);

  if (!open || !position) return null;

  const displaySize = naturalSize
    ? containImageSize(naturalSize, position.maxWidth, position.maxHeight)
    : null;

  return createPortal(
    <div
      className="pointer-events-none fixed z-50 overflow-hidden rounded-xl shadow-[var(--shadow-menu)]"
      style={{
        top: position.top,
        left: position.left,
        transform: position.side === 'above' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
        maxWidth: position.maxWidth,
        maxHeight: position.maxHeight,
      }}
    >
      <img
        src={src}
        alt={alt}
        className="max-w-full object-contain"
        style={{
          width: displaySize?.width,
          height: displaySize?.height,
          maxHeight: position.maxHeight,
        }}
        draggable={false}
        onLoad={(event) => {
          setNaturalSize({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          });
        }}
      />
    </div>,
    document.body,
  );
}
