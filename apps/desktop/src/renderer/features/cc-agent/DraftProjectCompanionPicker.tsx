import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Users } from 'lucide-react';
import { SelectParts as Select } from '@/components/ui/select';
import type { ComposerBotMention } from '@/lib/fileTypes';

interface Props {
  partners: readonly Pick<ComposerBotMention, 'id' | 'name'>[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}

export function DraftProjectCompanionPicker({ partners, value, onChange, disabled }: Props) {
  const { t } = useTranslation();
  const options = [
    { value: 'default', label: t('projectCompanion.default') },
    ...partners.map(({ id, name }) => ({ value: `bot:${id}`, label: name })),
  ];
  if (value && !partners.some(partner => partner.id === value)) {
    options.push({ value: `bot:${value}`, label: t('projectCompanion.unavailable') });
  }
  const selected = value ? `bot:${value}` : 'default';
  const title = t('projectCompanion.title');
  return (
    <Select.Root
      value={selected}
      onValueChange={choice => onChange(choice === 'default' ? null : choice.slice(4))}
      disabled={disabled}
    >
      <Select.Trigger
        aria-label={`${title} · ${options.find(option => option.value === selected)?.label}`}
        className="inline-flex h-[30px] min-w-20 max-w-[200px] items-center justify-center gap-1.5 rounded-full border border-[var(--create-agent-control-border)] bg-[var(--create-agent-control-bg)] px-3 text-12 font-medium leading-[1.167] text-[var(--create-agent-control-text)] transition-colors hover:bg-[var(--create-agent-control-bg-hover)] active:bg-[var(--create-agent-control-bg-pressed)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Users size={12} aria-hidden className="shrink-0 text-[var(--create-agent-control-icon)]" />
        <span className="min-w-0 truncate"><Select.Value /></span>
        <Select.Icon asChild><ChevronDown size={12} className="shrink-0 text-[var(--create-agent-control-icon)]" /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content position="popper" side="bottom" align="end" sideOffset={6} collisionPadding={8}
          className="z-[10010] w-auto min-w-[200px] max-w-[min(320px,var(--radix-select-content-available-width))] rounded-xl border border-[var(--folder-picker-border)] bg-[var(--folder-picker-bg)] p-2">
          <Select.Viewport className="max-h-[min(16rem,var(--radix-select-content-available-height))] overflow-y-auto">
            <Select.Group>
              <Select.Label className="px-3 py-2 text-left text-xs font-normal text-[var(--folder-label)]">{title}</Select.Label>
              {options.map(option => (
                <Select.Item key={option.value} value={option.value} title={option.label}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-[var(--folder-item-name)] outline-none">
                  <span className="min-w-0 truncate"><Select.ItemText>{option.label}</Select.ItemText></span>
                  <Select.ItemIndicator><Check size={16} aria-hidden /></Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Group>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
