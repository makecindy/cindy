/**
 * Shared Plugin icon renderer for catalog, detail, and composer surfaces.
 * Package assets win; missing assets use a theme-aware functional symbol.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import {
  CalendarDays,
  Code2,
  Image as ImageIcon,
  MessageCircle,
  Puzzle,
  Search,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { ghostFallbackIconKind, type GhostFallbackIconKind } from './lib/ghostPluginViewModel';
import './plugin-motion.css';

const FALLBACK_ICONS: Record<GhostFallbackIconKind, LucideIcon> = {
  diagram: Workflow,
  media: ImageIcon,
  search: Search,
  communication: MessageCircle,
  code: Code2,
  calendar: CalendarDays,
  generic: Puzzle,
};

type GhostPluginIconSize = 'mini' | 'menu' | 'md' | 'detail';

const CONTAINER_CLASSES: Record<GhostPluginIconSize, string> = {
  mini: 'size-full rounded-[5px] border-0 shadow-none',
  menu: 'size-5 rounded-[7px] border-0 shadow-none',
  md: 'size-12 rounded-[22%]',
  detail: 'size-16 rounded-xl',
};

const SVG_ICON_CLASSES: Record<GhostPluginIconSize, string> = {
  mini: 'size-2.5 object-contain',
  menu: 'size-3 object-contain',
  md: 'size-8 object-contain',
  detail: 'size-10 object-contain',
};

const FALLBACK_ICON_CLASSES: Record<GhostPluginIconSize, string> = {
  mini: 'size-3',
  menu: 'size-3',
  md: 'size-5',
  detail: 'size-7',
};

function isSvgIconSrc(src: string): boolean {
  return src.startsWith('data:image/svg+xml') || /\.svg(?:[?#]|$)/i.test(src);
}

export function GhostPluginIcon({
  iconDataUrl,
  iconId,
  iconName,
  size = 'md',
}: {
  iconDataUrl?: string;
  iconId: string;
  iconName: string;
  size?: GhostPluginIconSize;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  useEffect(() => {
    setFailedSrc(null);
  }, [iconDataUrl]);
  const resolvedIconDataUrl = iconDataUrl && failedSrc !== iconDataUrl ? iconDataUrl : undefined;
  const svg = resolvedIconDataUrl ? isSvgIconSrc(resolvedIconDataUrl) : false;
  const fallbackKind = ghostFallbackIconKind(iconName, iconId);
  const FallbackIcon = FALLBACK_ICONS[fallbackKind];

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden border-[0.5px] border-[var(--border-default)]',
        resolvedIconDataUrl
          ? 'bg-[var(--plugin-icon-surface)] shadow-[var(--plugin-icon-shadow)]'
          : 'bg-[var(--surface-elevated)] text-[var(--text-secondary)] shadow-none',
        CONTAINER_CLASSES[size],
      )}
    >
      {resolvedIconDataUrl ? (
        <img
          src={resolvedIconDataUrl}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(resolvedIconDataUrl)}
          className={cn(
            svg ? SVG_ICON_CLASSES[size] : 'size-full object-cover',
            iconId === 'cindy-github' && 'plugin-icon--github',
          )}
        />
      ) : (
        <FallbackIcon
          aria-hidden="true"
          strokeWidth={1.7}
          className={FALLBACK_ICON_CLASSES[size]}
        />
      )}
    </span>
  );
}
