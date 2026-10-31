import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cardIcon, ProviderRow } from './ProviderRow';
import { isLocalRuntimeBetaProviderId } from '../../../shared/localModelRuntime';
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
      {/* Keep wheel events inside the modal dialog’s scroll boundary. */}
      <PopoverContent align="start" sideOffset={6} collisionPadding={8}
        portalContainer={inputRef.current?.closest<HTMLElement>('[role="dialog"]')}
        onEscapeKeyDown={event => { if (event.isComposing || event.keyCode === 229) event.preventDefault(); }}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        onInteractOutside={event => { if (inputRef.current?.contains(event.target as Node)) event.preventDefault(); }}
        className="z-[10001] flex max-h-[min(280px,var(--radix-popover-content-available-height))] flex-col w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--confirm-bg)] p-2 shadow-[var(--shadow-menu)]">
        <div className="min-h-0 overflow-y-auto" role="listbox" id={id} aria-label={input['aria-label'] ?? input.ariaLabel ?? input.placeholder}>
          {hits.map((result, index) => (
            <ProviderRow key={result.key} id={`${id}-${index}`} role="option" tabIndex={-1}
              icon={cardIcon({ providerId: result.id, name: result.name })}
              name={result.name} meta={t(`settings.providers.${result.metaKey}`, result.metaValues)}
              beta={isLocalRuntimeBetaProviderId(result.id)}
              aria-selected={active === index} onPointerMove={() => setActiveKey(result.key)}
              onMouseDown={event => event.preventDefault()} onClick={() => select(result)}
              className="aria-selected:bg-[var(--settings-menu-bg-hover)]" />
          ))}
        </div>
        <p className="shrink-0 whitespace-normal break-words px-2 pb-1 pt-2 text-11 text-[var(--text-tertiary)]">{t('settings.providers.custom.nameSearchHint')}</p>
      </PopoverContent>
    </Popover>
  );
}
