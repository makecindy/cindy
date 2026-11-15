/**
 * MessageNavRailCell — TipsSection 内的 "显示提问导航条" cell row。
 * 纯 Renderer 本地偏好(localStorage,默认开启),切换立即生效,无 IPC。
 * 行内形态与 SilentEncryptedRetryCell 对齐;恢复默认走 DefaultOverrideControls
 * (语义 = 清 override 跟随版本默认,见 useMessageNavRailPreference)。
 */

import { additionalSettings } from './AdditionalSettings.settings-search';
import { useSettingDefinition } from './useSettingDefinition';
import { useTranslation } from 'react-i18next';
import { ListOrdered } from 'lucide-react';

import { SettingsRow } from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';
import { useMessageNavRailPreference } from '@/hooks/useMessageNavRailPreference';
import { cn } from '@/lib/utils';
import { DefaultOverrideControls } from './DefaultOverrideControls';

export function MessageNavRailCell() {
  const setting = useSettingDefinition(additionalSettings.messageNavRail);
  const { t } = useTranslation();
  const { enabled, isCustomized, setEnabled } = useMessageNavRailPreference();

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
          <ListOrdered size={18} className="text-[var(--settings-section-title)]" />
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
            aria-label={t('settings.messageNavRail.toggleAria')}
          />
        </div>
      }
    />
  );
}
