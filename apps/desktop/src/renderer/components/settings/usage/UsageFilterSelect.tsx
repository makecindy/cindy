/**
 * UsageFilterSelect — 用量页的胶囊下拉(时间范围、使用方、组内电脑)。外观与设置 → 用量的时间范围、
 * 设备选择器一致(usage-history-charts.md「设备范围」)：36px 胶囊触发器，面板与触发器等宽，长名称截断，
 * 选项下方的说明 12px tertiary、在面板内换行。
 */

import React from 'react';
import { SelectParts as Select } from '@/components/ui/select';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface UsageFilterOption {
  value: string;
  label: string;
  /** 选项下方的一行说明。 */
  detail?: string | null;
}

const itemClassName =
  'flex w-full cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-13 text-[var(--text-primary)] outline-none data-[state=checked]:font-medium data-[state=checked]:text-[var(--settings-menu-text-selected)] data-[disabled]:cursor-default data-[disabled]:opacity-50';

export function UsageFilterSelect({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled = false,
  className,
}: {
  value: string;
  options: readonly UsageFilterOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** 触发器宽度；缺省与设置 → 用量的时间范围选择器同宽(190px)。 */
  className?: string;
}): React.JSX.Element {
  return (
    <Select.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <Select.Trigger
        aria-label={ariaLabel}
        className={cn(
          'flex h-9 w-[190px] max-w-full items-center justify-between gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:cursor-default disabled:opacity-50',
          className,
        )}
      >
        <span className="min-w-0 truncate">
          <Select.Value />
        </span>
        <Select.Icon asChild>
          <ChevronDown size={15} className="shrink-0 text-[var(--text-tertiary)]" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          side="bottom"
          align="end"
          sideOffset={4}
          className="z-[10010] max-h-[var(--radix-select-content-available-height)] w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5"
        >
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item key={option.value} value={option.value} className={itemClassName}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    <Select.ItemText>{option.label}</Select.ItemText>
                  </span>
                  {option.detail ? (
                    <span className="whitespace-normal break-words text-12 font-normal text-[var(--text-tertiary)]">
                      {option.detail}
                    </span>
                  ) : null}
                </span>
                <Select.ItemIndicator>
                  <Check size={14} strokeWidth={2.25} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
