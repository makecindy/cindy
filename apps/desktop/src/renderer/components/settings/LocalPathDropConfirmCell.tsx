/**
 * LocalPathDropConfirmCell — 设置 → 个性化里的路径拖拽确认开关。
 * 纯 Renderer 本地偏好(localStorage，默认开启)，切换立即生效，无 IPC。
 */

import { useTranslation } from 'react-i18next';
import { MousePointer2 } from 'lucide-react';

import { SettingsRow } from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';
import { useLocalPathDropConfirmPreference } from '@/hooks/useLocalPathDropConfirmPreference';
import { cn } from '@/lib/utils';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { tipsSettings } from './TipsSection.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

export function LocalPathDropConfirmCell() {
  const { t } = useTranslation();
  const setting = useSettingDefinition(tipsSettings.localPathDropConfirm);
  const { enabled, isCustomized, setEnabled } = useLocalPathDropConfirmPreference();

  return (
    <SettingsRow
      {...setting.anchorProps}
      lead={
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            'bg-[var(--settings-input-bg)]',
          )}
        >
          <MousePointer2 size={18} className="text-[var(--settings-section-title)]" />
        </span>
      }
      title={setting.title}
      hint={setting.description}
      trailing={
        <div className="flex items-center gap-2">
          <DefaultOverrideControls isCustomized={isCustomized} onReset={() => setEnabled(true)} />
          <Switch
            {...setting.controlProps}
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t('settings.localPathDropConfirm.toggleAria')}
          />
        </div>
      }
    />
  );
}
