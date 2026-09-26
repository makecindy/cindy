import type { SettingsSearchContext } from './settingsSearchTypes';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { SettingsTab, VisibleSettingsTab } from '@/lib/tabLabels';
import {
  buildSettingsSearchDocuments,
  searchSettings,
  type SettingsSearchDocument,
} from './settingsSearchCatalog';

interface SettingsSearchBoxProps {
  visibleTabIds: readonly VisibleSettingsTab[];
  searchContext?: SettingsSearchContext;
  onSelect?: (result: { tab: SettingsTab; sectionId: string }) => void;
}

export function SettingsSearchBox({ visibleTabIds, searchContext, onSelect }: SettingsSearchBoxProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const documents = useMemo(
    () => buildSettingsSearchDocuments(t, visibleTabIds, searchContext),
    [t, visibleTabIds, searchContext],
  );
  const results = useMemo(() => searchSettings(documents, query), [documents, query]);
  const hasQuery = query.trim().length > 0;
  const activeResult = results[activeIndex];

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    if (!activeResult) return;
    const element = document.getElementById(`settings-search-result-${activeResult.entry.id}`);
    element?.scrollIntoView?.({ block: 'nearest' });
  }, [activeResult]);

  const selectResult = (result: SettingsSearchDocument) => {
    onSelect?.({ tab: result.entry.tab, sectionId: result.entry.id });
    setQuery('');
    setActiveIndex(0);
  };

  return (
    <div className="mb-3 px-1">
      <div className="relative">
        <Search
          aria-hidden="true"
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 text-[var(--settings-section-sublabel)]"
        />
        <Input
          inputRef={inputRef}
          value={query}
          onChange={(value) => {
            setQuery(value);
            setActiveIndex(0);
          }}
          size="sm"
          surface="ivory"
          ariaLabel={t('settings.search.ariaLabel')}
          placeholder={t('settings.search.placeholder')}
          role="combobox"
          aria-expanded={hasQuery}
          aria-controls={hasQuery ? 'settings-search-results' : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeResult ? 'settings-search-result-' + activeResult.entry.id : undefined}
          inputClassName="pl-9 pr-9"
          onKeyDown={(event) => {
            if (!hasQuery) return;
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((index) => (results.length ? (index + 1) % results.length : 0));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => (results.length ? (index - 1 + results.length) % results.length : 0));
            } else if (event.key === 'Enter' && activeResult) {
              event.preventDefault();
              selectResult(activeResult);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setQuery('');
              setActiveIndex(0);
            }
          }}
          trailing={
            hasQuery ? (
              <Tip text={t('settings.search.clear')}>
                <button
                  type="button"
                  aria-label={t('settings.search.clear')}
                  onClick={() => {
                    setQuery('');
                    setActiveIndex(0);
                    inputRef.current?.focus();
                  }}
                  className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-[var(--settings-section-sublabel)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] hover:text-[var(--settings-section-title)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </Tip>
            ) : undefined
          }
        />
      </div>

      {hasQuery ? (
        <div
          id="settings-search-results"
          role="listbox"
          aria-label={t('settings.search.resultsLabel')}
          className="mt-1 max-h-[min(55vh,420px)] overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1"
        >
          {results.length > 0 ? (
            results.map((result, index) => (
              <button
                key={result.entry.id}
                id={'settings-search-result-' + result.entry.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectResult(result)}
                className={cn(
                  'flex w-full flex-col items-start rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                  index === activeIndex
                    ? 'bg-[var(--settings-menu-bg-hover)]'
                    : 'hover:bg-[var(--settings-menu-bg-hover)]',
                )}
              >
                <span className="w-full truncate text-12 font-medium text-[var(--settings-section-title)]">
                  {result.title}
                </span>
                <span className="w-full truncate text-11 text-[var(--settings-section-sublabel)]">
                  {result.entry.id === result.entry.tab
                    ? result.category
                    : `${result.category} · ${result.section}`}
                </span>
              </button>
            ))
          ) : (
            <div className="px-2.5 py-3 text-12 text-[var(--settings-section-sublabel)]">
              {t('settings.search.noResults')}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
