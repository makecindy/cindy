import { SelectParts as SelectPrimitive } from './select-parts';
export { SelectParts } from './select-parts';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AriaAttributes, ReactNode } from 'react';
import { Button } from './button';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  title?: string;
  /** Secondary line under the label in the open list; the trigger shows the label only. */
  description?: string;
  endAdornment?: ReactNode;
}

export interface SelectProps {
  id?: string;
  'data-setting-id'?: string;
  /** Settings search checker reason, forwarded to the trigger. */
  'data-settings-search-action'?: string;
  label: string;
  /** Displayed when there is no selected option. Defaults to the field label. */
  placeholder?: string;
  value: string;
  options?: ReadonlyArray<SelectOption>;
  /** Labelled option groups (e.g. commands / keys); use instead of options. */
  groups?: ReadonlyArray<{ label?: string; options: ReadonlyArray<SelectOption> }>;
  /** Optional non-interactive status indicators, kept outside the searchable label. */
  triggerAdornment?: ReactNode;
  /** Compact pickers can ellipsize labels; ordinary form fields retain wrapping. */
  truncateOptions?: boolean;
  onValueChange(value: string): void;
  onOpenChange?(open: boolean): void;
  disabled?: boolean;
  className?: string;
  /** Size a compact trigger's menu independently; ordinary fields keep equal width. */
  contentClassName?: string;
  /**
   * Trigger height: default 36px; compact 32px for narrow drawers and dense lists; inline
   * 24px, frameless and in the surrounding text colour, for a value that sits inside a line
   * of text (plugin UI slots, provider run location, Cindy device picker). DESIGN.md §4.
   */
  size?: 'default' | 'compact' | 'inline';
  /**
   * Trigger width preset: 220px / 320px, full width for stacked fields, or 120px (`xs`) for a
   * short value paired inline with another control (DESIGN.md §4 Desktop settings controls).
   * Settings use a preset; className is for layout (shrink / flex), not ad-hoc widths or heights.
   */
  width?: 'xs' | 'sm' | 'md' | 'full';
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  'aria-required'?: AriaAttributes['aria-required'];
  error?: boolean;
}

/** Width presets, also for SelectParts triggers that compose their own rows. */
export const SELECT_WIDTHS = { xs: 'w-[120px]', sm: 'w-[220px]', md: 'w-[320px]', full: 'w-full' } as const;

const SELECT_BUTTON_SIZES = { default: 'lg', compact: 'md', inline: 'xs' } as const;

/** Inline trigger: fits its value, no frame or fill at rest, surrounding text colour;
 * the secondary hover/pressed fill and focus ring still mark it as a control. */
const SELECT_INLINE_TRIGGER =
  'w-fit gap-1 px-1.5 text-inherit [--button-face-bg:transparent] [--button-face-border:transparent]';

/** An inline trigger is only as wide as its value, so its list fits the options instead:
 * at least the trigger width, at most 18rem and the space available. */
const SELECT_INLINE_CONTENT =
  'w-max min-w-[var(--radix-select-trigger-width)] max-w-[min(18rem,var(--radix-select-content-available-width))]';

/** Desktop single-value field (DESIGN.md §4): standard secondary Button,
 * equal-width Radix panel, 12px container / 8px rows and semantic theme colors.
 * Use with FormField for a visible label; className sizes the trigger only.
 */
export function Select({
  id,
  'data-setting-id': settingId,
  'data-settings-search-action': searchAction,
  label,
  placeholder = label,
  value,
  options,
  groups,
  triggerAdornment,
  truncateOptions = false,
  onValueChange,
  onOpenChange,
  disabled,
  className,
  contentClassName,
  size = 'default',
  width,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  'aria-required': required,
  error = false,
}: SelectProps) {
  const allOptions = groups ? groups.flatMap((group) => group.options) : options ?? [];
  const selected = allOptions.find((option) => option.value === value);
  const renderItem = (option: SelectOption) => (
    <SelectPrimitive.Item
      key={option.value}
      value={option.value}
      disabled={option.disabled}
      title={option.title ?? (truncateOptions ? option.label : undefined)}
      className="relative flex min-h-8 cursor-pointer select-none items-center rounded-lg py-1 pl-2 pr-6 outline-none [overflow-wrap:anywhere] data-[disabled]:opacity-60"
    >
      {option.description ? (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
          <span className={cn(truncateOptions && 'truncate')}>
            <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
          </span>
          <span className="text-12 leading-[1.4] text-[var(--text-secondary)]">{option.description}</span>
        </span>
      ) : truncateOptions ? (
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
  );
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
          data-setting-id={settingId}
          data-settings-search-action={searchAction}
          variant="secondary"
          size={SELECT_BUTTON_SIZES[size]}
          aria-label={label}
          aria-describedby={describedBy}
          aria-invalid={error ? true : invalid}
          aria-required={required}
          title={selected?.title ?? selected?.label ?? (placeholder !== label ? placeholder : undefined)}
          className={cn(
            'min-w-0 max-w-full justify-between gap-2 px-3 font-normal [-webkit-app-region:no-drag]',
            size === 'inline' && SELECT_INLINE_TRIGGER,
            width && SELECT_WIDTHS[width],
            className,
            (error || (invalid !== undefined && invalid !== false && invalid !== 'false')) &&
              '[--button-face-border:var(--error-border)] focus-visible:[--button-face-border:var(--error-fg)] focus-visible:ring-[var(--error-fg)]',
          )}
        >
          <span className={cn('min-w-0 truncate text-left', triggerAdornment && 'flex-1')}>
            <SelectPrimitive.Value placeholder={placeholder} />
          </span>
          {triggerAdornment}
          <SelectPrimitive.Icon asChild>
            <ChevronDown size={size === 'inline' ? 12 : 14} className="shrink-0" aria-hidden="true" />
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
          className={cn(
            'z-dropdown w-[var(--radix-select-trigger-width)] max-h-[var(--radix-select-content-available-height)] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5 text-13 text-[var(--text-primary)] [-webkit-app-region:no-drag]',
            size === 'inline' && SELECT_INLINE_CONTENT,
            contentClassName,
          )}
        >
          <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center">
            <ChevronUp size={14} aria-hidden="true" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="max-h-64 min-w-0">
            {groups
              ? groups.map((group, index) => (
                <SelectPrimitive.Group key={group.label ?? `group-${index}`}>
                  {group.label ? (
                    <SelectPrimitive.Label className="px-2 pb-1 pt-2 text-12 font-medium text-[var(--text-tertiary)]">
                      {group.label}
                    </SelectPrimitive.Label>
                  ) : null}
                  {group.options.map(renderItem)}
                </SelectPrimitive.Group>
              ))
              : allOptions.map(renderItem)}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center">
            <ChevronDown size={14} aria-hidden="true" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
