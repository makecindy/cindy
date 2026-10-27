/**
 * The welcome panel and + menu present the same creation actions.
 * Only their layout differs; labels, order, availability and handlers come from the host.
 */
import { ChevronRight, LoaderCircle } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TabCreationMenu, TabCreationSelectionOptions } from './lib/useTabCreationMenu';

export function EmptyState({ menu, selectionOptions }: { menu: TabCreationMenu; selectionOptions?: TabCreationSelectionOptions }) {
  const { t } = useTranslation();
  const descriptionId = useId();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-start gap-8 overflow-y-auto px-10 pb-8 pt-16">
      <div className="flex w-full flex-col gap-2">
        <span className="text-11 font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          {t('rightSidebar.tabs.empty.eyebrow')}
        </span>
        <span className="text-20 font-semibold leading-tight text-[var(--text-primary)]">
          {t('rightSidebar.tabs.empty.title')}
        </span>
        <span className="text-13 leading-relaxed text-[var(--text-tertiary)]">
          {t('rightSidebar.tabs.empty.desc')}
        </span>
      </div>
      <div className="flex w-full flex-col">
        {menu.items.map(item => {
          const Icon = item.icon;
          const label = item.labelText ?? t(item.labelKey);
          return (
            <button
              key={item.kind}
              type="button"
              onClick={() => selectionOptions ? menu.select(item.kind, selectionOptions) : menu.select(item.kind)}
              disabled={item.disabled}
              aria-label={label}
              aria-describedby={item.descriptionKey ? `${descriptionId}-${item.kind}` : undefined}
              aria-busy={item.busy || undefined}
              className="group flex w-full items-center gap-3.5 border-b border-[var(--border-default)] px-1 py-3 text-left transition-colors enabled:hover:bg-[var(--surface-hover)] disabled:opacity-60"
            >
              <Icon size={16} className="shrink-0 text-[var(--text-secondary)]" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-14 font-medium leading-5 text-[var(--text-primary)]">{label}</span>
                {item.descriptionKey && (
                  <span id={`${descriptionId}-${item.kind}`} className="text-12 leading-5 text-[var(--text-tertiary)]">
                    {t(item.descriptionKey)}
                  </span>
                )}
              </span>
              {item.busy ? <LoaderCircle size={14} className="animate-spin text-[var(--text-tertiary)]" />
                : <ChevronRight size={14} className="text-[var(--text-tertiary)] transition-transform group-hover:translate-x-0.5" />}
            </button>
          );
        })}
      </div>
      <p className="px-1 text-11 text-[var(--text-tertiary)]">
        {t('rightSidebar.tabs.empty.addMoreHint')}
      </p>
    </div>
  );
}
