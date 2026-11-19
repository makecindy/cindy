import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { refreshBotProfiles } from './botStore';

/** Safe read recovery shared by the sidebar and the buddy landing page. */
export function BotRosterLoadError() {
  const { t } = useTranslation();
  return (
    <ErrorNotice
      role="alert"
      message={t('bots.rosterLoadFailed')}
      actions={
        <Button size="sm" compact variant="secondary" onClick={refreshBotProfiles}>
          {t('bots.rosterReload')}
        </Button>
      }
    />
  );
}
