import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { useFeishuBot } from '@/hooks/useFeishuBot';

export function FeishuBotNotificationSection() {
  const {
    hasSavedCreds,
    lifecycleAnnouncement,
    setLifecycleAnnouncement,
  } = useFeishuBot();
  const { t } = useTranslation();

  if (!hasSavedCreds) return null;

  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.feishuBot.lifecycleAnnouncement.label')}
      </h2>

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
            {t('settings.feishuBot.lifecycleAnnouncement.cellLabel')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.feishuBot.lifecycleAnnouncement.hint')}
          </p>
        </div>

        <Switch
          checked={lifecycleAnnouncement}
          onCheckedChange={setLifecycleAnnouncement}
          aria-label={t('settings.feishuBot.lifecycleAnnouncement.label')}
        />
      </div>
    </div>
  );
}
