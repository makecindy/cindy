import { additionalSettings } from './AdditionalSettings.settings-search';
import { useSettingDefinition } from './useSettingDefinition';
import { Button } from '@/components/ui/button';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { SettingsRow } from '@/components/ui/settings-rows';

/** 正式版布局恢复入口：复用 main 的原子 reset + broadcast，不另存 renderer 状态。 */
export function LayoutResetControl() {
  const setting = useSettingDefinition(additionalSettings.layout);
  const { t } = useTranslation();
  const [resetting, setResetting] = useState(false);

  const handleReset = async (): Promise<void> => {
    if (resetting) return;
    setResetting(true);
    try {
      const result = await window.electronAPI.layout.reset();
      if (result.persisted) {
        toast.success(t('settings.appearance.layout.resetSuccess'));
      } else {
        toast.error(t('settings.appearance.layout.resetFailed'));
      }
    } catch {
      toast.error(t('settings.appearance.layout.resetFailed'));
    } finally {
      setResetting(false);
    }
  };

  return (
    <SettingsRow
      {...setting.anchorProps}
      title={setting.title}
      hint={setting.description}
      trailing={
        <Button
          {...setting.controlProps}
          variant="secondary"
          size="md"
          compact
          loading={resetting}
          type="button"
          onClick={() => void handleReset()}
          disabled={resetting}
          aria-label={t('settings.appearance.layout.reset')}
          className="shrink-0"
        >
          <RotateCcw size={14} aria-hidden />
          {t('settings.appearance.layout.reset')}
        </Button>
      }
    />
  );
}
