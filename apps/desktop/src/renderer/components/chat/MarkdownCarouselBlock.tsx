/**
 * MarkdownCarouselBlock
 * ---------------------------------------------------------------------------
 * Renders a ````carousel fenced block whose slides are delimited by
 * `<!-- slide -->`. Each slide is rendered through the host MarkdownRenderer
 * callback so images, remote-media rewriting, and document lightbox galleries
 * stay consistent with the surrounding Markdown surface.
 */

import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { splitCarouselSlides } from '@cindy/maker-shared/markdown-carousel';

import { cn } from '@/lib/utils';
import { CHAT_ICON_BUTTON_CLASS } from './chatChrome';

interface MarkdownCarouselBlockProps {
  raw: string;
  renderSlide: (slideMarkdown: string, slideIndex: number) => ReactNode;
  fallback: ReactNode;
  sourceLine?: number;
}

const MAX_DOT_INDICATORS = 12;

export const MarkdownCarouselBlock = memo(function MarkdownCarouselBlock({
  raw,
  renderSlide,
  fallback,
  sourceLine,
}: MarkdownCarouselBlockProps) {
  const { t } = useTranslation();
  const slides = useMemo(() => splitCarouselSlides(raw), [raw]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex((prev) => (slides.length === 0 ? 0 : Math.min(prev, slides.length - 1)));
  }, [slides.length]);

  const safeIndex = slides.length === 0 ? 0 : Math.min(activeIndex, slides.length - 1);

  const step = useCallback(
    (delta: number) => {
      if (slides.length <= 1) return;
      setActiveIndex((prev) => (prev + delta + slides.length) % slides.length);
    },
    [slides.length],
  );

  if (slides.length === 0) {
    return <>{fallback}</>;
  }

  const showControls = slides.length > 1;
  const stageStyle = { '--md-image-margin-y': '0px' } as CSSProperties;

  return (
    <div
      data-markdown-carousel
      data-source-line={sourceLine}
      className={cn(
        'my-3 overflow-hidden rounded-xl border',
        'border-[var(--msg-code-block-border)] bg-[var(--msg-code-block-bg)]',
      )}
      onKeyDown={(event) => {
        if (!showControls) return;
        const target = event.target as HTMLElement | null;
        if (target?.isContentEditable || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') {
          return;
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          event.stopPropagation();
          step(-1);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          event.stopPropagation();
          step(1);
        }
      }}
    >
      <div
        data-markdown-carousel-slide={safeIndex}
        className="flex min-h-[120px] flex-col items-center justify-center p-4 [&_p]:text-center"
        style={stageStyle}
      >
        {renderSlide(slides[safeIndex], safeIndex)}
      </div>

      {showControls ? (
        <div
          className={cn(
            'flex items-center justify-between gap-3 border-t px-3 py-2',
            'border-[var(--msg-code-block-border)] bg-[var(--surface-base)]',
          )}
        >
          <button
            type="button"
            aria-label={t('chat.media.prevImage')}
            onClick={() => step(-1)}
            className={cn(
              CHAT_ICON_BUTTON_CLASS,
              'h-7 w-7 border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-secondary)]',
              'transition-[color,background-color] duration-[var(--motion-fast)]',
              'hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          <div className="flex items-center gap-2">
            {slides.length <= MAX_DOT_INDICATORS ? (
              <div className="flex items-center gap-1.5" role="tablist">
                {slides.map((_, index) => {
                  const selected = index === safeIndex;
                  return (
                    <button
                      key={index}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-label={`${index + 1} / ${slides.length}`}
                      onClick={() => setActiveIndex(index)}
                      className={cn(
                        'h-2 rounded-full transition-all duration-[var(--motion-fast)]',
                        selected
                          ? 'w-5 bg-[var(--text-primary)]'
                          : 'w-2 bg-[var(--border-default)] hover:bg-[var(--text-secondary)]',
                      )}
                    />
                  );
                })}
              </div>
            ) : null}
            <span
              data-markdown-carousel-counter
              className="text-12 tabular-nums text-[var(--text-secondary)]"
            >
              {safeIndex + 1} / {slides.length}
            </span>
          </div>

          <button
            type="button"
            aria-label={t('chat.media.nextImage')}
            onClick={() => step(1)}
            className={cn(
              CHAT_ICON_BUTTON_CLASS,
              'h-7 w-7 border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-secondary)]',
              'transition-[color,background-color] duration-[var(--motion-fast)]',
              'hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
});
