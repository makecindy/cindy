import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

export function ImLifecycleAnnouncementSection(props: {
  label: string;
  cellLabel: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (enabled: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className="select-none text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {props.label}
      </h2>

      <div
        className={cn(
          'flex items-center justify-between gap-3 rounded-xl p-5',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex min-w-0 select-none flex-col gap-1">
          <p
            className="text-13 font-medium text-[var(--settings-section-sublabel)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {props.cellLabel}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {props.hint}
          </p>
        </div>

        <Switch
          checked={props.checked}
          onCheckedChange={props.onCheckedChange}
          disabled={props.disabled}
          aria-label={props.label}
        />
      </div>
    </div>
  );
}
