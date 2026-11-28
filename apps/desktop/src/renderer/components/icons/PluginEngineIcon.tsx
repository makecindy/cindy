import { ANTIGRAVITY_MARK_DATA_URL, ANTIGRAVITY_MARK_PATH } from '@cindy/maker-shared/branding';
import { Puzzle } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The plugin's own artwork, or a puzzle coloured to match its surrounding controls. */
export function PluginEngineIcon({
  size,
  className,
  iconDataUrl,
}: {
  size: number;
  className?: string;
  iconDataUrl?: string | null;
}) {
  if (iconDataUrl === ANTIGRAVITY_MARK_DATA_URL) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden
        className={cn('shrink-0', className)}>
        <path d={ANTIGRAVITY_MARK_PATH} />
      </svg>
    );
  }
  if (iconDataUrl) {
    return (
      <img
        src={iconDataUrl}
        alt=""
        aria-hidden
        draggable={false}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="shrink-0 object-contain"
      />
    );
  }
  return (
    <Puzzle
      size={size}
      aria-hidden
      className={cn('shrink-0', className ?? 'text-[var(--text-secondary)]')}
    />
  );
}
