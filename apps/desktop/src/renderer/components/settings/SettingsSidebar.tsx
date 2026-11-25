import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';

/** The same settings frame for local and cloud controllers; the caller names the page. */
export function SettingsSidebar({
  title,
  width = 260,
  onBack,
  disabled = false,
  children,
}: {
  title: string;
  width?: number;
  onBack(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <aside
      className="flex h-full min-h-0 shrink-0 flex-col gap-2 pl-6 pr-4 pt-7"
      style={{ width }}
      aria-label={title}
    >
      <div className="flex items-center gap-1 px-3 pb-[18px]">
        <Tip text={t('settings.back')} side="bottom">
          <button data-settings-search-action="Return from settings or close the extensions subpage"
            type="button"
            onClick={onBack}
            disabled={disabled}
            aria-label={t('settings.back')}
            className="-ml-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--settings-back-icon)] transition-[color,background-color,transform] duration-150 hover:bg-titlebar-button-hover hover:text-[var(--settings-back-text)] active:scale-[0.98]"
          >
            <ArrowLeft size={20} />
          </button>
        </Tip>
        <div className="min-w-0 flex-1 [container-type:inline-size]">
          <h1
            className="hyphens-auto [overflow-wrap:break-word] text-24 font-medium leading-[1.1] text-[var(--settings-back-text)]"
            style={{ fontSize: 'min(var(--text-24), 12cqi)' }}
          >
            {title}
          </h1>
        </div>
      </div>
      {children}
    </aside>
  );
}
