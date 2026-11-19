/**
 * Settings → General → Get-started guide: reopen the guide that is shown once after the first
 * sign-in on this computer (docs/product-rules/first-run-guide.md). Opened by hand it offers
 * every step, whatever was detected.
 */
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { SettingsRow } from '@/components/ui/settings-rows';
import { openFirstRunGuide } from '@/features/first-run-guide/firstRunGuideStore';

export function FirstRunGuideSection() {
  const { t } = useTranslation();
  return (
    <SettingsRow
      title={t('firstRunGuide.settings.title')}
      hint={t('firstRunGuide.settings.description')}
      wrap
      trailing={
        <Button
          data-settings-search-action="Reopen the get-started guide"
          variant="secondary"
          size="md"
          className="shrink-0"
          onClick={() => openFirstRunGuide({ manual: true, migration: false, legacyMigrated: false })}
        >
          {t('firstRunGuide.settings.open')}
        </Button>
      }
    />
  );
}
