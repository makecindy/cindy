import { forwardRef, type ReactNode, type ComponentPropsWithoutRef } from 'react';

/** Presentational row shared by local providers and explicit cloud authorization. */
type Props = Omit<ComponentPropsWithoutRef<'button'>, 'title' | 'onSelect'> & {
  title: string;
  icon: ReactNode;
  selected: boolean;
  onSelect(): void;
  muted?: boolean;
  annotation?: ReactNode;
  statusColor: string;
};
export const ProviderListEntry = forwardRef<HTMLButtonElement, Props>(function ProviderListEntry(
  {
    title,
    icon,
    selected,
    onSelect,
    onDoubleClick,
    disabled,
    muted,
    annotation,
    statusColor,
    ...buttonProps
  },
  ref,
) {
  return (
    <button data-settings-search-action="Select the provider whose details are displayed"
      {...buttonProps}
      ref={ref}
      type="button"
      onClick={(event) => {
        buttonProps.onClick?.(event);
        if (!event.defaultPrevented) onSelect();
      }}
      onDoubleClick={onDoubleClick}
      disabled={disabled}
      aria-current={selected}
      className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 pr-2.5 text-left"
    >
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{
          backgroundColor: 'var(--settings-integration-avatar-bg)',
          border: '1px solid var(--settings-integration-avatar-border)',
          color: 'var(--settings-integration-avatar-icon)',
        }}
      >
        {icon}
      </div>
      <span
        className="min-w-0 flex-1 truncate text-13 font-medium"
        style={{
          color: muted ? 'var(--text-tertiary)' : 'var(--settings-section-title)',
        }}
      >
        {title}
      </span>
      {annotation}
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          backgroundColor: statusColor,
        }}
      />
    </button>
  );
});
