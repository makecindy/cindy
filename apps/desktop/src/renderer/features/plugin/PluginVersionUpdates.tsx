import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Updates stay secondary to the plugin's purpose and use controls. No persisted open state. */
export function PluginVersionUpdates({ children, attention, open, onOpenChange }: {
  children: ReactNode;
  attention?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <details
      open={open}
      className="group mt-8 border-y border-[var(--border-default)] py-4"
      onToggle={(event) => {
        if (event.target === event.currentTarget) onOpenChange?.(event.currentTarget.open);
      }}
    >
      <summary className="flex min-h-8 cursor-pointer select-none list-none items-center gap-2 rounded-md text-16 font-medium text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
        <span>{t('settings.ghosts.contribution.versionUpdates')}</span>
        {attention}
        <ChevronDown size={16} aria-hidden="true" className="ml-auto shrink-0 text-[var(--text-tertiary)] transition-transform group-open:rotate-180" />
      </summary>
      <div className="pt-5">{children}</div>
    </details>
  );
}
