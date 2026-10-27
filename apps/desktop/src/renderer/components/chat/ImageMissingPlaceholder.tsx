/**
 * ImageMissingPlaceholder.tsx (image-local-cache M9 / F4)
 * ---------------------------------------------------------------------------
 * Renders a friendly placeholder when an image referenced by an xdt-image://
 * URL fails to load (file deleted, cache cleared, F6 fallback expired, etc.).
 *
 * Used by:
 *   - UserMessage  → user-uploaded image attachment that 404s.
 *   - MarkdownRenderer → inline images in assistant messages that 404.
 *   - ImageLightbox is the exception — it closes on error rather than swap to
 *     this card, since the lightbox is meant to magnify a known-good image.
 */

import { ImageOff, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';

interface ImageMissingPlaceholderProps {
  status?: 'loading' | 'missing' | 'unavailable';
  filename: string;
  className?: string;
  /** Pixel cap to roughly match the original image bounds. */
  maxWidth?: number;
}

export function ImageMissingPlaceholder({
  status = 'unavailable',
  filename,
  className,
  maxWidth = 280,
}: ImageMissingPlaceholderProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2',
        'rounded-[12px] border border-dashed',
        // These tokens are HSL channels: `var(--border)` alone is invalid CSS and drew a black border.
        'border-border bg-muted',
        'p-4 text-muted-foreground',
        className,
      )}
      style={{ maxWidth, minHeight: 140 }}
    >
      {status === 'loading' ? (
        <span
          className="inline-flex animate-spin motion-reduce:animate-none text-[var(--text-tertiary)]"
          aria-hidden="true"
        >
          <LoaderCircle className="h-8 w-8" />
        </span>
      ) : (
        <ImageOff className="h-8 w-8 text-[var(--text-tertiary)]" aria-hidden="true" />
      )}
      <div className="text-xs font-medium">
        {t(
          status === 'missing'
            ? 'chat.imageMissing.title'
            : status === 'loading'
              ? 'chat.imageMissing.loading'
              : 'chat.imageMissing.unavailable',
        )}
      </div>
      {/* v5: 原生 title 替换为 Radix Tooltip(mono) — 文件名走 mono 风格。 */}
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div className="max-w-full truncate text-11 text-[var(--text-tertiary)]">{filename}</div>
        </Tooltip.Trigger>
        <Tooltip.Content variant="mono">{filename}</Tooltip.Content>
      </Tooltip.Root>
    </div>
  );
}
