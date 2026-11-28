import * as Dialog from '@radix-ui/react-dialog';
import { CircleHelp, X } from 'lucide-react';
import { useRef, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export function ModelAdvancedContent({
  closeDisabled = false,
  onCloseAutoFocus,
  onEscapeKeyDown,
  title,
  providerName,
  titleExtra,
  children,
}: {
  closeDisabled?: boolean;
  onCloseAutoFocus?: ComponentProps<typeof Dialog.Content>['onCloseAutoFocus'];
  onEscapeKeyDown?: ComponentProps<typeof Dialog.Content>['onEscapeKeyDown'];
  title: string;
  providerName: string;
  titleExtra?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const titleRef = useRef<HTMLHeadingElement>(null);

  return (
    <>
      <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal-raised" />
      <Dialog.Content
        onPointerDownOutside={event => event.preventDefault()}
        className="modal-panel fixed inset-0 z-modal-raised m-auto flex h-fit max-h-[calc(100dvh-48px)] w-[800px] max-w-[calc(100vw-32px)] flex-col overflow-hidden"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        aria-describedby={undefined}
        onEscapeKeyDown={onEscapeKeyDown}
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={event => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-[var(--settings-theme-card-border)] px-5 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            {titleExtra}
            <Dialog.Title ref={titleRef} tabIndex={-1} className="break-words text-15 font-medium text-[var(--text-primary)] outline-none">
              {title}
            </Dialog.Title>
            <p className="mt-0.5 truncate text-12 text-[var(--text-tertiary)]">{providerName}</p>
          </div>
          <Dialog.Close
            disabled={closeDisabled}
            className="-mr-1 -mt-1 shrink-0 rounded-full p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] hover:text-[var(--text-primary)]"
            aria-label={t('settings.providers.models.advanced.close')}
          >
            <X size={16} aria-hidden />
          </Dialog.Close>
        </header>
        {children}
      </Dialog.Content>
    </>
  );
}

export const modelAdvancedLayoutClasses = {
  body: 'min-h-0 overflow-y-auto px-5 pb-5 pt-3',
  grid: 'grid gap-5 min-[760px]:grid-cols-2 min-[760px]:gap-6',
  right: 'min-w-0 border-t border-[var(--settings-theme-card-border)] pt-4 min-[760px]:border-l min-[760px]:border-t-0 min-[760px]:pl-6 min-[760px]:pt-0',
};

export function ModelAdvancedColumns({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className={modelAdvancedLayoutClasses.body}>
      <div className={modelAdvancedLayoutClasses.grid}>
        <div className="min-w-0">{left}</div>
        <div className={modelAdvancedLayoutClasses.right}>
          {right}
        </div>
      </div>
    </div>
  );
}

export function ModelAdvancedFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-[var(--settings-theme-card-border)] px-5 py-3">
      {children}
    </div>
  );
}

export function ModelAdvancedRow({
  label,
  children,
  muted,
}: {
  label: string;
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex min-h-[34px] items-center justify-between gap-4 border-b border-[var(--settings-theme-card-border)] py-2 last:border-b-0">
      <span className="shrink-0 text-13 text-[var(--text-secondary)]">{label}</span>
      <span
        className={cn(
          'min-w-0 break-words text-right text-13',
          muted ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]',
        )}
      >
        {children}
      </span>
    </div>
  );
}

export function ModelAdvancedSection({
  settingId,
  title,
  hint,
  children,
}: {
  settingId?: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="pt-5 first:pt-1">
      <div className="flex items-center gap-1.5">
        <h4 className="text-12 font-medium text-[var(--text-secondary)]">{title}</h4>
        {hint && (
          <Tip text={hint}>
            <button
              data-setting-id={settingId}
              type="button"
              data-settings-search-action="Show help for this advanced model section"
              aria-label={hint}
              className="rounded-full p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              <CircleHelp size={12} aria-hidden />
            </button>
          </Tip>
        )}
      </div>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}
