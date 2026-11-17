/**
 * WorktreeModelNamingCell — TipsSection 内的「用模型给 worktree 取名」cell row。
 * 纯 Renderer 本地偏好（localStorage，默认关闭），只影响之后新建的 worktree，无 IPC。
 * 行内形态与 MessageNavRailCell 对齐；恢复默认走 DefaultOverrideControls
 * （语义 = 清 override 跟随版本默认，见 useWorktreeModelNamingPreference）。
 */

import { additionalSettings } from './AdditionalSettings.settings-search';
import { useSettingDefinition } from './useSettingDefinition';
import { useTranslation } from 'react-i18next';
import { GitBranch } from 'lucide-react';

import { SettingsRow } from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';
import { useWorktreeModelNamingPreference } from '@/hooks/useWorktreeModelNamingPreference';
import { cn } from '@/lib/utils';
import { DefaultOverrideControls } from './DefaultOverrideControls';

export function WorktreeModelNamingCell() {
  const setting = useSettingDefinition(additionalSettings.worktreeModelNaming);
  const { t } = useTranslation();
  const { enabled, isCustomized, setEnabled } = useWorktreeModelNamingPreference();

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
          <GitBranch size={18} className="text-[var(--settings-section-title)]" />
        </span>
      }
      title={setting.title}
      hint={setting.description}
      trailing={
        <div className="flex items-center gap-2">
          <DefaultOverrideControls isCustomized={isCustomized} onReset={() => setEnabled(false)} />
          <Switch
            {...setting.controlProps}
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t('settings.worktreeModelNaming.toggleAria')}
          />
        </div>
      }
    />
  );
}
