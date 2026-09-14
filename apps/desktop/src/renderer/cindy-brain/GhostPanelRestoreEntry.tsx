import { useState, type ReactNode } from 'react';
import { Ghost } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useGhostPanelRestoreMode } from '@/hooks/useGhostPanelRestoreMode';
import { cn } from '@/lib/utils';
import type { InstalledGhost } from '../../shared/ghost';
import { restoreGhostPanel } from '../lib/ghostPanelBubbleState';
import { useMinimizedGhostPanels } from './useMinimizedGhostPanels';

function panelName(ghost: InstalledGhost): string {
  return ghost.manifest.panel?.title ?? ghost.manifest.name;
}

function GhostEntryIcon({ ghost, size }: { ghost?: InstalledGhost; size: number }): ReactNode {
  const [broken, setBroken] = useState(false);
  if (ghost?.iconDataUrl && !broken) {
    return (
      <img
        src={ghost.iconDataUrl}
        alt=""
        draggable={false}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
        onError={() => setBroken(true)}
      />
    );
  }
  return <Ghost size={size} strokeWidth={1.8} className="shrink-0" aria-hidden />;
}

export function GhostPanelRestoreEntry({
  variant,
  className,
}: {
  variant: 'row' | 'rail';
  className?: string;
}): ReactNode {
  const { t } = useTranslation();
  const { mode } = useGhostPanelRestoreMode();
  const minimized = useMinimizedGhostPanels();
  if (mode !== 'sidebar' || minimized.length === 0) return null;

  const single = minimized.length === 1 ? minimized[0] : null;
  const label = single ? panelName(single) : t('ghostPanelRestore.multiple');
  const ariaLabel = single
    ? t('ghostPanelRestore.single', { name: label })
    : t('ghostPanelRestore.multipleAria', { count: minimized.length });
  const content = (
    <>
      <GhostEntryIcon ghost={single ?? undefined} size={variant === 'rail' ? 18 : 15} />
      {variant === 'row' ? (
        <>
          <span
            data-testid="ghost-panel-restore-label"
            className="min-w-0 flex-1 truncate text-left leading-none"
          >
            {label}
          </span>
          {minimized.length > 1 ? (
            <span
              data-testid="ghost-panel-restore-count"
              aria-hidden
              className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--surface-chip)] px-1 text-10 font-medium leading-none text-[var(--text-secondary)]"
            >
              {minimized.length}
            </span>
          ) : null}
        </>
      ) : minimized.length > 1 ? (
        <span
          aria-hidden
          className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[var(--text-tertiary)] bg-[var(--surface-chip)] px-1 text-10 font-medium leading-none text-[var(--text-secondary)]"
        >
          {minimized.length}
        </span>
      ) : null}
    </>
  );

  if (single) {
    return (
      <button
        type="button"
        data-testid="ghost-panel-restore-entry"
        aria-label={ariaLabel}
        title={label}
        onClick={() => restoreGhostPanel(single.manifest.id)}
        className={className}
      >
        {content}
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="ghost-panel-restore-entry"
          aria-label={ariaLabel}
          title={label}
          className={cn('relative', className)}
        >
          {content}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={6}
        className={cn(
          'min-w-[200px] max-w-[320px] rounded-xl p-1',
          'border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
          'shadow-[var(--shadow-menu)]',
        )}
      >
        {minimized.map((ghost) => {
          const name = panelName(ghost);
          return (
            <DropdownMenuItem
              key={ghost.manifest.id}
              onSelect={() => restoreGhostPanel(ghost.manifest.id)}
              className="gap-2.5 text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
            >
              <GhostEntryIcon ghost={ghost} size={18} />
              <span className="min-w-0 flex-1 truncate">{name}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
