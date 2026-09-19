import { useTranslation } from 'react-i18next';
import { type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import { useDesktopCompanionSettings } from '@/hooks/useDesktopCompanionSettings';

export function DesktopCompanionSection() {
  const { t } = useTranslation();
  const { snapshot, previewDataUrl, setEnabled, setLocationEnabled, refresh } =
    useDesktopCompanionSettings();

  if (!snapshot.supported) return null;

  const errorText = errorMessage(snapshot.lastError, t);

  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.agentIsland.desktopCompanion.title')}
      </h2>

      <SettingsCard className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-13 font-medium text-[var(--settings-section-sublabel)]">
            {t('settings.agentIsland.desktopCompanion.enableLabel')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.agentIsland.desktopCompanion.enableHint')}
          </p>
        </div>
        <Switch
          checked={snapshot.enabled}
          onCheckedChange={(checked) => void setEnabled(checked)}
          aria-label={t('settings.agentIsland.desktopCompanion.enableAria')}
        />
      </SettingsCard>

      {snapshot.enabled && (
        <>
          <SettingsCard className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-13 font-medium text-[var(--settings-section-sublabel)]">
                {t('settings.agentIsland.desktopCompanion.locationLabel')}
              </p>
              <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                {t('settings.agentIsland.desktopCompanion.locationHint')}
              </p>
            </div>
            <Switch
              checked={snapshot.locationEnabled}
              onCheckedChange={(checked) => void setLocationEnabled(checked)}
              aria-label={t('settings.agentIsland.desktopCompanion.locationAria')}
            />
          </SettingsCard>

          <SettingsCard className="flex flex-col gap-3">
            {previewDataUrl ? (
              <img
                src={previewDataUrl}
                alt={t('settings.agentIsland.desktopCompanion.previewAlt')}
                className="h-24 w-full rounded-lg object-cover"
              />
            ) : null}
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {snapshot.lastTopic
                ? t('settings.agentIsland.desktopCompanion.lastTopic', { topic: snapshot.lastTopic })
                : t('settings.agentIsland.desktopCompanion.empty')}
            </p>
            {errorText ? (
              <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)]">{errorText}</p>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              className="self-start"
              disabled={snapshot.status === 'generating'}
              onClick={() => void refresh()}
            >
              {snapshot.status === 'generating'
                ? t('settings.agentIsland.desktopCompanion.updating')
                : t('settings.agentIsland.desktopCompanion.updateNow')}
            </Button>
          </SettingsCard>
        </>
      )}
    </div>
  );
}

function errorMessage(
  code: string | null,
  t: (key: string) => string,
): string | null {
  if (!code) return null;
  if (code === 'NO_IMAGE_MODEL') return t('settings.agentIsland.desktopCompanion.needImageModel');
  if (code === 'NO_VIDEO_MODEL') return t('settings.agentIsland.desktopCompanion.needVideoModel');
  return t('settings.agentIsland.desktopCompanion.failed');
}

function SettingsCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-xl p-5',
        'bg-[var(--settings-theme-card-bg)]',
        'border border-[var(--settings-theme-card-border)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
