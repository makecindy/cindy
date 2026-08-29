/**
 * Consent switch for copying the user's Chromium logins into the agent browser.
 * Only meaningful for the standalone external backend.
 */

import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

interface BrowserRealProfileSubsectionProps {
  enabled: boolean;
  pending: boolean;
  available: boolean;
  onToggle: (enabled: boolean) => void;
}

export function BrowserRealProfileSubsection({
  enabled,
  pending,
  available,
  onToggle,
}: BrowserRealProfileSubsectionProps) {
  const { t } = useTranslation();
  // Embedded backend cannot copy logins, but an already-on switch must stay
  // revocable so the Cindy-real copy can still be deleted.
  const disabled = pending || (!available && !enabled);
  return (
    <div className="border-t border-[var(--settings-theme-card-border)]">
      <div className="flex items-start justify-between gap-3 px-4 py-[14px]">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-12 font-medium leading-[1.4] text-[var(--settings-section-title)]">
            {t('settings.computerUse.realProfile.title')}
          </p>
          <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
            {available
              ? t('settings.computerUse.realProfile.description')
              : t('settings.computerUse.realProfile.unavailableEmbedded')}
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onToggle}
          aria-label={t('settings.computerUse.realProfile.toggleAria')}
          className={cn('mt-0.5 shrink-0', !available && !enabled && 'opacity-50')}
        />
      </div>
    </div>
  );
}
