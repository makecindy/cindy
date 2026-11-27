/**
 * Consent switch for copying the user's Chromium logins into the agent browser.
 * Only meaningful for the standalone external backend.
 */

import { useTranslation } from 'react-i18next';

import { SettingsRow } from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';

interface BrowserRealProfileSubsectionProps {
  enabled: boolean;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
}

export function BrowserRealProfileSubsection({
  enabled,
  pending,
  onToggle,
}: BrowserRealProfileSubsectionProps) {
  const { t } = useTranslation();
  return (
    <SettingsRow
      title={t('settings.computerUse.realProfile.title')}
      hint={t('settings.computerUse.realProfile.description')}
      trailing={
        <Switch
          data-settings-search-action="Copy the user's browser logins into the agent browser"
          checked={enabled}
          disabled={pending}
          onCheckedChange={onToggle}
          aria-label={t('settings.computerUse.realProfile.toggleAria')}
          className="shrink-0"
        />
      }
    />
  );
}
