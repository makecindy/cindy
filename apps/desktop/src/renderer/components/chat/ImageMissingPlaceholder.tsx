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
import { Button } from '@/components/ui/button';
import { SHARE_EXCLUDE_ATTR } from '@/lib/shareConversationImage';

interface ImageMissingPlaceholderProps {
  status?: 'loading' | 'missing' | 'unavailable';
  filename: string;
  className?: string;
  /** Pixel cap to roughly match the original image bounds. */
  maxWidth?: number;
  /** Remount a readable image after a transient display failure; never regenerate it. */
  onRetry?: () => void;
  onOpen?: () => void;
}

export function ImageMissingPlaceholder({
  status = 'unavailable',
  filename,
  className,
  maxWidth = 280,
  onRetry,
  onOpen,
}: ImageMissingPlaceholderProps) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'flex flex-col items-center justify-center gap-2',
        'rounded-xl border border-dashed',
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
      <span className="text-xs font-medium">
        {t(
          status === 'missing'
            ? 'chat.imageMissing.title'
            : status === 'loading'
              ? 'chat.imageMissing.loading'
              : 'chat.imageMissing.unavailable',
        )}
      </span>
      {/* v5: 原生 title 替换为 Radix Tooltip(mono) — 文件名走 mono 风格。 */}
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span className="max-w-full truncate text-11 text-[var(--text-tertiary)]">{filename}</span>
        </Tooltip.Trigger>
        <Tooltip.Content variant="mono">{filename}</Tooltip.Content>
      </Tooltip.Root>
      {status === 'unavailable' && ([
        { label: t('commonUi.retry'), activate: onRetry },
        { label: t('chat.media.openWithApp'), activate: onOpen },
      ].map(({ label, activate }) => activate && (
        <Button
          {...{ [SHARE_EXCLUDE_ATTR]: '' }}
          key={label}
          type="button"
          variant="secondary"
          size="sm"
          aria-label={`${label}: ${filename}`}
          onKeyDown={(event) => {
            // Linked images also activate their outer target on Enter/Space.
            // Keep the button's native keyboard click without activating that link.
            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
          }}
          onAuxClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            activate();
          }}
        >
          {label}
        </Button>
      )))}
    </span>
  );
}
