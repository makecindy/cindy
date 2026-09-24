import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AriaAttributes, ReactNode } from 'react';
import { Button } from './button';

export interface SelectProps {
  id?: string;
  label: string;
  value: string;
  options: ReadonlyArray<{
    value: string;
    label: string;
    disabled?: boolean;
    title?: string;
    endAdornment?: ReactNode;
  }>;
  /** Optional non-interactive status indicators, kept outside the searchable label. */
  triggerAdornment?: ReactNode;
  /** Compact pickers can ellipsize labels; ordinary form fields retain wrapping. */
  truncateOptions?: boolean;
  onValueChange(value: string): void;
  onOpenChange?(open: boolean): void;
  disabled?: boolean;
  className?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  'aria-required'?: AriaAttributes['aria-required'];
  error?: boolean;
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
  triggerAdornment,
  truncateOptions = false,
  onValueChange,
  onOpenChange,
  disabled,
  className,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  'aria-required': required,
  error = false,
}: SelectProps) {
  const selected = options.find((option) => option.value === value);
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      onOpenChange={onOpenChange}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger asChild>
        <Button
          pressFeedback={false}
          id={id}
          variant="secondary"
          size="lg"
          aria-label={label}
          aria-describedby={describedBy}
          aria-invalid={error ? true : invalid}
          aria-required={required}
          title={selected?.title ?? selected?.label}
          className={cn(
            'min-w-0 max-w-full justify-between gap-2 px-3 font-normal [-webkit-app-region:no-drag]',
            className,
            (error || (invalid !== undefined && invalid !== false && invalid !== 'false')) &&
              '[--button-face-border:var(--error-border)] focus-visible:[--button-face-border:var(--error-fg)] focus-visible:ring-[var(--error-fg)]',
          )}
        >
          <span className={cn('min-w-0 truncate text-left', triggerAdornment && 'flex-1')}>
            <SelectPrimitive.Value placeholder={label} />
          </span>
          {triggerAdornment}
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
                title={option.title ?? (truncateOptions ? option.label : undefined)}
                className="relative flex min-h-8 cursor-pointer select-none items-center rounded-lg py-1 pl-2 pr-6 outline-none [overflow-wrap:anywhere] data-[state=checked]:bg-[var(--surface-chip)] data-[highlighted]:bg-[var(--surface-hover)] data-[disabled]:opacity-60"
              >
                {truncateOptions ? (
                  <span className="min-w-0 flex-1 truncate">
                    <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  </span>
                ) : <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>}
                {option.endAdornment ? (
                  <span className="ml-2 flex shrink-0 items-center gap-1.5">{option.endAdornment}</span>
                ) : null}
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
