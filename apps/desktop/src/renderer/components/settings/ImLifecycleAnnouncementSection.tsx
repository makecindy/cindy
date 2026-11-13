import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';

export function ImLifecycleAnnouncementSection(props: {
  label: string;
  cellLabel: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (enabled: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingsSection title={props.label} className="select-none">
      <SettingsCard>
        <SettingsRow
          title={props.cellLabel}
          hint={props.hint}
          trailing={
            <Switch
              checked={props.checked}
              onCheckedChange={props.onCheckedChange}
              disabled={props.disabled}
              aria-label={props.label}
            />
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
