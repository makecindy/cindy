import { useId, useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Collapse } from '@/components/ui/collapse';
import { cn } from '@/lib/utils';
import { parseWebhookEventSelection, webhookEventOptions } from '../lib/webhookEventOptions';

interface Props {
  preset: string;
  value: string;
  onChange(value: string): void;
}
const key = 'scheduler.editor.webhook.eventPicker';

/** The draft cannot accidentally widen a filter: only an explicit All choice saves []. */
export function WebhookEventSelect({ preset, value, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<string[]>([]);
  const [all, setAll] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [custom, setCustom] = useState('');
  const helpId = useId();
  const selected = parseWebhookEventSelection(value);
  const groups = useMemo(
    () =>
      webhookEventOptions(preset).map((group) => ({
        label: t(`${key}.groups.${group.label}`),
        options: group.options.map((option) => ({
          ...option,
          label: t(`${key}.actions.${option.label}`),
        })),
      })),
    [preset, t],
  );
  const labels = new Map(
    groups.flatMap((group) =>
      group.options.map((option) => [option.value, `${group.label} · ${option.label}`] as const),
    ),
  );
  const unknown = [...new Set([...selected, ...draft])].filter((item) => !labels.has(item));
  const search = query.trim().toLocaleLowerCase();
  const matches = (name: string) => name.toLocaleLowerCase().includes(search);
  const filtered = groups
    .map((group) => ({
      ...group,
      options: group.options.filter((option) =>
        matches(`${group.label} ${option.label} ${option.value}`),
      ),
    }))
    .filter((group) => group.options.length);
  const customValue = custom.trim();
  // Mirrors the existing scheduler input limit; never rewrites unknown saved values.
  const customInvalid = customValue !== '' && !/^[A-Za-z0-9_.:-]{1,100}$/.test(customValue);
  const tooMany = !all && draft.length > 32;
  const canApply = all || (draft.length > 0 && !tooMany);

  function changeOpen(next: boolean) {
    if (next) {
      setDraft(selected);
      setAll(selected.length === 0);
      setQuery('');
      setAdvanced(false);
      setCustom('');
    }
    setOpen(next);
  }
  function toggle(item: string) {
    const current = all ? [] : draft;
    const option = groups.flatMap((group) => group.options).find((option) => option.value === item);
    setDraft(
      current.includes(item)
        ? current.filter((v) => v !== item)
        : [
            ...current.filter(
              (v) => v !== option?.parent && !(option?.coversActions && v.startsWith(`${item}.`)),
            ),
            item,
          ],
    );
    setAll(false);
  }
  function remove(item: string) {
    const next = selected.filter((v) => v !== item);
    if (next.length) onChange(next.join(', '));
    else {
      changeOpen(true);
      setDraft([]);
      setAll(false);
    }
  }

  return (
    <div className="min-w-0 space-y-2">
      <FormField label={t(`${key}.label`)}>
        {({ id }) => (
          <Popover open={open} onOpenChange={changeOpen}>
            <PopoverTrigger asChild>
              <Button
                id={id}
                variant="secondary"
                size="lg"
                className="w-full justify-between"
                aria-label={t(`${key}.choose`)}
              >
                <span className="truncate">
                  {selected.length
                    ? t(`${key}.selected`, { count: selected.length })
                    : t(`${key}.all`)}
                </span>
                <ChevronDown size={14} aria-hidden className="shrink-0" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={8}
              collisionPadding={16}
              aria-label={t(`${key}.choose`)}
              className="z-[10010] flex max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] min-w-0 max-w-[calc(100vw-32px)] flex-col gap-3 p-3"
            >
              <Input
                size="md"
                value={query}
                onChange={setQuery}
                placeholder={t(`${key}.search`)}
                aria-label={t(`${key}.search`)}
              />
              <div className="min-h-0 max-h-64 space-y-2 overflow-y-auto overscroll-contain">
                <Choice checked={all} onClick={() => setAll(true)}>
                  {t(`${key}.all`)}
                </Choice>
                {filtered.map((group) => (
                  <div key={group.label} role="group" aria-label={group.label}>
                    <p className="px-2 pb-1 pt-2 text-12 font-medium text-[var(--text-secondary)]">
                      {group.label}
                    </p>
                    {group.options.map((option) => (
                      <Choice
                        key={option.value}
                        checked={!all && draft.includes(option.value)}
                        label={`${group.label} · ${option.label}`}
                        onClick={() => toggle(option.value)}
                      >
                        {option.label}
                      </Choice>
                    ))}
                  </div>
                ))}
                {unknown.some(matches) && (
                  <div role="group" aria-label={t(`${key}.customGroup`)}>
                    <p className="px-2 pb-1 pt-2 text-12 font-medium text-[var(--text-secondary)]">
                      {t(`${key}.customGroup`)}
                    </p>
                    {unknown.filter(matches).map((item) => (
                      <Choice
                        key={item}
                        checked={!all && draft.includes(item)}
                        onClick={() => toggle(item)}
                      >
                        {item}
                      </Choice>
                    ))}
                  </div>
                )}
                {!filtered.length && !unknown.some(matches) && (
                  <p className="px-2 py-3 text-12 text-[var(--text-secondary)]">
                    {t(`${key}.${groups.length ? 'noResults' : 'noPresets'}`)}
                  </p>
                )}
              </div>
              <div className="space-y-2 border-t border-[var(--border-default)] pt-2">
                <Button
                  variant="secondary"
                  tone="quiet"
                  compact
                  size="sm"
                  aria-expanded={advanced}
                  onClick={() => setAdvanced(!advanced)}
                >
                  <Plus size={14} aria-hidden />
                  {t(`${key}.custom`)}
                </Button>
                <Collapse open={advanced}>
                  <div className="space-y-2 pt-2">
                    <FormField
                      label={t(`${key}.customLabel`)}
                      error={customInvalid ? t(`${key}.invalid`) : undefined}
                    >
                      {(control) => (
                        <Input
                          {...control}
                          size="md"
                          value={custom}
                          onChange={setCustom}
                          mono
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              if (!customInvalid && customValue) {
                                setDraft([...new Set([...(all ? [] : draft), customValue])]);
                                setAll(false);
                                setCustom('');
                              }
                            }
                          }}
                        />
                      )}
                    </FormField>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={customInvalid || !customValue}
                      onClick={() => {
                        setDraft([...new Set([...(all ? [] : draft), customValue])]);
                        setAll(false);
                        setCustom('');
                      }}
                    >
                      {t(`${key}.add`)}
                    </Button>
                  </div>
                </Collapse>
                {!canApply && (
                  <p id={helpId} role="status" className="text-12 text-[var(--text-secondary)]">
                    {t(`${key}.${tooMany ? 'limit' : 'chooseOne'}`)}
                  </p>
                )}
                <div className="flex items-center justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
                    {t(`${key}.cancel`)}
                  </Button>
                  <Button
                    size="sm"
                    disabled={!canApply}
                    aria-describedby={!canApply ? helpId : undefined}
                    onClick={() => {
                      onChange(all ? '' : draft.join(', '));
                      setOpen(false);
                    }}
                  >
                    {t(`${key}.apply`)}
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        )}
      </FormField>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selected.map((item) => (
            <Button
              key={item}
              variant="secondary"
              compact
              size="sm"
              className="max-w-full"
              title={item}
              aria-label={t(`${key}.remove`, { name: labels.get(item) ?? item })}
              onClick={() => remove(item)}
            >
              <span className="truncate">{labels.get(item) ?? item}</span>
              <X size={12} aria-hidden className="shrink-0" />
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function Choice({
  checked,
  onClick,
  children,
  label,
}: {
  checked: boolean;
  onClick(): void;
  children: ReactNode;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onClick}
      className="flex min-h-9 w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-13 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
    >
      <span
        aria-hidden
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded border border-[var(--border-default)]',
          checked &&
            'border-[var(--text-primary)] bg-[var(--text-primary)] text-[var(--surface-elevated)]',
        )}
      >
        {checked && <Check size={12} strokeWidth={2} />}
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </button>
  );
}
