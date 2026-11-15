import type { ReactNode } from 'react';

import { Switch } from '@/components/ui/switch';
import { SettingsRow } from '@/components/ui/settings-rows';

/** 一行开关:左侧标签 + 说明(+ 可选补充说明行),右侧开关。 */
export function BehaviorRow({
  id,
  'data-setting-id': settingId,
  label,
  hint,
  note,
  checked,
  onCheckedChange,
  ariaLabel,
  disabled,
}: {
  id?: string;
  'data-setting-id': string;
  label: string;
  hint: string;
  note?: ReactNode;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <SettingsRow
      id={id}
      title={label}
      hint={
        <span className="flex flex-col gap-1">
          <span className="whitespace-pre-line">{hint}</span>
          {note}
        </span>
      }
      trailing={
        <Switch data-setting-id={settingId}
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={ariaLabel}
          disabled={disabled}
        />
      }
    />
  );
}
