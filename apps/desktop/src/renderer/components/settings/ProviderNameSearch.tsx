import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { SettingsTextInput } from './SettingsTextInput';
import type { InputProps } from '@/components/ui/input';
import { matchProviderChoices, type ProviderSearchResult, type ProviderSearchTarget } from './providerSearch';

export function ProviderNameSearch({ choices, open, onOpenChange, onSelect, ...input }: Omit<InputProps, 'onSelect'> & {
  choices: ProviderSearchResult[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (target: ProviderSearchTarget) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const hits = matchProviderChoices(choices, input.value);
  const active = hits.findIndex(result => result.key === activeKey);
  const expanded = open && !!input.value.trim();
  const select = (result: ProviderSearchResult) => { onOpenChange(false); onSelect(result.target); };
  return (
    <Popover open={expanded} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div>
          <SettingsTextInput {...input} inputRef={inputRef} role="combobox" autoComplete="off"
            aria-autocomplete="list" aria-expanded={expanded} aria-controls={id}
            aria-activedescendant={expanded && hits[active] ? `${id}-${active}` : undefined}
            onChange={value => { input.onChange(value); setActiveKey(null); onOpenChange(!!value.trim()); }}
            onFocus={() => onOpenChange(!!input.value.trim())}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && hits.length) {
                event.preventDefault(); onOpenChange(true);
                const next = event.key === 'ArrowDown' ? (active + 1) % hits.length : (active <= 0 ? hits.length - 1 : active - 1);
                setActiveKey(hits[next].key);
                document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' });
              } else if (event.key === 'Enter' && expanded && hits[active]) {
                event.preventDefault(); select(hits[active]);
              } else if (event.key === 'Tab') onOpenChange(false);
            }} />
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" sideOffset={6} collisionPadding={8}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        onInteractOutside={event => { if (inputRef.current?.contains(event.target as Node)) event.preventDefault(); }}
        className="z-[10001] max-h-[280px] w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1 shadow-[var(--shadow-menu)]">
        <div role="listbox" id={id} aria-label={input['aria-label'] ?? input.ariaLabel ?? input.placeholder}>
          {hits.map((result, index) => (
            <button key={result.key} id={`${id}-${index}`} type="button" role="option" tabIndex={-1}
              aria-selected={active === index} onPointerMove={() => setActiveKey(result.key)}
              onMouseDown={event => event.preventDefault()} onClick={() => select(result)}
              className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-[var(--cmd-palette-item-hover)] ${active === index ? 'bg-[var(--cmd-palette-item-hover)]' : ''}`}>
              <span className="flex size-8 shrink-0 items-center justify-center text-13 text-[var(--text-primary)]">
                {hasProviderLogo(result.id) ? <ProviderLogoMark providerId={result.id} size={24} /> : result.name.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1"><span className="block truncate text-13 font-medium text-[var(--text-primary)]">{result.name}</span>
                <span className="block text-12 text-[var(--text-tertiary)]">{t(`settings.providers.wizard.${result.metaKey}`)}</span></span>
              <ChevronRight size={16} className="shrink-0 text-[var(--text-tertiary)]" />
            </button>
          ))}
        </div>
        <p className="px-3 py-2 text-12 text-[var(--text-tertiary)]">{t('settings.providers.custom.nameSearchHint')}</p>
      </PopoverContent>
    </Popover>
  );
}
