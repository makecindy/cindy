import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export interface SelectProps {
  id?: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
  onValueChange(value: string): void;
  onOpenChange?(open: boolean): void;
  disabled?: boolean;
  className?: string;
  'aria-describedby'?: string;
}

/** Desktop single-value field (DESIGN.md §4): standard secondary Button,
 * equal-width Radix panel, 12px container / 8px rows and semantic theme colors.
 * Use with FormField for a visible label; className sizes the trigger only.
 */
export function Select({
  id,
  label,
  value,
  options,
  onValueChange,
  onOpenChange,
  disabled,
  className,
  'aria-describedby': describedBy,
}: SelectProps) {
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      onOpenChange={onOpenChange}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger asChild>
        <Button
          id={id}
          variant="secondary"
          size="lg"
          aria-label={label}
          aria-describedby={describedBy}
          title={options.find((option) => option.value === value)?.label}
          className={cn(
            'min-w-0 max-w-full justify-between gap-2 px-3 font-normal [-webkit-app-region:no-drag]',
            className,
          )}
        >
          <span className="min-w-0 truncate text-left">
            <SelectPrimitive.Value placeholder={label} />
          </span>
          <SelectPrimitive.Icon asChild>
            <ChevronDown size={14} className="shrink-0" aria-hidden="true" />
          </SelectPrimitive.Icon>
        </Button>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-[10010] w-[var(--radix-select-trigger-width)] max-h-[var(--radix-select-content-available-height)] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5 text-13 text-[var(--text-primary)] [-webkit-app-region:no-drag]"
        >
          <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center">
            <ChevronUp size={14} aria-hidden="true" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="max-h-64 min-w-0">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="relative flex min-h-8 cursor-pointer select-none items-center rounded-lg py-1 pl-2 pr-6 outline-none [overflow-wrap:anywhere] data-[state=checked]:bg-[var(--surface-chip)] data-[highlighted]:bg-[var(--surface-hover)] data-[disabled]:opacity-60"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-1 flex">
                  <Check size={14} aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center">
            <ChevronDown size={14} aria-hidden="true" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
