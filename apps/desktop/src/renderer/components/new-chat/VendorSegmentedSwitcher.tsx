import { SegmentedControl } from '@/components/ui/segmented-control';
import type { MakerVendor } from '@/lib/ccAgent.types';

import { AGENT_OPTIONS } from './agentOptions';

/** Agent identity adapter; selection visuals and keyboard handling belong to SegmentedControl. */
export function VendorSegmentedSwitcher({
  value,
  onChange,
  disabled,
  className,
  width = 300,
  dense = false,
  ariaLabel = 'Vendor switcher',
}: {
  value: MakerVendor;
  onChange: (next: MakerVendor) => void;
  disabled?: boolean;
  className?: string;
  width?: number;
  dense?: boolean;
  ariaLabel?: string;
}) {
  return (
    <SegmentedControl
      role="tablist"
      aria-label={ariaLabel}
      value={value}
      onValueChange={(next) => {
        if (next !== value) onChange(next);
      }}
      disabled={disabled}
      className={className}
      fullWidth
      style={{ width }}
      height={dense ? 30 : 36}
      optionHeight={dense ? 24 : 30}
      optionClassName={dense ? 'text-12 px-0' : 'text-14 px-0'}
      preserveMouseFocus
      options={AGENT_OPTIONS.map((option) => ({
        value: option.vendor,
        title: option.label,
        'aria-label': option.label,
        label: (
          <>
            <option.Mark size={dense ? 13 : 14} className="shrink-0" />
            <span className="translate-y-[0.5px] whitespace-nowrap">{option.label}</span>
          </>
        ),
      }))}
    />
  );
}
