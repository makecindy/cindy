import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Square, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import {
  COMPOSER_MENU_ROW,
  MenuHighlightLayer,
  menuPanelAttrs,
  menuRowAttrs,
  useMenuPanel,
  withMenuLabels,
} from '@/components/ui/menu-row';
import { currentFocusedRow } from '@/components/ui/dropdown-menu-highlight';
import type { SelectProps } from '@/components/ui/select';
import { cn } from '@/lib/utils';

type Props = Pick<
  SelectProps,
  | 'id'
  | 'label'
  | 'value'
  | 'options'
  | 'disabled'
  | 'className'
  | 'aria-describedby'
  | 'error'
  | 'onValueChange'
> & {
  previewVoice?: string;
  previewPhase: string;
  previewDisabled: boolean;
  onPreview(voice: string): void;
  onOpenChange(): void;
};

/** Two separate actions per row: a popover of native buttons, not a button nested
 * in a listbox option. Only choosing the name commits the companion preference. */
export function SpeechVoiceMenu(props: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const menuRef = useMenuPanel(panel, {
    lockWidth: false,
    options: { current: currentFocusedRow },
  });
  const search = useRef({ text: '', at: 0 });
  const selected = props.options.find((option) => option.value === props.value);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    search.current = { text: '', at: 0 };
    props.onOpenChange();
  };
  useEffect(() => {
    if (props.disabled && open) changeOpen(false);
  }, [props.disabled, open]);

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const choices = Array.from(
      panel.current?.querySelectorAll<HTMLButtonElement>('[data-voice-choice]:not(:disabled)') ??
        [],
    );
    const row = (event.target as HTMLElement).closest('[data-menu-row]');
    const current = choices.findIndex((button) => row?.contains(button));
    let target: HTMLButtonElement | undefined;
    if (event.key === 'ArrowDown') target = choices[(current + 1) % choices.length];
    else if (event.key === 'ArrowUp')
      target = choices[(current - 1 + choices.length) % choices.length];
    else if (event.key === 'Home') target = choices[0];
    else if (event.key === 'End') target = choices.at(-1);
    else if (event.key.length === 1 && event.key !== ' ' && !event.nativeEvent.isComposing) {
      const now = Date.now();
      search.current = {
        text:
          (now - search.current.at < 700 ? search.current.text : '') +
          event.key.toLocaleLowerCase(),
        at: now,
      };
      const query = [...search.current.text].every((char) => char === event.key.toLocaleLowerCase())
        ? event.key.toLocaleLowerCase()
        : search.current.text;
      target = [...choices.slice(current + 1), ...choices.slice(0, current + 1)].find((button) =>
        button.textContent?.trim().toLocaleLowerCase().startsWith(query),
      );
    }
    if (target) {
      event.preventDefault();
      target.focus();
      target.scrollIntoView?.({ block: 'nearest' });
    }
  };

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          id={props.id}
          value={props.value}
          variant="secondary"
          size="lg"
          pressFeedback={false}
          disabled={props.disabled}
          aria-label={props.label}
          aria-describedby={props['aria-describedby']}
          aria-invalid={props.error || undefined}
          title={selected?.label}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              changeOpen(true);
            }
          }}
          className={cn(
            'min-w-0 max-w-full justify-between gap-2 px-3 font-normal [-webkit-app-region:no-drag]',
            props.className,
          )}
        >
          <span className="min-w-0 truncate text-left">{selected?.label ?? props.label}</span>
          <ChevronDown size={14} className="shrink-0" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        collisionPadding={8}
        aria-label={props.label}
        className="z-[10010] flex max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5 text-[var(--text-primary)] [-webkit-app-region:no-drag]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const choices = Array.from(
            panel.current?.querySelectorAll<HTMLButtonElement>(
              '[data-voice-choice]:not(:disabled)',
            ) ?? [],
          );
          const target = choices.find((button) => button.value === props.value) ?? choices[0];
          target?.focus();
          target?.scrollIntoView?.({ block: 'nearest' });
        }}
      >
        <div
          ref={menuRef}
          {...menuPanelAttrs}
          className="relative min-h-0 max-h-64 overflow-y-auto"
          onKeyDown={navigate}
        >
          <MenuHighlightLayer />
          {props.options.map((option) => {
            const voice = option.value.startsWith('voice:') ? option.value.slice(6) : undefined;
            const active =
              voice === props.previewVoice &&
              (props.previewPhase === 'preparing' || props.previewPhase === 'playing');
            const previewLabel = t(
              active ? 'bots.voiceMode.stopPreviewVoice' : 'bots.voiceMode.previewVoice',
              { voice: option.label },
            );
            return (
              <div
                key={option.value}
                {...menuRowAttrs({
                  checked: props.value === option.value,
                  disabled: option.disabled,
                })}
                className={cn(COMPOSER_MENU_ROW, 'group flex min-h-8 items-center gap-1 pr-2')}
              >
                <button
                  type="button"
                  data-voice-choice=""
                  value={option.value}
                  disabled={option.disabled}
                  aria-pressed={props.value === option.value}
                  title={option.label}
                  className="min-h-8 min-w-0 flex-1 rounded-lg py-1 pl-2 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)] disabled:opacity-50"
                  onClick={() => {
                    props.onValueChange(option.value);
                    changeOpen(false);
                  }}
                >
                  {withMenuLabels(<span className="block truncate">{option.label}</span>)}
                </button>
                {voice ? (
                  <Button
                    size="sm"
                    tone="quiet"
                    compact
                    className={cn(
                      'w-7 shrink-0 px-0',
                      !active &&
                        'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100',
                    )}
                    aria-label={previewLabel}
                    title={previewLabel}
                    disabled={!active && (props.previewDisabled || option.disabled)}
                    onClick={() => props.onPreview(voice)}
                  >
                    {active && props.previewPhase === 'preparing' ? (
                      <Spinner size={14} />
                    ) : active ? (
                      <Square size={14} aria-hidden="true" />
                    ) : (
                      <Volume2 size={15} aria-hidden="true" />
                    )}
                  </Button>
                ) : null}
                <span className="flex w-4 shrink-0 justify-center" aria-hidden="true">
                  {props.value === option.value ? <Check size={14} /> : null}
                </span>
              </div>
            );
          })}
        </div>
        <p
          role="status"
          className="border-t border-[var(--border-default)] px-2 pb-1 pt-2 text-12 text-[var(--text-secondary)]"
        >
          {t(
            props.previewPhase === 'timeout'
              ? 'bots.voiceMode.errors.speechTimeout'
              : `bots.voiceMode.previewStatus.${props.previewPhase}`,
          )}
        </p>
      </PopoverContent>
    </Popover>
  );
}
