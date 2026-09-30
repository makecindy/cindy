import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import type { useMetaColumnResize } from '../hooks/useMetaColumnResize';

export function SkillDetailPage({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-0 w-full flex-col motion-safe:animate-[detail-soft-in_220ms_ease-out]">{children}</div>;
}

export function SkillDetailHeader({ title, badges, subtitle, actions, backLabel, onBack }: {
  title: ReactNode; badges?: ReactNode; subtitle?: ReactNode; actions?: ReactNode;
  backLabel: string; onBack: () => void;
}) {
  return (
    <header className="flex min-h-[72px] w-full shrink-0 items-center gap-4 border-b border-[var(--cmd-palette-border)] py-3 pl-4 pr-6" style={WINDOW_DRAG_STYLE}>
      <Button variant="secondary" size="lg" className="w-9 p-0" style={WINDOW_NO_DRAG_STYLE} onClick={onBack} aria-label={backLabel} title={backLabel}>
        <ArrowLeft size={18} />
      </Button>
      <div className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 truncate text-lg font-medium leading-tight text-[var(--msg-assistant-text)]">{title}</h2>
          {badges && <span className="flex shrink-0 items-center gap-2" style={WINDOW_NO_DRAG_STYLE}>{badges}</span>}
        </div>
        {subtitle}
      </div>
      <div className="flex max-w-[60%] shrink-0 items-center gap-2 overflow-x-auto" style={WINDOW_NO_DRAG_STYLE}>{actions}</div>
    </header>
  );
}

export function SkillDetailColumns({ children, resizing = false }: { children: ReactNode; resizing?: boolean }) {
  return <div className={cn('relative flex min-h-0 w-full flex-1', resizing && 'select-none cursor-col-resize')}>{children}</div>;
}

export function SkillDetailSidebar({ children, width }: { children: ReactNode; width: number }) {
  return <aside className="relative flex h-full shrink-0 select-text flex-col gap-4 overflow-y-auto border-r border-[var(--cmd-palette-border)] px-3 py-4" style={{ width }}>{children}</aside>;
}

export function SkillDetailContent({ children, editing = false, compact = false }: { children: ReactNode; editing?: boolean; compact?: boolean }) {
  return <div className={cn('flex min-w-0 flex-1 flex-col', editing ? 'overflow-hidden' : 'overflow-y-auto px-8 pb-8', !editing && (compact ? 'pt-2' : 'pt-8'))}>{children}</div>;
}

export function SkillDetailResizeHandle({ resize }: { resize: ReturnType<typeof useMetaColumnResize> }) {
  const { t } = useTranslation();
  return <hr aria-orientation="vertical" aria-valuemin={resize.minWidth} aria-valuemax={resize.maxWidth}
    aria-valuenow={resize.width} aria-label={t('skillhub.detail.resizeUsageFilesColumn')} tabIndex={0}
    className="absolute right-0 top-0 z-10 m-0 h-full w-[4px] cursor-col-resize border-0 bg-transparent p-0 transition-colors hover:bg-[var(--file-chip-bg)] focus-visible:bg-[var(--file-chip-bg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring-soft)]"
    onPointerDown={resize.handleDragStart} onDoubleClick={resize.resetWidth}
    onKeyDown={(event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); resize.resizeByKeyboard(event.key === 'ArrowLeft' ? -1 : 1, event.shiftKey);
      } else if (event.key === 'Enter') { event.preventDefault(); resize.resetWidth(); }
    }} />;
}
