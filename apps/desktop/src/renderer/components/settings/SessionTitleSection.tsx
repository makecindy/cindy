/**
 * SessionTitleSection — 「自动更新任务标题」开关。
 *
 * 开启后,任务每轮收尾由 main 自动把标题更新成「日期｜类型｜主题」全中文格式,
 * 让侧边栏只看标题就能分辨任务的实质与进度。手动改过的名字永不覆盖
 * (见 maker-ipc/dynamicSessionTitle.ts)。放在设置「个性化」、紧挨「任务自动命名」模型选择；卡片样式沿用设置页开关卡。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useSessionTitleSettings } from '@/hooks/useSessionTitleSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';

export function SessionTitleSection() {
  const { t } = useTranslation();
  const { state, setDynamicTitleEnabled, reset } = useSessionTitleSettings();
  const [saving, setSaving] = useState(false);

  const handleToggle = async (next: boolean) => {
    setSaving(true);
    try {
      await setDynamicTitleEnabled(next);
      toast.success(
        next
          ? t('settings.sessionTitle.enabledToast')
          : t('settings.sessionTitle.disabledToast'),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.sessionTitle.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await reset();
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.defaults.restoreFailed'));
    } finally {
      setSaving(false);
    }
  };

  const disabled = state.loading || saving;

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-xl p-5',
        'bg-[var(--settings-theme-card-bg)]',
        'border border-[var(--settings-theme-card-border)]',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p
          className="text-13 font-medium text-[var(--settings-section-sublabel)]"
          style={{ letterSpacing: '0.12px' }}
        >
          {t('settings.sessionTitle.label')}
        </p>
        <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
          {t('settings.sessionTitle.description')}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <DefaultOverrideControls
          isCustomized={state.isCustomized}
          disabled={disabled}
          onReset={handleReset}
        />
        <Switch
          checked={state.dynamicTitleEnabled}
          disabled={disabled}
          onCheckedChange={handleToggle}
          aria-label={t('settings.sessionTitle.label')}
        />
      </div>
    </div>
  );
}
