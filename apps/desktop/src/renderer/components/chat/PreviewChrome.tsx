import { useContext, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Download, MoreHorizontal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { ActivePreviewCollection } from './AttachmentCollectionContext';

/** Scope teardown runs after closing/switching; don't restore into a removed viewer. */
export function usePreviewFocusReturn() {
  return useContext(ActivePreviewCollection)?.restoreFocus;
}

/** Shared preview chrome. Content renderers retain their own lifecycle and permissions. */
export function PreviewHeader({
  name,
  detail,
  onClose,
  onSave,
  actions,
  menu,
  onMenuClose,
}: {
  name: string;
  detail?: ReactNode;
  onClose: () => void;
  onSave?: () => void;
  actions?: ReactNode;
  menu?: ReactNode;
  onMenuClose?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <header
      className="absolute inset-x-0 top-0 z-10 flex h-16 min-w-0 items-center gap-3 border-b border-[var(--border-default)] bg-[var(--surface-elevated)] px-6 text-[var(--text-primary)]"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={name}>
          {name}
        </div>
        {detail ? (
          <div className="truncate text-xs text-[var(--text-secondary)]">{detail}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {onSave ? (
          <PreviewButton label={t('chat.media.saveAs')} onClick={onSave}>
            <Download className="h-4 w-4" />
          </PreviewButton>
        ) : null}
        {menu ? (
          <DropdownMenu
            onOpenChange={(open) => {
              if (!open) onMenuClose?.();
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={PREVIEW_BUTTON_CLASS}
                aria-label={t('attachmentPreview.more')}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              onEscapeKeyDown={(event) => event.stopPropagation()}
              className="z-[10002]"
              align="end"
            >
              {menu}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <PreviewButton label={t('chat.lightbox.close')} onClick={onClose}>
          <X className="h-4 w-4" />
        </PreviewButton>
      </div>
    </header>
  );
}

const PREVIEW_BUTTON_CLASS =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none';

export function PreviewButton({
  label,
  onClick,
  disabled,
  children,
  keepPointerFocus,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  keepPointerFocus?: boolean;
}) {
  return (
    <Tip text={label} contentClassName="z-[10003]">
      <button
        type="button"
        aria-label={label}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={onClick}
        onMouseDown={keepPointerFocus ? (event) => event.preventDefault() : undefined}
        className={PREVIEW_BUTTON_CLASS}
      >
        {children}
      </button>
    </Tip>
  );
}

export function PreviewFooter({
  children,
  className,
  collectionOnly = false,
}: {
  children?: ReactNode;
  className?: string;
  collectionOnly?: boolean;
}) {
  const collection = useContext(ActivePreviewCollection);
  const { t } = useTranslation();
  if (collectionOnly && !collection) return null;
  return (
    <footer
      className={cn(
        'absolute inset-x-0 bottom-0 z-10 flex min-h-16 flex-wrap items-center justify-center gap-1 border-t border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 text-[var(--text-primary)]',
        className,
      )}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
      {collection ? (
        <div
          className={cn(
            'flex items-center gap-1',
            children && 'ml-4 border-l border-[var(--border-default)] pl-4',
          )}
        >
          <PreviewButton
            label={t('attachmentPreview.previous')}
            disabled={collection.index === 0}
            onClick={() => collection.select(collection.index - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </PreviewButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="h-8 min-w-16 rounded-full px-3 text-xs tabular-nums hover:bg-[var(--surface-hover)]"
              >
                {collection.index + 1} / {collection.items.length}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="z-[10002] max-h-72 overflow-auto"
              onEscapeKeyDown={(event) => event.stopPropagation()}
            >
              {collection.items.map((item, index) => (
                <DropdownMenuItem key={item.id} onSelect={() => collection.select(index)}>
                  {index + 1}. {item.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <PreviewButton
            label={t('attachmentPreview.next')}
            disabled={collection.index === collection.items.length - 1}
            onClick={() => collection.select(collection.index + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </PreviewButton>
        </div>
      ) : null}
    </footer>
  );
}
