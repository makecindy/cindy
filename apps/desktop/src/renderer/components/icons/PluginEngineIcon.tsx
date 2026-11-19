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
