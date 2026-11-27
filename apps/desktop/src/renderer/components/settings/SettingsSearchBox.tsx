import type { SettingsSearchContext, SettingsSearchEntry } from './settingsSearchTypes';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SearchInput } from '@/components/ui/search-input';
import { currentSelectedOption } from '@/components/ui/dropdown-menu-highlight';
import {
  COMPOSER_MENU_ROW,
  MenuHighlightLayer,
  menuPanelAttrs,
  menuRowAttrs,
  useMenuPanel,
  withMenuLabels,
} from '@/components/ui/menu-row';
import { cn } from '@/lib/utils';
import type { SettingsTab, VisibleSettingsTab } from '@/lib/tabLabels';
import {
  buildSettingsSearchDocuments,
  searchSettings,
  type SettingsSearchDocument,
} from './settingsSearchCatalog';

interface SettingsSearchBoxProps {
  requestedQuery?: string;
  visibleTabIds: readonly VisibleSettingsTab[];
  searchContext?: SettingsSearchContext;
  additionalDocuments?: readonly SettingsSearchDocument[];
  allowSearchEntry?: (entry: SettingsSearchEntry) => boolean;
  onSelect?: (result: { tab: SettingsTab; sectionId: string }) => void;
}

export function SettingsSearchBox({ requestedQuery = '', visibleTabIds, searchContext, additionalDocuments, onSelect, allowSearchEntry }: SettingsSearchBoxProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(requestedQuery.slice(0, 200));
  useEffect(() => { setQuery(requestedQuery.slice(0, 200)); }, [requestedQuery]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Results list: glide highlight on the aria-selected result; arrow keys stay in the field.
  const resultsRef = useMenuPanel<HTMLDivElement>(undefined, {
    lockWidth: false,
    options: {
      current: currentSelectedOption,
      currentAttributes: ['aria-selected'],
      keyboardSource: document,
    },
  });
  const documents = useMemo(
    () => [...buildSettingsSearchDocuments(t, visibleTabIds, searchContext), ...(additionalDocuments ?? [])].filter(doc => !allowSearchEntry || allowSearchEntry(doc.entry)),
    [t, visibleTabIds, searchContext, additionalDocuments, allowSearchEntry],
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
        <SearchInput
          inputRef={inputRef}
          value={query}
          onChange={(value) => {
            setQuery(value);
            setActiveIndex(0);
          }}
          ariaLabel={t('settings.search.ariaLabel')}
          placeholder={t('settings.search.placeholder')}
          role="combobox"
          aria-expanded={hasQuery}
          aria-controls={hasQuery ? 'settings-search-results' : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeResult ? 'settings-search-result-' + activeResult.entry.id : undefined}
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
        />

      {hasQuery ? (
        <div
          id="settings-search-results"
          role="listbox"
          aria-label={t('settings.search.resultsLabel')}
          ref={resultsRef}
          {...menuPanelAttrs}
          className="relative mt-1 max-h-[min(55vh,420px)] overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1"
        >
          <MenuHighlightLayer />
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
                // Shared menu row: the list's glide highlight follows the active result
                // (focus stays in the search field), title 400 → 500, 12px meta line.
                {...menuRowAttrs()}
                className={cn(
                  COMPOSER_MENU_ROW,
                  'flex w-full flex-col items-start px-2.5 py-2 text-left focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                )}
              >
                {withMenuLabels(<span className="w-full truncate">{result.title}</span>)}
                <span className="w-full truncate text-12 font-normal leading-[1.33] text-[var(--cmd-palette-item-meta)]">
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
